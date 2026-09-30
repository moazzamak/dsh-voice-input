/**
 * Host half of `dsh-voice-input`.
 *
 * Owns one exact POST route on the composition's `webServer`. The browser half
 * records microphone audio and posts the raw bytes here; this half stages them
 * to disk, runs the bundled faster-whisper CLI as a child process, and answers
 * with the recognized text.
 *
 * Security has one home, here. Every request first asks the composition's
 * `connection` service for a rejection (`requestRejection`): its Host/Origin
 * fence defeats DNS rebinding and cross-site calls, so only the page this
 * harness serves can reach the route. Where a composition provides no such
 * fence the route still answers only on the harness's own bound socket. On top
 * of that fence the handler validates method, byte ceiling, and body length at
 * the wire.
 *
 * The engine is local and offline: audio leaves the browser, crosses this
 * process, and is decoded on this machine. Nothing is uploaded.
 *
 * Plain JavaScript on purpose: a published bundle that needs no build step also
 * needs no `prepare` script, so a direct git install works.
 *
 * @module dsh-voice-input
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis function-plugin name. */
export const name = 'voice-input'

/**
 * The route carrier and the process seam the engine runs through.
 *
 * The composition's `connection` trust fence is deliberately absent here and
 * consumed through `ctx.get('connection')` instead: it is optional
 * infrastructure, and a hard dependency on a service a given composition does
 * not provide would park this row forever instead of transcribing.
 */
export const inject = ['webServer', 'shell']

/** Exact path the browser half posts recordings to. */
export const VOICE_INPUT_ROUTE = '/voice-input/transcribe'

/** This package's own install directory, so bundled assets need no configuration. */
const ASSET_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * Raw recordings are bounded well below the engine's own ceiling: `webm/opus`
 * speech runs about 32 kbit/s, so 24 MiB is already hours of audio, and
 * anything larger is a bug or an attack rather than a voice instruction.
 */
const MAX_BODY_BYTES = 24 * 1024 * 1024

/** CTranslate2 compute types this plugin accepts for CPU decoding. */
const COMPUTE_TYPES = ['int8', 'int8_float32', 'float32']

/**
 * Voice-input host configuration. Every path defaults to what
 * `python/setup.py` provisions inside this package, so the common case needs no
 * configuration at all; each field exists for a user who keeps the engine
 * somewhere else.
 *
 * @typedef {object} VoiceInputConfig
 * @property {string} [pythonPath] Interpreter that has `faster-whisper` installed.
 * @property {string} [scriptPath] The transcription CLI.
 * @property {string} [cacheDir] Model weights cache shared with the CLI.
 * @property {string} model Whisper model size or name.
 * @property {string} language Spoken language code, or `auto` to detect it.
 * @property {string} computeType CTranslate2 compute type.
 * @property {number} timeoutMs Deadline for one transcription, in milliseconds.
 */

/**
 * Standard Schema for the host configuration.
 *
 * Hand-written rather than imported: this bundle installs outside the harness
 * tree, so it has no resolvable `@deepseek-ai/schemastery` to depend on, while
 * the loader only requires the Standard Schema protocol. Unknown keys are kept
 * (users add their own), and every enumerated field falls back to its documented
 * default instead of rejecting the boot.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-voice-input',
    /**
     * Validate and default one raw config object.
     * @param {unknown} value - the row's `config` value.
     * @returns `{ value }` when valid, `{ issues }` otherwise.
     */
    validate(value) {
      if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
        return { issues: [{ message: 'voice-input config must be an object' }] }
      }
      const input = value ?? {}
      const issues = []
      const text = (key, fallback) => {
        const raw = input[key]
        if (raw === undefined) return fallback
        if (typeof raw !== 'string' || raw === '') {
          issues.push({ message: `${key} must be a non-empty string` })
          return fallback
        }
        return raw
      }
      const rawTimeout = input.timeoutMs
      let timeoutMs = 300_000
      if (rawTimeout !== undefined) {
        if (typeof rawTimeout !== 'number' || !Number.isInteger(rawTimeout) || rawTimeout < 1_000 || rawTimeout > 3_600_000) {
          issues.push({ message: 'timeoutMs must be an integer between 1000 and 3600000' })
        } else {
          timeoutMs = rawTimeout
        }
      }
      const model = text('model', 'base.en')
      const language = text('language', 'en')
      const computeType = text('computeType', 'int8')
      if (!COMPUTE_TYPES.includes(computeType)) {
        issues.push({ message: `computeType must be one of ${COMPUTE_TYPES.join(', ')}` })
      }
      if (issues.length > 0) return { issues }
      return { value: { ...input, model, language, computeType, timeoutMs } }
    },
  },
}

/**
 * Write one JSON response. `no-store` because a transcript is produced once and
 * never reused.
 * @param {object} res - the Node response.
 * @param {number} status - HTTP status.
 * @param {unknown} payload - JSON-serializable body.
 */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * Collect a bounded request body as raw bytes.
 * @param {AsyncIterable<Buffer> & { resume(): void }} req - the request stream.
 * @returns {Promise<Buffer | null>} the body, or null past the ceiling (stream drained).
 */
async function readBoundedBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      // Drain the remainder so the refusal is a readable response, not a socket cut.
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

/**
 * The last complete JSON line of engine stdout.
 * @param {string} stdout - the child process's standard output.
 * @returns {object | null} the parsed result, or null when there is none.
 */
function parseEngineResult(stdout) {
  const trimmed = stdout.trim()
  if (trimmed === '') return null
  const breakAt = trimmed.lastIndexOf('\n')
  try {
    const parsed = JSON.parse(breakAt === -1 ? trimmed : trimmed.slice(breakAt + 1))
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    // Swallows the parse error: an unreadable line is exactly the null case.
    return null
  }
}

/**
 * One-line excerpt of engine diagnostics, bounded for a JSON error field.
 * @param {string} text - raw diagnostics.
 * @param {number} [max] - character ceiling.
 * @returns {string} the flattened excerpt.
 */
function excerpt(text, max = 600) {
  const flat = text.trim().replace(/\s+/g, ' ')
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** The user's DSH home, matching where the harness keeps its own caches. */
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Windows virtualenv layout differs from POSIX; pick the interpreter that exists. */
function defaultPythonPath() {
  return process.platform === 'win32'
    ? join(ASSET_DIR, '.venv', 'Scripts', 'python.exe')
    : join(ASSET_DIR, '.venv', 'bin', 'python')
}

/**
 * Quote one argument for the composition's shell.
 *
 * The `shell` service executes a command STRING through whatever interpreter a
 * composition selected — `pwsh -Command` on Windows, `bash -c` elsewhere — so
 * the string is parsed, not split by us. Windows arguments additionally need
 * `cmd /c` because PowerShell does not treat a quoted path in command position
 * as an executable; the engine path is substituted into the quote so the
 * command stays valid.
 *
 * @param {string} value - one argument.
 * @returns {string} the argument wrapped in double quotes.
 */
function quote(value) {
  return `"${value}"`
}

/**
 * Build the engine command line for one recording.
 * @param {object} paths - interpreter, script, audio file, and cache paths.
 * @param {VoiceInputConfig} config - validated host configuration.
 * @returns {string} the command string handed to `shell.resolve`.
 */
function engineCommand(paths, config) {
  const invocation = [
    quote(paths.pythonPath),
    quote(paths.scriptPath),
    '--audio', quote(paths.audioPath),
    '--model', config.model,
    '--language', config.language,
    '--compute-type', config.computeType,
    '--cache-dir', quote(paths.cacheDir),
  ].join(' ')
  return process.platform === 'win32' ? `cmd /c ${invocation}` : invocation
}

/**
 * Register the transcription route.
 * @param {unknown} ctx - the plugin context (declared injections resolved).
 * @param {VoiceInputConfig} config - validated host configuration.
 */
export function apply(ctx, config) {
  const pythonPath = config.pythonPath ?? defaultPythonPath()
  const scriptPath = config.scriptPath ?? join(ASSET_DIR, 'python', 'transcribe.py')
  const cacheDir = config.cacheDir ?? join(dshHome(), 'cache', 'voice-models')

  /** The composition's browser-trust fence, when this composition provides one. */
  const connection = ctx.get('connection')

  /**
   * Answer an untrusted request.
   * @param {unknown} req - the Node request.
   * @param {unknown} res - the Node response.
   * @returns {boolean} true when the request was rejected and the response ended.
   */
  const rejected = (req, res) => {
    if (connection === undefined) return false
    const rejection = connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  /**
   * Transcribe one staged recording, or report why it could not be.
   * @param {Buffer} bytes - raw recorded audio.
   * @returns {Promise<{ ok: true, text: string } | { ok: false, error: string }>}
   */
  const transcribe = async (bytes) => {
    const runId = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
    // Staged under the OS temp root by THIS process, which is not confined. The
    // engine then only ever reads: a confined shell may refuse writes anywhere
    // outside the session workspace, so the decode happens on the host side
    // rather than inside the child.
    const runDir = join(tmpdir(), 'dsh-voice-input', `run-${runId}`)
    const audioPath = join(runDir, 'audio.webm')

    try {
      await mkdir(runDir, { recursive: true })
      await writeFile(audioPath, bytes)
    } catch (error) {
      return { ok: false, error: `could not stage the recording: ${String(error)}` }
    }

    const command = engineCommand({ pythonPath, scriptPath, audioPath, cacheDir }, config)

    let spec
    try {
      spec = ctx.shell.resolve({ command, timeoutMs: config.timeoutMs })
    } catch (error) {
      return { ok: false, error: `could not prepare the transcription command: ${String(error)}` }
    }

    let run
    try {
      run = await ctx.shell.run(spec)
    } catch (error) {
      return { ok: false, error: `the transcription engine could not start: ${String(error)}` }
    }

    const stdout = run.stdout?.text ?? ''
    const stderr = run.stderr?.text ?? ''
    if (run.exitCode !== 0) {
      const detail = excerpt(stderr.trim() === '' ? stdout : stderr)
      return {
        ok: false,
        error: `the transcription engine exited with code ${String(run.exitCode)}${detail === '' ? '' : `: ${detail}`}`,
      }
    }

    const parsed = parseEngineResult(stdout)
    if (parsed === null) {
      return { ok: false, error: `the transcription engine produced no readable result: ${excerpt(stdout, 300)}` }
    }
    if (parsed.ok !== true) {
      const message = typeof parsed.error === 'string' ? excerpt(parsed.error) : ''
      return { ok: false, error: message === '' ? 'transcription failed' : message }
    }
    if (typeof parsed.text !== 'string' || parsed.text.trim() === '') {
      return { ok: false, error: 'no speech was recognized in that recording' }
    }
    return { ok: true, text: parsed.text.trim() }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: VOICE_INPUT_ROUTE,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      const bytes = await readBoundedBody(req)
      if (bytes === null) {
        sendJson(res, 413, {
          ok: false,
          error: 'the recording is larger than this route accepts; keep voice instructions under a few minutes',
        })
        return
      }
      if (bytes.byteLength === 0) {
        sendJson(res, 400, { ok: false, error: 'the request carried no audio' })
        return
      }
      const result = await transcribe(bytes)
      sendJson(res, result.ok ? 200 : 502, result)
    },
  }))
}

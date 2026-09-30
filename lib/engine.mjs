/**
 * The local transcription engine, shared by this package's two host halves.
 *
 * Both the browser route (`route.mjs`) and the model-facing tool (`index.mjs`)
 * call the same bundled faster-whisper CLI with the same configuration. Keeping
 * that in one module is what makes them genuinely one engine rather than two
 * implementations that drift.
 *
 * Plain JavaScript on purpose: a published bundle that needs no build step also
 * needs no `prepare` script, so a direct git install works.
 *
 * @module dsh-voice-input/engine
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * This module's own directory (`lib/`), used by {@link packageRoot}.
 *
 * Paths are resolved from the PACKAGE ROOT, not from this module: the two host
 * rows live in different directories (`index.mjs` at the root, `route.mjs` also
 * at the root, this file under `lib/`), and the engine venv `python/setup.py`
 * creates belongs to the package, not to whichever row is asking.
 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

/** The package's root directory, derived from this module's location. */
export const PACKAGE_ROOT = dirname(MODULE_DIR)

/** Exact path the browser half posts recordings to; `route.mjs` serves it. */
export const VOICE_INPUT_ROUTE = '/voice-input/transcribe'

/** Model-facing tool name; `index.mjs` registers it. */
export const TRANSCRIBE_TOOL_NAME = 'voice_transcribe'

/**
 * Raw recordings are bounded well below the engine's own ceiling: `webm/opus`
 * speech runs about 32 kbit/s, so 24 MiB is already hours of audio, and
 * anything larger is a bug or an attack rather than a voice instruction.
 */
export const MAX_BODY_BYTES = 24 * 1024 * 1024

/** Ceiling for one file the model-facing tool reads. */
export const MAX_TOOL_FILE_BYTES = 200 * 1024 * 1024

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
export function sendJson(res, status, payload) {
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
export async function readBoundedBody(req) {
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
export function parseEngineResult(stdout) {
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
export function excerpt(text, max = 600) {
  const flat = text.trim().replace(/\s+/g, ' ')
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** The user's DSH home, matching where the harness keeps its own caches. */
export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Windows virtualenv layout differs from POSIX; pick the interpreter that exists. */
export function defaultPythonPath() {
  return process.platform === 'win32'
    ? join(PACKAGE_ROOT, '.venv', 'Scripts', 'python.exe')
    : join(PACKAGE_ROOT, '.venv', 'bin', 'python')
}

/** Default model-weights cache, shared with the CLI. */
export function defaultCacheDir() {
  return join(dshHome(), 'cache', 'voice-models')
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
 * Build the engine command line for one audio file.
 * @param {object} paths - interpreter, script, audio file, and cache paths.
 * @param {VoiceInputConfig} config - validated host configuration.
 * @param {{ model?: string, language?: string }} [overrides] - per-call overrides.
 * @returns {string} the command string handed to `shell.resolve`.
 */
export function engineCommand(paths, config, overrides = {}) {
  const invocation = [
    quote(paths.pythonPath),
    quote(paths.scriptPath),
    '--audio', quote(paths.audioPath),
    '--model', overrides.model ?? config.model,
    '--language', overrides.language ?? config.language,
    '--compute-type', config.computeType,
    '--cache-dir', quote(paths.cacheDir),
  ].join(' ')
  return process.platform === 'win32' ? `cmd /c ${invocation}` : invocation
}

/**
 * Build the one function both halves use to run the engine.
 *
 * @param {object} ctx - the plugin context (declared injections resolved).
 * @param {VoiceInputConfig} config - validated host configuration.
 * @returns {(bytes: Buffer, overrides?: { model?: string, language?: string }) => Promise<{ ok: true, text: string } | { ok: false, error: string }>}
 */
export function createTranscriber(ctx, config) {
  const pythonPath = config.pythonPath ?? defaultPythonPath()
  const scriptPath = config.scriptPath ?? join(PACKAGE_ROOT, 'python', 'transcribe.py')
  const cacheDir = config.cacheDir ?? defaultCacheDir()

  return async function transcribe(bytes, overrides = {}) {
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

    const command = engineCommand({ pythonPath, scriptPath, audioPath, cacheDir }, config, overrides)

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
}

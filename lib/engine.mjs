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

/** Polish passes this plugin implements. `off` returns the recognizer's own text. */
const POLISH_MODES = ['off', 'conservative']

/**
 * System prompt for the polish pass.
 *
 * Written as prohibitions rather than exhortations: the failure that matters is
 * a model "improving" a technical instruction into something the user never
 * said. Leaving a garble in place is far cheaper than a confident rewrite, so
 * every rule here constrains rather than encourages.
 */
const POLISH_SYSTEM = [
  'You clean up speech-to-text output that will be sent to a coding assistant.',
  '',
  'Return ONLY the cleaned text: no preamble, no explanation, no surrounding quotes, no code fences.',
  '',
  'Do:',
  '- Remove filler and hesitation: um, uh, er, ah, hmm, and meaningless "like", "you know", "I mean", "sort of", "kind of".',
  '- Collapse an immediate false start or stutter onto the corrected attempt.',
  '- Add punctuation and sentence casing.',
  '- Fix clear grammar slips and obvious misheard homophones chosen from context (their/there, to/too, cache/cash, byte/bite).',
  '',
  'Do not:',
  '- Change meaning, add requirements, or answer the request.',
  '- Rephrase for style, shorten, or summarize.',
  '- Translate.',
  '- Alter identifiers, file paths, flags, numbers, versions, or unusual technical terms.',
  '- Introduce any word the speaker did not say.',
  '',
  'If the text is already clean, return it unchanged.',
].join('\n')

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
 * @property {string} polish `off`, or `conservative` to clean the transcript with a model.
 * @property {string} [polishProvider] Provider route for the polish call; defaults to this deployment's current selection.
 * @property {string} [polishModel] Model id for the polish call; defaults to this deployment's current selection.
 * @property {number} polishTimeoutMs Deadline for the polish call alone, in milliseconds.
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
      const rawPolishTimeout = input.polishTimeoutMs
      let polishTimeoutMs = 15_000
      if (rawPolishTimeout !== undefined) {
        if (typeof rawPolishTimeout !== 'number' || !Number.isInteger(rawPolishTimeout)
          || rawPolishTimeout < 500 || rawPolishTimeout > 600_000) {
          issues.push({ message: 'polishTimeoutMs must be an integer between 500 and 600000' })
        } else {
          polishTimeoutMs = rawPolishTimeout
        }
      }
      const model = text('model', 'base.en')
      const language = text('language', 'en')
      const computeType = text('computeType', 'int8')
      const polish = text('polish', 'conservative')
      if (!COMPUTE_TYPES.includes(computeType)) {
        issues.push({ message: `computeType must be one of ${COMPUTE_TYPES.join(', ')}` })
      }
      if (!POLISH_MODES.includes(polish)) {
        issues.push({ message: `polish must be one of ${POLISH_MODES.join(', ')}` })
      }
      if (issues.length > 0) return { issues }
      return { value: { ...input, model, language, computeType, timeoutMs, polish, polishTimeoutMs } }
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
 * Resolve the model route for the polish call.
 *
 * An explicit `polishProvider`/`polishModel` pair wins; otherwise this uses the
 * deployment's own current selection, so the cleanup costs whatever the user
 * already pays for and needs no second credential. `undefined` means no route
 * could be determined, which the caller treats as "no polish".
 *
 * @param {object} ctx - the plugin context.
 * @param {VoiceInputConfig} config - validated host configuration.
 * @returns {{ provider: string, model: string } | undefined}
 */
function resolvePolishRoute(ctx, config) {
  if (typeof config.polishProvider === 'string' && typeof config.polishModel === 'string'
    && config.polishProvider !== '' && config.polishModel !== '') {
    return { provider: config.polishProvider, model: config.polishModel }
  }
  const selection = ctx.get('agentDefaultModel')
  if (selection === undefined || typeof selection.currentSelection !== 'function') return undefined
  const current = selection.currentSelection()
  if (current === null || typeof current !== 'object') return undefined
  const provider = current.provider
  const model = current.model
  if (typeof provider !== 'string' || typeof model !== 'string' || provider === '' || model === '') return undefined
  return { provider, model }
}

/** Strip a wrapping pair of quotes or a code fence a model may add despite instructions. */
function unwrapPolish(text) {
  let out = text.trim()
  const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(out)
  if (fence !== null) out = fence[1].trim()
  // Only a wrapping PAIR is removed, and only when nothing else is quoted, so a
  // legitimate quotation inside the instruction survives.
  if (out.length > 1 && /^".*"$/s.test(out) && (out.match(/"/g) ?? []).length === 2) {
    out = out.slice(1, -1).trim()
  }
  return out
}

/**
 * Clean one transcript with the configured model.
 *
 * Polish is strictly best-effort: every failure path returns `undefined`, and
 * the caller keeps the recognizer's own text. A cleanup pass must never be able
 * to lose or block a transcript the user actually spoke.
 *
 * @param {object} ctx - the plugin context.
 * @param {VoiceInputConfig} config - validated host configuration.
 * @param {string} text - the raw transcript.
 * @returns {Promise<string | undefined>} the cleaned text, or undefined to keep the raw one.
 */
async function polishTranscript(ctx, config, text) {
  if (config.polish === 'off') return undefined
  if (text.trim() === '') return undefined

  const route = resolvePolishRoute(ctx, config)
  if (route === undefined) {
    console.error('voice-input: no model route for polish; keeping the raw transcript')
    return undefined
  }

  const controller = new AbortController()
  const deadline = setTimeout(() => { controller.abort(new Error('polish timeout')) }, config.polishTimeoutMs)
  try {
    const messages = [{
      id: 'voice-input-polish',
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-voice-input' },
    }]
    let assembled = ''
    for await (const chunk of ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      messages,
      system: POLISH_SYSTEM,
      maxTokens: 2_000,
      temperature: 0,
      signal: controller.signal,
    })) {
      if (chunk.type === 'text-delta') assembled += chunk.text
      if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
        console.error(`voice-input: polish call failed: ${chunk.reason.failure?.message ?? 'unknown'}`)
        return undefined
      }
    }
    const cleaned = unwrapPolish(assembled)
    if (cleaned === '') {
      console.error('voice-input: polish returned no text; keeping the raw transcript')
      return undefined
    }
    // An aggressive rewrite is dropped rather than trusted: if the cleanup
    // changed the length drastically it added or removed substance.
    const ratio = cleaned.length / Math.max(1, text.trim().length)
    if (ratio < 0.5 || ratio > 1.8) {
      console.error(`voice-input: polish changed length by ${(ratio * 100).toFixed(0)}%; keeping the raw transcript`)
      return undefined
    }
    return cleaned
  } catch (error) {
    console.error('voice-input: polish unavailable, keeping the raw transcript:', String(error))
    return undefined
  } finally {
    clearTimeout(deadline)
  }
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
 * @returns {(bytes: Buffer, overrides?: { model?: string, language?: string, polish?: boolean }) => Promise<{ ok: true, text: string, polished?: true } | { ok: false, error: string }>}
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
    const raw = parsed.text.trim()

    // The cleanup pass is optional and never fatal: `undefined` means "keep what
    // the recognizer heard", which is also what every polish failure returns.
    const cleaned = overrides.polish === false ? undefined : await polishTranscript(ctx, config, raw)
    return {
      ok: true,
      text: cleaned ?? raw,
      ...(cleaned === undefined ? {} : { polished: true }),
    }
  }
}

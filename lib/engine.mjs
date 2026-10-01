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

import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
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

/**
 * Path the browser half pings when recording starts.
 *
 * Loading the model takes seconds; doing it while the user is still speaking
 * means the first transcript is ready when they stop instead of seconds later.
 * The answer is deliberately immediate — the host starts the work and does not
 * wait for it, because the client must never block on a warm-up.
 */
export const VOICE_INPUT_WARM_ROUTE = '/voice-input/warm'

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

/** CTranslate2 compute types this plugin accepts. */
const COMPUTE_TYPES = ['int8', 'int8_float32', 'float32', 'float16', 'int8_float16']

/**
 * Which transcription engine to run.
 *
 * `auto` prefers the bundled whisper.cpp (Vulkan) engine, because that is the
 * only one that can use an AMD GPU on Windows, and falls back to faster-whisper
 * — which is the only one that streams partial segments — when it is absent.
 */
const BACKEND_MODES = ['auto', 'ggml', 'faster-whisper']

/**
 * Accelerator preference.
 *
 * `auto` (the default) lets the engine rank whatever this machine actually
 * provides — discrete cards before integrated ones, more VRAM first. `cpu`
 * pins the CPU, and `gpu` refuses to silently fall back to the CPU so a broken
 * accelerator is reported instead of hidden.
 */
const DEVICE_MODES = ['auto', 'cpu', 'gpu']

/**
 * Byte cap for one collected engine stream.
 *
 * The result is ONE JSON line printed last, so an overflow keeps the tail and
 * the transcript still parses; the cap only bounds a runaway traceback.
 */
const MAX_ENGINE_OUTPUT_BYTES = 512 * 1024

/**
 * Grace period for the engine's termination procedure once the deadline fires
 * or the parent tears down. Separate from `timeoutMs`: that deadline bounds the
 * transcription, this bounds the kill.
 */
const ENGINE_GRACE_MS = 5_000

/**
 * How long an unused resident worker is kept warm before it is closed.
 *
 * The model stays loaded across recordings, so this only decides how long the
 * process survives with nothing to do. Ten minutes costs a few hundred MB of
 * RSS and saves the whole model-load cost on the next recording.
 */
const DEFAULT_IDLE_SHUTDOWN_MS = 10 * 60 * 1000

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
      // An EMPTY compute type is meaningful — it means "whatever the chosen
      // device prefers" — so it is accepted where the other text fields are not.
      const computeType = input.computeType === undefined
        ? ''
        : (input.computeType === '' ? '' : text('computeType', ''))
      const polish = text('polish', 'conservative')
      if (computeType !== '' && !COMPUTE_TYPES.includes(computeType)) {
        issues.push({ message: `computeType must be one of ${COMPUTE_TYPES.join(', ')}` })
      }
      if (!POLISH_MODES.includes(polish)) {
        issues.push({ message: `polish must be one of ${POLISH_MODES.join(', ')}` })
      }

      // Accelerator selection. `auto` asks the worker to rank whatever this
      // machine actually has; `cpu` pins the CPU; `gpu` refuses to run on the
      // CPU and reports why. `deviceIndex` only matters on a pinned device.
      const device = text('device', 'auto')
      if (!DEVICE_MODES.includes(device)) {
        issues.push({ message: `device must be one of ${DEVICE_MODES.join(', ')}` })
      }
      const integer = (key, fallback, min, max) => {
        const raw = input[key]
        if (raw === undefined) return fallback
        if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
          issues.push({ message: `${key} must be an integer between ${min} and ${max}` })
          return fallback
        }
        return raw
      }
      const deviceIndex = integer('deviceIndex', 0, 0, 64)
      const beamSize = integer('beamSize', 1, 1, 8)
      const cpuThreads = integer('cpuThreads', 0, 0, 256)
      const idleShutdownMs = integer('idleShutdownMs', DEFAULT_IDLE_SHUTDOWN_MS, 0, 24 * 60 * 60 * 1000)
      // Optional device pins, passed to the worker's environment.
      const hipVisibleDevices = input.hipVisibleDevices === undefined ? undefined : text('hipVisibleDevices', undefined)
      const cudaVisibleDevices = input.cudaVisibleDevices === undefined ? undefined : text('cudaVisibleDevices', undefined)
      const gfxVersion = input.gfxVersion === undefined ? undefined : text('gfxVersion', undefined)
      const workerPath = input.workerPath === undefined ? undefined : text('workerPath', undefined)
      const vulkanBinary = input.vulkanBinary === undefined ? undefined : text('vulkanBinary', undefined)

      // Engine choice. `auto` uses the bundled whisper.cpp GPU engine when its
      // files are present and falls back to faster-whisper otherwise.
      const backend = text('backend', 'auto')
      if (!BACKEND_MODES.includes(backend)) {
        issues.push({ message: `backend must be one of ${BACKEND_MODES.join(', ')}` })
      }
      const whisperModel = text('whisperModel', 'base.en')
      const ggmlBinary = input.ggmlBinary === undefined ? undefined : text('ggmlBinary', undefined)
      const ggmlModelDir = input.ggmlModelDir === undefined ? undefined : text('ggmlModelDir', undefined)
      // Vulkan device index for whisper.cpp. Pin it: ggml otherwise takes the
      // first device it enumerates, which on a desktop with an integrated
      // Radeon plus a discrete card may be the integrated one.
      const ggmlDevice = integer('ggmlDevice', 0, 0, 64)
      const ggmlDisableGpu = input.ggmlDisableGpu === undefined ? false : input.ggmlDisableGpu === true
      // Booleans fall back rather than rejecting the boot on a typo.
      const boolean = (key, fallback) => {
        const raw = input[key]
        if (raw === undefined) return fallback
        if (typeof raw !== 'boolean') {
          issues.push({ message: `${key} must be a boolean` })
          return fallback
        }
        return raw
      }

      if (issues.length > 0) return { issues }
      return {
        value: {
          ...input,
          model,
          language,
          computeType,
          timeoutMs,
          polish,
          polishTimeoutMs,
          device,
          deviceIndex,
          beamSize,
          cpuThreads,
          idleShutdownMs,
          backend,
          whisperModel,
          ggmlDevice,
          prewarm: boolean('prewarm', false),
          vad: boolean('vad', true),
          ggmlDisableGpu: ggmlDisableGpu === true,
          ...(hipVisibleDevices === undefined ? {} : { hipVisibleDevices }),
          ...(cudaVisibleDevices === undefined ? {} : { cudaVisibleDevices }),
          ...(gfxVersion === undefined ? {} : { gfxVersion }),
          ...(ggmlBinary === undefined ? {} : { ggmlBinary }),
          ...(ggmlModelDir === undefined ? {} : { ggmlModelDir }),
          ...(workerPath === undefined ? {} : { workerPath }),
          ...(vulkanBinary === undefined ? {} : { vulkanBinary }),
        },
      }
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
 * Where the bundled whisper.cpp engine lives.
 *
 * The Vulkan build is what reaches an AMD card on Windows, so it ships inside
 * the package. `engine/bin` holds the executable; `engine/models` may hold a
 * GGML model a user placed there themselves.
 */
export function defaultEngineDir() {
  return join(PACKAGE_ROOT, 'engine')
}

/** The bundled whisper.cpp executable for this platform, if it was shipped. */
export function defaultGgmlBinary() {
  const dir = join(defaultEngineDir(), 'bin')
  return process.platform === 'win32'
    ? join(dir, 'whisper-server.exe')
    : join(dir, 'whisper-server')
}

/**
 * Where GGML models are cached, and the upstream source they come from.
 *
 * whisper.cpp models are a different format from the CTranslate2 ones, so they
 * live in their own subdirectory and are downloaded on first use (about 142 MB
 * for `base.en`). Nothing is uploaded; this is a plain HTTPS fetch.
 */
export function defaultGgmlModelDir() {
  return join(defaultCacheDir(), 'ggml')
}

/** Repository the GGML model files are published from. */
const GGML_MODEL_HOST = process.env.DSH_VOICE_GGML_HOST ?? 'https://huggingface.co'

/**
 * Resolve the GGML model file for a configured model name, downloading it once.
 *
 * @param {string} name - model size or `ggml-*.bin` file name.
 * @param {string} dir - cache directory for GGML models.
 * @returns {Promise<string>} path to an existing model file.
 */
async function ensureGgmlModel(name, dir) {
  const file = name.endsWith('.bin') ? name : `ggml-${name}.bin`
  const target = join(dir, file)
  try {
    const info = await stat(target)
    if (info.isFile() && info.size > 0) return target
  } catch {
    // Not cached yet.
  }
  if (process.env.DSH_VOICE_GGML_LOCAL_ONLY === '1') {
    throw new Error(`GGML model is not cached and downloads are disabled: ${target}`)
  }

  await mkdir(dir, { recursive: true })
  const staging = `${target}.part-${randomBytes(3).toString('hex')}`
  const url = `${GGML_MODEL_HOST}/ggerganov/whisper.cpp/resolve/main/${file}`
  let response
  try {
    response = await fetch(url, { redirect: 'follow' })
  } catch (error) {
    throw new Error(`could not download ${file} from ${url}: ${String(error)}`)
  }
  if (!response.ok || response.body === null) {
    throw new Error(`could not download ${file}: HTTP ${response.status} from ${url}`)
  }
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(staging))
    await rename(staging, target)
  } catch (error) {
    await rm(staging, { force: true }).catch(() => {})
    throw new Error(`could not save ${file}: ${String(error)}`)
  }
  return target
}

/**
 * The whisper.cpp engine this process would use, if any.
 *
 * Resolving this is cheap when the files are already present and only performs
 * a download when the caller actually asks for the GGML engine, so a CPU-only
 * deployment never pays for it.
 *
 * @param {VoiceInputConfig} config - validated host configuration.
 * @returns {Promise<{ binary: string, model: string } | { error: string }>}
 */
export async function resolveGgmlEngine(config) {
  if (config.backend === 'faster-whisper') return { error: 'the whisper.cpp engine is disabled by config' }
  const binary = config.ggmlBinary ?? defaultGgmlBinary()
  try {
    const info = await stat(binary)
    if (!info.isFile()) return { error: `not a file: ${binary}` }
  } catch {
    return { error: `the bundled whisper.cpp engine is missing: ${binary}` }
  }
  try {
    const model = await ensureGgmlModel(config.whisperModel ?? 'base.en', config.ggmlModelDir ?? defaultGgmlModelDir())
    return { binary, model }
  } catch (error) {
    return { error: String(error instanceof Error ? error.message : error) }
  }
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
 * Compute type for the one-shot CLI path.
 *
 * That path always runs on the CPU (it hands a single command string to a shell
 * executor and never picks a device), so an empty configured value resolves to
 * the CPU default rather than reaching the CLI as an empty argument.
 *
 * @param {VoiceInputConfig} config - validated host configuration.
 * @returns {string} a concrete CTranslate2 compute type.
 */
function cliComputeType(config) {
  return config.computeType === '' || config.computeType === undefined ? 'int8' : config.computeType
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
    '--compute-type', cliComputeType(config),
    '--cache-dir', quote(paths.cacheDir),
  ].join(' ')
  return process.platform === 'win32' ? `cmd /c ${invocation}` : invocation
}

/**
 * Whether a `.py` script must be handed to the interpreter rather than executed.
 * @param {string} scriptPath - the transcription CLI.
 * @returns {boolean} true on Windows, where a `.py` is not a launchable image.
 */
function needsInterpreter(scriptPath) {
  return process.platform === 'win32' && /\.py$/i.test(scriptPath)
}

/**
 * The full argv for one engine run, with no composition-provided interpreter.
 *
 * Every argument is passed as its own element and never string-quoted: the
 * `subprocess` seam never shell-interprets argv, so a path containing a space or
 * a quote is carried through verbatim.
 *
 * @param {object} paths - interpreter, script, audio file, and cache paths.
 * @param {VoiceInputConfig} config - validated host configuration.
 * @param {{ model?: string, language?: string }} [overrides] - per-call overrides.
 * @returns {string[]} argv, `argv[0]` being the program.
 */
function engineArgv(paths, config, overrides = {}) {
  return [
    paths.pythonPath,
    paths.scriptPath,
    '--audio', paths.audioPath,
    '--model', overrides.model ?? config.model,
    '--language', overrides.language ?? config.language,
    '--compute-type', cliComputeType(config),
    '--cache-dir', paths.cacheDir,
  ]
}

/** `cmd.exe` location for the one Windows argv shape that needs it. */
function comspecPath() {
  return process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe'
}

/**
 * The launch seams this plugin can drive, newest first.
 *
 * `ctx.shell` is the capability seam DSH owns; its shape changed across builds:
 *
 *   resolve() + run(spec)                 older builds (<= 0.1.6)
 *   resolve() + execute(spec) + result()  current builds (>= 0.1.7)
 *
 * `ctx.subprocess` is the lower-level seam the shell executors are themselves
 * built on. It is the fallback for a composition that mounts no shell executor;
 * both are composed by default, so it is normally unused.
 *
 * CRITICAL: `ctx.shell` must never be read as a property here. Cordis refuses an
 * undeclared property read on this plugin's context with
 * `cannot get property "shell" without inject`, and DECLARING `shell` would park
 * this row forever on every composition that mounts no shell executor — the
 * tool would silently disappear there. So the shell is resolved through
 * `ctx.get('shell')`, the service-registry read that needs no declaration — the
 * same mechanism the polish route already uses for `agentDefaultModel`.
 * `ctx.subprocess` IS declared (it is composed by the base bundle everywhere)
 * and is read as a plain property.
 *
 * @param {object} ctx - the plugin context (declared injections resolved).
 * @returns {object | undefined} the shell executor, when this composition has one.
 */
function shellService(ctx) {
  try {
    const shell = ctx.get('shell')
    return typeof shell === 'object' || typeof shell === 'function' ? shell : undefined
  } catch {
    // No shell service in this composition: the plugin runs the engine directly.
    return undefined
  }
}

/**
 * The launch seam this composition provides.
 *
 * @param {object} ctx - the plugin context (declared injections resolved).
 * @returns {'shell-execute' | 'shell-run' | 'subprocess' | 'none'} the seam to use.
 */
export function engineSeam(ctx) {
  const shell = shellService(ctx)
  if (typeof shell?.execute === 'function' && typeof shell?.resolve === 'function') return 'shell-execute'
  if (typeof shell?.run === 'function' && typeof shell?.resolve === 'function') return 'shell-run'
  if (typeof ctx.subprocess?.spawn === 'function') return 'subprocess'
  return 'none'
}

/**
 * Run the engine once and collect its outcome.
 *
 * Output is collected with a byte cap and the TAIL is kept: the CLI prints one
 * JSON line last, so a head-truncated tail would lose the result. The caller
 * classifies timeouts from the signal it owns, so the raw exit facts are
 * returned here.
 *
 * @param {object} ctx - the plugin context (declared injections resolved).
 * @param {VoiceInputConfig} config - validated host configuration.
 * @param {object} paths - interpreter, script, audio file, and cache paths.
 * @param {string} cwd - working directory for the child; also where it may write.
 * @param {object} [overrides] - per-call model/language overrides.
 * @returns {Promise<{ exitCode: number | null, stdout: string, stderr: string, timedOut: boolean }>}
 */
export async function runEngine(ctx, config, paths, cwd, overrides = {}) {
  const argv = engineArgv(paths, config, overrides)
  const seam = engineSeam(ctx)
  if (seam === 'none') {
    throw new Error('this DSH composition provides neither a shell executor nor a subprocess provider')
  }

  // The shell seam takes ONE command string, parsed by the composition's own
  // interpreter, so the argv is re-quoted into that string. Windows arguments
  // additionally need `cmd /c`: PowerShell does not treat a quoted path in
  // command position as an executable.
  const parts = argv.map(quote)
  const command = process.platform === 'win32' ? `cmd /c ${parts.join(' ')}` : parts.join(' ')

  if (seam === 'shell-execute' || seam === 'shell-run') {
    const shell = shellService(ctx)
    const spec = shell.resolve({
      command,
      workdir: cwd,
      timeoutMs: config.timeoutMs,
      stdoutMaxBytes: MAX_ENGINE_OUTPUT_BYTES,
    })
    if (seam === 'shell-execute') {
      // `execute` publishes the live handle after preparation; `result()` is the
      // foreground projection of the same process and resolves — rather than
      // rejects — for nonzero exits, timeout kills, and aborts.
      const execution = await shell.execute(spec)
      const run = await execution.result()
      return {
        exitCode: run.exitCode ?? null,
        stdout: run.stdout?.text ?? '',
        stderr: run.stderr?.text ?? '',
        timedOut: run.timedOut === true,
      }
    }
    const run = await shell.run(spec)
    return {
      exitCode: run.exitCode ?? null,
      stdout: run.stdout?.text ?? '',
      stderr: run.stderr?.text ?? '',
      timedOut: false,
    }
  }

  // No shell executor in this composition: spawn the child directly. On Windows
  // a `.py` is associated with the launcher rather than being a launchable
  // image, so the interpreter is invoked through `cmd.exe /c`.
  const spawnArgv = needsInterpreter(paths.scriptPath) ? [comspecPath(), '/c', ...argv] : argv
  const controller = new AbortController()
  let timedOut = false
  const deadline = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, config.timeoutMs)

  try {
    const proc = ctx.subprocess.spawn({
      argv: spawnArgv,
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: MAX_ENGINE_OUTPUT_BYTES },
        stderr: { maxBytes: MAX_ENGINE_OUTPUT_BYTES },
      },
      graceMs: ENGINE_GRACE_MS,
      env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      signal: controller.signal,
    })

    let outcome
    try {
      outcome = await proc.done
    } catch (error) {
      if (!timedOut) throw error
      // A provider may report a killed child as a rejection; that IS this
      // caller's own timeout, so it becomes a bounded diagnostic, not a throw.
      outcome = { exitCode: null, signal: null }
    }
    return {
      exitCode: outcome.exitCode,
      stdout: proc.collected.stdout?.readFrom(0).text ?? '',
      stderr: proc.collected.stderr?.readFrom(0).text ?? '',
      timedOut,
    }
  } finally {
    clearTimeout(deadline)
  }
}

/**
 * Build the one function both halves use to run the engine.
 *
 * @param {object} ctx - the plugin context (declared injections resolved).
 * @param {VoiceInputConfig} config - validated host configuration.
 * @returns {(bytes: Buffer, overrides?: { model?: string, language?: string, polish?: boolean, audioName?: string }) => Promise<{ ok: true, text: string, polished?: true } | { ok: false, error: string }>}
 */
export function createTranscriber(ctx, config) {
  const pythonPath = config.pythonPath ?? defaultPythonPath()
  const scriptPath = config.scriptPath ?? join(PACKAGE_ROOT, 'python', 'transcribe.py')
  const cacheDir = config.cacheDir ?? defaultCacheDir()

  return async function transcribe(bytes, overrides = {}) {
    const runId = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
    // Staged under the OS temp root by THIS process, which is not confined. The
    // engine then only ever reads: a confined child may refuse writes anywhere
    // outside the session workspace, so the decode happens on the host side
    // rather than inside the child. `runDir` doubles as the child's cwd, so even
    // an engine that wants to write has somewhere it is allowed to.
    const runDir = join(tmpdir(), 'dsh-voice-input', `run-${runId}`)
    // The extension is informational — ffmpeg sniffs the container — but a
    // caller that knows what it staged can say so.
    const requestedName = typeof overrides.audioName === 'string' ? overrides.audioName.trim() : ''
    const audioName = /^\.[a-z0-9]{1,8}$/i.test(requestedName) ? `audio${requestedName}` : 'audio.webm'
    const audioPath = join(runDir, audioName)

    try {
      await mkdir(runDir, { recursive: true })
      await writeFile(audioPath, bytes)
    } catch (error) {
      return { ok: false, error: `could not stage the recording: ${String(error)}` }
    }

    let run
    try {
      run = await runEngine(ctx, config, { pythonPath, scriptPath, audioPath, cacheDir }, runDir, overrides)
    } catch (error) {
      return { ok: false, error: `the transcription engine could not start: ${String(error)}` }
    }

    const stdout = run.stdout
    const stderr = run.stderr
    if (run.timedOut) {
      return { ok: false, error: `the transcription engine ran past its ${config.timeoutMs} ms deadline and was stopped` }
    }
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

// ---------------------------------------------------------------------------
// Resident streaming engine
//
// `createTranscriber` above starts a fresh process per recording, which pays the
// model-load cost every time (measured at ~8 s for base.en on this machine) and
// can only report a transcript once the whole decode has finished.
//
// The worker in `python/worker.py` loads the model once and streams one NDJSON
// event per decoded segment. This class is the host end of that protocol: it
// keeps the child alive across recordings, buffers complete lines from raw
// stdout chunks, fans them out to per-request listeners, and shuts the child
// down on an idle timer or when the owning fiber is disposed.
// ---------------------------------------------------------------------------

/** A single NDJSON line longer than this is a protocol violation, not output. */
const MAX_WORKER_LINE_BYTES = 4 * 1024 * 1024

/**
 * Events that belong to the REQUEST lifecycle rather than the WORKER lifecycle.
 *
 * `ready` is deliberately absent: the worker reports it once per model load, and
 * a second recording on the same warm worker never re-emits it. Ending a stream
 * there would silently drop the transcript.
 */
const STREAM_TERMINAL_EVENTS = new Set(['done', 'error', 'cancelled'])

/**
 * Pull the accelerator settings the current build understands out of the
 * plugin config, keeping only what is set.
 *
 * `HIP_VISIBLE_DEVICES` is what pins the discrete AMD card on a machine that
 * also has an integrated Radeon; `CUDA_VISIBLE_DEVICES` is the NVIDIA twin.
 * Both are read by the child's runtime at import time, so they must be present
 * on the spawned environment — setting them later has no effect.
 */
function acceleratorEnv(config) {
  const env = {}
  if (typeof config.hipVisibleDevices === 'string' && config.hipVisibleDevices !== '') {
    env.HIP_VISIBLE_DEVICES = config.hipVisibleDevices
  }
  if (typeof config.cudaVisibleDevices === 'string' && config.cudaVisibleDevices !== '') {
    env.CUDA_VISIBLE_DEVICES = config.cudaVisibleDevices
  }
  if (typeof config.gfxVersion === 'string' && config.gfxVersion !== '') {
    env.HSA_OVERRIDE_GFX_VERSION = config.gfxVersion
  }
  if (typeof config.vulkanBinary === 'string' && config.vulkanBinary !== '') {
    env.DSH_VOICE_VULKAN_BIN = config.vulkanBinary
  }
  // Worker diagnostics are stderr-only and never interleave with protocol lines.
  env.PYTHONIOENCODING = 'utf-8'
  env.PYTHONUTF8 = '1'
  return env
}

/** Queue-backed pull stream over one request's events. */
class EventStream {
  /**
   * @param {object} worker - the owning {@link WorkerEngine}.
   * @param {string} requestId - the id this stream listens for.
   * @param {AbortSignal} [signal] - caller cancellation.
   */
  constructor(worker, requestId, signal) {
    this._worker = worker
    this._id = requestId
    this._signal = signal
    this._items = []
    this._waiting = null
    this._ended = false
    this._dispose = worker.listen(requestId, (event) => this._push(event))
    if (signal !== undefined) {
      this._onAbort = () => {
        this._finish()
        worker.cancel(requestId)
      }
      if (signal.aborted) this._onAbort()
      else signal.addEventListener('abort', this._onAbort, { once: true })
    }
  }

  _push(event) {
    this._items.push(event)
    if (STREAM_TERMINAL_EVENTS.has(event.event)) this._finish()
    this._wake()
  }

  _finish() {
    if (this._ended) return
    this._ended = true
    this._dispose?.()
    this._dispose = null
    if (this._onAbort !== undefined && this._signal !== undefined) {
      this._signal.removeEventListener('abort', this._onAbort)
    }
    this._wake()
  }

  _wake() {
    const waiting = this._waiting
    this._waiting = null
    if (waiting !== null) waiting()
  }

  /**
   * Next event, or `{ done: true }` once the request has settled.
   * @returns {Promise<{ value?: object, done: boolean }>}
   */
  async next() {
    while (this._items.length === 0) {
      if (this._ended) return { done: true }
      await new Promise((resolve) => { this._waiting = resolve })
    }
    return { value: this._items.shift(), done: false }
  }

  /**
   * Stop listening and release this stream's resources.
   *
   * This deliberately does NOT kill the worker: the model it holds is the whole
   * reason the next recording is fast, and a second caller may still be reading.
   * The worker retires on its own idle timer, or with `dispose()`. Cancellation
   * is a separate, explicit act — see {@link WorkerEngine.cancel}.
   */
  close() {
    this._finish()
    this._items.length = 0
  }
}

/** Host end of the `python/worker.py` NDJSON protocol. */
export class WorkerEngine {
  /**
   * @param {object} ctx - the plugin context (declared injections resolved).
   * @param {VoiceInputConfig} config - validated host configuration.
   */
  constructor(ctx, config) {
    this._ctx = ctx
    this._config = config
    this._child = null
    this._lines = ''
    this._listeners = new Map()
    this._active = new Set()
    this._stderr = []
    this._idleTimer = null
    this._spawnToken = 0
    this._warm = null
    /** Last plan/device facts reported by the worker, for the status line. */
    this.status = null
  }

  get pythonPath() {
    return this._config.pythonPath ?? defaultPythonPath()
  }

  get workerPath() {
    return this._config.workerPath ?? join(PACKAGE_ROOT, 'python', 'worker.py')
  }

  _idleShutdownMs() {
    const configured = this._config.idleShutdownMs
    return typeof configured === 'number' && configured >= 0 ? configured : DEFAULT_IDLE_SHUTDOWN_MS
  }

  /** Subscribe to every event addressed to one request id. */
  listen(requestId, listener) {
    const set = this._listeners.get(requestId) ?? new Set()
    set.add(listener)
    this._listeners.set(requestId, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) this._listeners.delete(requestId)
    }
  }

  /** Send one request. Starts the worker first when it is not running. */
  send(request) {
    const child = this._child ?? this._spawn()
    this._active.add(request.id)
    this._scheduleIdleShutdown()
    child.stdin.write(`${JSON.stringify(request)}\n`)
  }

  /**
   * Cancel one in-flight request.
   *
   * The worker decodes one request at a time, so cancelling means stopping the
   * child and letting the next request start a fresh one: that is the only way
   * to interrupt a decode already inside a native call. The worker is only
   * stopped once nothing else is still waiting on it.
   */
  cancel(requestId) {
    const set = this._listeners.get(requestId)
    if (set === undefined && !this._active.has(requestId)) return
    this._active.delete(requestId)
    if (set !== undefined) {
      for (const listener of [...set]) {
        try {
          listener({ id: requestId, event: 'cancelled' })
        } catch (error) {
          console.error('voice-input: a cancelled listener threw', error)
        }
      }
      set.clear()
      this._listeners.delete(requestId)
    }
    if (this._active.size === 0) this._stop()
  }

  _spawn() {
    const env = acceleratorEnv(this._config)
    const token = ++this._spawnToken
    const child = this._ctx.subprocess.spawn({
      argv: [comspecPath(), '/c', this.pythonPath, this.workerPath],
      cwd: tmpdir(),
      stdio: {
        stdin: 'pipe',
        stdout: { maxBytes: MAX_ENGINE_OUTPUT_BYTES },
        stderr: { maxBytes: MAX_ENGINE_OUTPUT_BYTES },
      },
      graceMs: ENGINE_GRACE_MS,
      env,
    })
    this._child = child
    this._lines = ''
    this._stderr = []
    child.stdin.on('error', (error) => {
      console.error('voice-input: the engine worker stdin failed', error)
    })
    // The raw stdout stream is read rather than `collected`, because collected
    // output is offset-based and the whole point here is to see each line the
    // moment the worker flushes it.
    void this._pump(child, token)
    return child
  }

  async _pump(child, token) {
    const decoder = new TextDecoder('utf-8')
    try {
      for await (const chunk of child.stdout) {
        this._lines += decoder.decode(chunk, { stream: true })
        if (this._lines.length > MAX_WORKER_LINE_BYTES) {
          throw new Error('the engine worker emitted an over-long protocol line')
        }
        let newline = this._lines.indexOf('\n')
        while (newline !== -1) {
          const line = this._lines.slice(0, newline).trim()
          this._lines = this._lines.slice(newline + 1)
          if (line !== '') this._dispatch(line)
          newline = this._lines.indexOf('\n')
        }
      }
    } catch (error) {
      if (token === this._spawnToken) {
        console.error('voice-input: reading the engine worker failed:', String(error))
      }
    } finally {
      if (token === this._spawnToken) {
        await this._handleExit(child)
      }
    }
  }

  _dispatch(line) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      console.error(`voice-input: unreadable engine line: ${excerpt(line, 200)}`)
      return
    }
    if (event === null || typeof event !== 'object') return
    if (event.id === null || event.id === undefined) {
      // An id-less line is a worker-level complaint (an unreadable request).
      console.error(`voice-input: engine protocol error: ${event.message ?? 'unknown'}`)
      return
    }
    const set = this._listeners.get(event.id)
    if (set !== undefined) {
      for (const listener of [...set]) {
        try {
          listener(event)
        } catch (error) {
          console.error('voice-input: an engine listener threw', error)
        }
      }
    }
    if (STREAM_TERMINAL_EVENTS.has(event.event)) this._active.delete(event.id)
    // `ready` describes a loaded model, `done` describes a finished request that
    // names the backend it ran on. The GPU engine only reports the latter.
    if (event.event === 'ready' || event.event === 'caps' || event.event === 'done') {
      this.status = { ...(this.status ?? {}), ...event }
    }
  }

  async _handleExit(child) {
    this._child = null
    const collected = child.collected.stderr?.readFrom(0).text ?? ''
    if (collected.trim() !== '') this._stderr.push(collected.trim())
    let outcome = null
    try {
      outcome = await child.done
    } catch {
      // A provider failure is reported through the pending listeners below.
    }
    const detail = excerpt(this._stderr.join('\n').slice(-1500), 500)
    for (const [requestId, set] of this._listeners) {
      for (const listener of [...set]) {
        try {
          listener({
            id: requestId,
            event: 'error',
            code: 'engine-exited',
            message: `the transcription engine stopped before answering${detail === '' ? '' : `: ${detail}`}`,
          })
        } catch (error) {
          console.error('voice-input: an engine listener threw', error)
        }
      }
      set.clear()
      this._listeners.delete(requestId)
    }
    if (outcome !== null && outcome.exitCode !== 0 && detail !== '') {
      console.error(`voice-input: the engine worker exited with code ${String(outcome.exitCode)}: ${detail}`)
    }
  }

  _scheduleIdleShutdown() {
    if (this._idleTimer !== null) clearTimeout(this._idleTimer)
    const idleMs = this._idleShutdownMs()
    if (idleMs === 0) return
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null
      this._stop()
    }, idleMs)
    // Never hold the host process open just to keep the model warm.
    this._idleTimer.unref?.()
  }

  _stop() {
    if (this._idleTimer !== null) {
      clearTimeout(this._idleTimer)
      this._idleTimer = null
    }
    const child = this._child
    this._child = null
    if (child === null) return
    try {
      child.stdin.write(`${JSON.stringify({ id: `shutdown-${Date.now()}`, op: 'shutdown' })}\n`)
    } catch {
      // The pipe may already be gone; terminating below covers that.
    }
    const hardKill = setTimeout(() => {
      try {
        child.terminate()
      } catch {
        // Already gone.
      }
    }, 2000)
    hardKill.unref?.()
  }

  /** Load the model before the first recording, so its cost is paid early. */
  async prewarm() {
    if (this._warm !== null) return this._warm
    this._warm = (async () => {
      const requestId = `warm-${Date.now().toString(36)}`
      const stream = await this.transcribeRequest(requestId, {
        op: 'warm',
        model: this._config.model,
        device: this._config.device,
        deviceIndex: this._config.deviceIndex,
        computeType: this._config.computeType,
        cpuThreads: this._config.cpuThreads,
        cacheDir: this._config.cacheDir ?? defaultCacheDir(),
      })
      try {
        for (;;) {
          const { value, done } = await stream.next()
          if (done) break
          if (value.event === 'error') console.error(`voice-input: prewarm failed: ${value.message}`)
          if (value.event === 'ready') this.status = value
        }
      } finally {
        stream.close()
        this._warm = null
      }
    })()
    return this._warm
  }

  /**
   * The whisper.cpp engine to advertise to the worker, resolved once.
   *
   * `undefined` means the worker should use faster-whisper: ether the engine is
   * disabled, its files are missing, or its model could not be fetched.
   */
  async _ggmlEngine() {
    if (this._ggml !== undefined) return this._ggml
    if (this._config.backend === 'faster-whisper') {
      this._ggml = null
      return this._ggml
    }
    const resolved = await resolveGgmlEngine(this._config)
    if ('error' in resolved) {
      if (this._config.backend === 'ggml') {
        // An explicit request for this engine must not silently become a CPU run.
        throw new Error(`the whisper.cpp engine is unavailable: ${resolved.error}`)
      }
      console.error(`voice-input: whisper.cpp engine unavailable, using faster-whisper (${resolved.error})`)
      this._ggml = null
      return this._ggml
    }
    this._ggml = resolved
    return this._ggml
  }

  /**
   * Open a pull stream for one worker request.
   *
   * @param {string} requestId - the id this stream listens for.
   * @param {object} fields - the request body, minus `id`.
   * @returns {Promise<object>} the pull stream.
   */
  async transcribeRequest(requestId, fields) {
    const stream = new EventStream(this, requestId)
    const ggml = await this._ggmlEngine()
    this.send({
      id: requestId,
      ...fields,
      ...(ggml === null
        ? {}
        : {
            backend: 'ggml',
            ggmlBinary: ggml.binary,
            ggmlModel: ggml.model,
            ggmlDevice: this._config.ggmlDevice ?? 0,
            ggmlDisableGpu: this._config.ggmlDisableGpu === true,
            // `backend: 'ggml'` names the engine; THIS says whether the worker may
            // fall back to the CPU when it fails. Only an explicit `backend: ggml`
            // in the row forbids it, so `auto` still degrades gracefully.
            allowFallback: this._config.backend !== 'ggml',
          }),
    })
    return stream
  }

  /** Close the child and release the loaded model. */
  dispose() {
    this._stop()
    this._listeners.clear()
  }
}

/**
 * The live engine for this PROCESS, and the number of activations holding it.
 *
 * One worker per process is the invariant that matters. Each worker owns a
 * `whisper-server`, and each `whisper-server` holds its model in VRAM (~418 MB
 * measured); two at once were observed alive on this machine, and more would
 * accumulate on every activation. A process-wide singleton rather than a
 * per-context map, because a hot reload can hand `apply()` a different context
 * object while the previous engine is still running — and because a Cordis
 * context may never be garbage collected, which would make a WeakMap key
 * useless as a guard.
 */
let LIVE_ENGINE = null

/**
 * The streaming transcriber the browser route and the tools share.
 *
 * `transcribe()` returns a pull stream of worker events so the caller can react
 * to a partial transcript while the decode is still running. The final `done`
 * event carries the complete text.
 *
 * @param {object} ctx - the plugin context (declared injections resolved).
 * @param {VoiceInputConfig} config - validated host configuration.
 * @returns {ResidentTranscriber}
 */
export function createStreamingTranscriber(ctx, config) {
  if (LIVE_ENGINE !== null && !LIVE_ENGINE.engine.disposed) {
    // A later activation adopts the running engine; it does not get its own.
    LIVE_ENGINE.adopters += 1
    return LIVE_ENGINE.transcriber
  }

  const engine = new WorkerEngine(ctx, config)
  const holder = { engine, adopters: 1, transcriber: null }

  // The child is owned by this fiber: reloading the plugin must not leave a
  // Python process holding a GPU. A later activation that adopted this engine
  // must not tear it down while the original owner is still alive, so only the
  // final release disposes it.
  ctx.effect(() => () => {
    holder.adopters -= 1
    if (holder.adopters <= 0) {
      engine.dispose()
      engine.disposed = true
      if (LIVE_ENGINE === holder) LIVE_ENGINE = null
    }
  }, 'voice-input engine')

  if (config.prewarm === true) {
    // Fire and forget: warming must never delay or fail plugin activation.
    setTimeout(() => { void engine.prewarm() }, 0).unref?.()
  }

  const transcriber = {
    /** The resolved engine state, once the worker has reported it. */
    get status() {
      return engine.status
    },

    /**
     * Clean one transcript with the configured model route.
     *
     * Exposed so the HTTP route can polish the final text while the tool keeps
     * using `run()`. Strictly best-effort: `undefined` always means "keep the
     * recognizer's own words".
     *
     * @param {string} text - the raw transcript.
     * @returns {Promise<string | undefined>} the cleaned text, when it is trustworthy.
     */
    polish(text) {
      if (config.polish === 'off') return Promise.resolve(undefined)
      return polishTranscript(ctx, config, text)
    },

    /**
     * Start loading the model without waiting for it.
     *
     * Called when a recording begins so the load overlaps with speaking. Never
     * rejects and never blocks: a failed warm-up only means the next
     * transcription loads the model itself.
     *
     * @returns {void}
     */
    warm() {
      try {
        void engine.prewarm().catch(() => {})
      } catch (error) {
        console.error('voice-input: prewarm failed', error)
      }
    },

    /**
     * Stage bytes and stream the engine's events for them.
     *
     * @param {Buffer} bytes - the recording.
     * @param {object} [overrides] - per-call overrides.
     * @returns {Promise<{ stream: object, runDir: string }>}
     */
    async begin(bytes, overrides = {}) {
      const runId = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
      const runDir = join(tmpdir(), 'dsh-voice-input', `run-${runId}`)
      const requestedName = typeof overrides.audioName === 'string' ? overrides.audioName.trim() : ''
      const audioName = /^\.[a-z0-9]{1,8}$/i.test(requestedName) ? `audio${requestedName}` : 'audio.webm'
      const audioPath = join(runDir, audioName)
      await mkdir(runDir, { recursive: true })
      await writeFile(audioPath, bytes)
      const requestId = runId
      const stream = await engine.transcribeRequest(requestId, {
        op: 'transcribe',
        audio: audioPath,
        model: overrides.model ?? config.model,
        language: overrides.language ?? config.language,
        device: overrides.device ?? config.device,
        deviceIndex: overrides.deviceIndex ?? config.deviceIndex,
        computeType: overrides.computeType ?? config.computeType,
        cpuThreads: config.cpuThreads,
        cacheDir: config.cacheDir ?? defaultCacheDir(),
        beamSize: config.beamSize,
        wordTimestamps: overrides.wordTimestamps === true,
        vad: overrides.vad,
      })
      return { stream, runDir, requestId }
    },

    /**
     * Run one recording to completion, collecting the transcript.
     *
     * `onEvent` is called for every event as it arrives; the returned object
     * mirrors what the one-shot transcriber returned, so the tool keeps its
     * contract.
     *
     * @param {Buffer} bytes - the recording.
     * @param {{ onEvent?: (event: object) => void }} [options] - progress sink.
     * @returns {Promise<{ ok: true, text: string, polished?: true } | { ok: false, error: string }>}
     */
    async run(bytes, options = {}) {
      let handle
      try {
        handle = await this.begin(bytes, options)
      } catch (error) {
        return { ok: false, error: `could not stage the recording: ${String(error)}` }
      }
      const pieces = []
      let failure = null
      try {
        for (;;) {
          const { value, done } = await handle.stream.next()
          if (done) break
          options.onEvent?.(value)
          if (value.event === 'segment' && typeof value.text === 'string') pieces.push(value.text)
          if (value.event === 'done') {
            options.onEvent?.(value)
            const raw = String(value.text ?? '').trim()
            if (raw === '') return { ok: false, error: 'no speech was recognized in that recording' }
            const cleaned = options.polish === false ? undefined : await polishTranscript(ctx, config, raw)
            return {
              ok: true,
              text: cleaned ?? raw,
              ...(cleaned === undefined ? {} : { polished: true }),
            }
          }
          if (value.event === 'error') failure = value.message ?? 'transcription failed'
          if (value.event === 'cancelled') failure = 'the transcription was cancelled'
        }
      } catch (error) {
        return { ok: false, error: `the transcription engine failed: ${String(error)}` }
      } finally {
        handle.stream.close()
      }
      return { ok: false, error: failure ?? 'the transcription engine stopped without a result' }
    },

    dispose() {
      engine.dispose()
      engine.disposed = true
      if (LIVE_ENGINE === holder) LIVE_ENGINE = null
    },
  }

  holder.transcriber = transcriber
  LIVE_ENGINE = holder
  return transcriber
}

/**
 * Answer one browser recording with a stream of newline-delimited JSON events.
 *
 * The first line arrives as soon as the recording is staged, and each `segment`
 * line arrives while the remaining audio is still being decoded — that is what
 * lets the composer type the transcript in place instead of freezing and then
 * dumping a finished sentence.
 *
 * Frame shape (one JSON object per line):
 *   { "type": "status",  "stage": "loading"|"decoding", "detail": {...} }
 *   { "type": "partial", "text": "<so far>", "segments": 2 }
 *   { "type": "final",   "ok": true, "text": "...", "polished": true }
 *   { "type": "error",   "error": "..." }
 *
 * The polish pass, when enabled, runs after recognition and is reported in the
 * `final` frame: partials stay raw so the draft never shows cleaned text that a
 * later frame rewrites.
 *
 * @param {object} res - the Node response.
 * @param {Buffer} bytes - the recording, ALREADY read by the route. A request
 *   stream can be consumed only once, so the body is deliberately not read here.
 * @param {ResidentTranscriber} transcriber - the shared resident engine.
 * @param {VoiceInputConfig} config - validated host configuration.
 */
export async function streamTranscription(res, bytes, transcriber, config) {
  res.statusCode = 200
  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('cache-control', 'no-store, no-transform')
  res.setHeader('x-accel-buffering', 'no')
  // Flushing immediately is what lets the browser start reading before the
  // first decode completes.
  res.flushHeaders?.()

  let closed = false
  res.on('close', () => { closed = true })
  const write = (frame) => {
    if (closed || res.writableEnded === true) return false
    try {
      res.write(`${JSON.stringify(frame)}\n`)
      return true
    } catch {
      closed = true
      return false
    }
  }

  let handle
  try {
    handle = await transcriber.begin(bytes)
  } catch (error) {
    write({ type: 'error', error: `could not stage the recording: ${String(error)}` })
    res.end()
    return
  }

  const finish = () => {
    try {
      handle.stream.close()
    } catch {
      // Already settled.
    }
    try {
      res.end()
    } catch {
      // Already ended.
    }
  }

  write({ type: 'status', stage: 'decoding' })

  let raw = ''
  try {
    for (;;) {
      const { value, done } = await handle.stream.next()
      if (done) break

      if (value.event === 'loading') {
        write({ type: 'status', stage: 'loading', detail: { model: value.model, plan: value.plan } })
      } else if (value.event === 'ready') {
        write({
          type: 'status',
          stage: 'ready',
          detail: {
            backend: value.backend,
            deviceName: value.deviceName,
            computeType: value.computeType,
            loadMs: value.loadMs,
          },
        })
      } else if (value.event === 'start') {
        write({
          type: 'status',
          stage: 'decoding',
          detail: { duration: value.duration, language: value.language, backend: value.backend },
        })
      } else if (value.event === 'segment') {
        raw = raw === '' ? String(value.text) : `${raw} ${value.text}`
        write({ type: 'partial', text: raw, segments: (value.index ?? 0) + 1 })
      } else if (value.event === 'done') {
        raw = String(value.text ?? raw).trim()
        if (raw === '') {
          write({ type: 'error', error: 'no speech was recognized in that recording' })
          finish()
          return
        }
        // Polish runs once, after recognition, and rides in the FINAL frame:
        // partials stay raw so the draft is never rewritten by a later frame.
        const polished = await transcriber.polish(raw)
        write({
          type: 'final',
          ok: true,
          text: polished ?? raw,
          ...(polished === undefined ? {} : { polished: true }),
          backend: value.backend,
          deviceName: value.deviceName,
          elapsed: value.elapsed,
        })
        finish()
        return
      } else if (value.event === 'error') {
        write({ type: 'error', error: value.message ?? 'transcription failed' })
        finish()
        return
      } else if (value.event === 'cancelled') {
        write({ type: 'error', error: 'the transcription was cancelled' })
        finish()
        return
      }
    }
    write({ type: 'error', error: 'the transcription engine stopped without a result' })
    finish()
  } catch (error) {
    write({ type: 'error', error: `the transcription engine failed: ${String(error)}` })
    finish()
  }
}

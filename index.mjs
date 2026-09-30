/**
 * Host half — the model-facing `voice_transcribe` tool, plus the browser route
 * the microphone button posts to.
 *
 * ONE row, with the route deferred. That shape is forced by two facts:
 *
 * - `webServer` never appears in a headless, SDK, or ACP profile, so it cannot
 *   be a hard dependency of a row that must also work there.
 * - The boot audit fails on ANY entry left pending (`N entry did not activate`),
 *   so a second row that merely waits for `webServer` breaks those profiles too.
 *
 * `ctx.inject(['webServer'], …)` is the deferred form: the callback runs when
 * the carrier appears (which is AFTER this row's `apply` — reading it once here
 * sees `undefined`, the bug that made the route silently never register), and
 * simply never runs where no carrier exists, without leaving the entry pending.
 *
 * Plain JavaScript on purpose: a published bundle that needs no build step also
 * needs no `prepare` script, so a direct git install works.
 *
 * @module dsh-voice-input
 */

import {
  Config as EngineConfig,
  MAX_TOOL_FILE_BYTES,
  TRANSCRIBE_TOOL_NAME,
  VOICE_INPUT_ROUTE,
  createTranscriber,
  readBoundedBody,
  sendJson,
} from './lib/engine.mjs'

/** Cordis function-plugin name. */
export const name = 'voice-input'

/**
 * The process seam the engine runs through, the tool registry, and the
 * filesystem an audio path is read through.
 *
 * All three are present in every base-backed composition, which is why they can
 * be hard dependencies. `webServer` is not — see the module comment.
 */
export const inject = ['shell', 'tools', 'fs']

/** Re-exported so callers and tests read one configuration contract. */
export const Config = EngineConfig

/** Model-facing tool name, re-exported for callers and tests. */
export { TRANSCRIBE_TOOL_NAME, VOICE_INPUT_ROUTE }

/**
 * The tool's parameter schema, exported so a test can assert the exact wire
 * shape rather than pattern-match the source.
 *
 * Standard JSON Schema: the provider validates this verbatim, so requiredness is
 * the object-level array. A per-property `required: true` is the in-repo
 * `defineTool` DSL's convenience form and is rejected on the wire.
 */
export const TRANSCRIBE_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: {
      type: 'string',
      description: 'Path of the audio file to transcribe. Relative paths resolve against the session working directory.',
    },
    language: {
      type: 'string',
      description: 'Spoken language code such as "en", or "auto" to detect it. Defaults to the configured language.',
    },
  },
  required: ['path'],
}

/** The tool's stated purpose, shown to the model. */
function toolDescription(language) {
  return 'Transcribe an audio file to text with the local faster-whisper engine. '
    + 'Accepts the formats ffmpeg decodes (wav, mp3, m4a, webm/opus, ogg, flac). Runs offline on '
    + 'this machine; nothing is uploaded.'
    + ` Defaults to ${language} when the spoken language is not given.`
}

/**
 * Register the transcription route on a composition that serves HTTP.
 * @param {unknown} ctx - the carrier-resolved context.
 * @param {import('./lib/engine.mjs').VoiceInputConfig} config - validated host configuration.
 * @param {import('./lib/engine.mjs').Transcriber} transcribe - the shared engine runner.
 */
function registerRoute(ctx, config, transcribe) {
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

/**
 * Register the transcription tool and, where a browser can reach it, the route.
 * @param {unknown} ctx - the plugin context (declared injections resolved).
 * @param {import('./lib/engine.mjs').VoiceInputConfig} config - validated host configuration.
 */
export function apply(ctx, config) {
  const transcribe = createTranscriber(ctx, config)

  ctx.effect(() => ctx.tools.register({
    name: TRANSCRIBE_TOOL_NAME,
    description: toolDescription(config.language),
    parameters: TRANSCRIBE_PARAMETERS,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    /**
     * Read one audio file and transcribe it.
     * @param {unknown} args - validated model arguments.
     * @param {{ signal?: AbortSignal }} exec - execution identity and cancellation.
     * @returns {Promise<string>} the transcript, or a message naming the failure.
     */
    execute: async (args, exec) => {
      const request = args ?? {}
      const requested = typeof request.path === 'string' ? request.path.trim() : ''
      if (requested === '') return 'No audio path was given. Pass the path of an audio file to transcribe.'
      const language = typeof request.language === 'string' && request.language.trim() !== ''
        ? request.language.trim()
        : undefined

      let bytes
      try {
        const target = await ctx.fs.resolve(requested)
        const info = await ctx.fs.stat(target)
        if (info === undefined) return `No such audio file: ${requested}`
        if (info.type !== 'file') return `Not a regular file: ${requested}`
        bytes = Buffer.from(await ctx.fs.readBytes(target, exec?.signal, MAX_TOOL_FILE_BYTES))
      } catch (error) {
        return `Could not read ${requested}: ${String(error)}`
      }
      if (bytes.byteLength === 0) return `The audio file is empty: ${requested}`

      const result = await transcribe(bytes, language === undefined ? {} : { language })
      return result.ok ? result.text : `Transcription failed: ${result.error}`
    },
  }))

  // The route waits for the carrier instead of requiring it. On a composition
  // with no Web surface this callback simply never runs, and the tool above is
  // the whole feature — no entry is left pending, so the boot audit stays green.
  ctx.inject(['webServer'], (routeCtx) => {
    registerRoute(routeCtx, config, transcribe)
  })
}

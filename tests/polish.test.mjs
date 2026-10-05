/**
 * The cleanup pass as a REQUEST contract, not a source-text contract.
 *
 * `contract.test.mjs` asserts that the polish code mentions the llm service and
 * the deadline. That is necessary and not sufficient: the defect this file
 * exists for was a request that named no reasoning effort at all, so it silently
 * inherited the adapter default (`high`), and since this plugin renders only
 * text deltas the user waited through reasoning they could never see — often
 * until the deadline expired and the transcript came back raw. Nothing in the
 * source text said so. Only the assembled request does.
 *
 * These tests therefore drive a real transcriber over a scripted llm service and
 * assert on the options it was handed.
 *
 * @module dsh-voice-input/tests/polish
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const ENGINE_PATH = join(PACKAGE_DIR, 'lib', 'engine.mjs')

/** A filler-heavy utterance, and the cleanup it is supposed to produce. */
const RAW = 'Umm, so, uhh, like, can you please, you know, refactor the parser and then, umm, run the tests.'
const CLEANED = 'Can you please refactor the parser and then run the tests?'

/**
 * Import a PRIVATE instance of the engine.
 *
 * The engine caches one live transcriber per process on purpose (a plugin reload
 * must not orphan a Python worker holding a GPU), and that cached transcriber
 * closes over the ctx and config of whichever activation created it. One import
 * per test is what keeps a later case from being answered by an earlier case's
 * stub — the same isolation a fresh process gives, without the process.
 *
 * @returns {Promise<object>} the engine module.
 */
let engineImports = 0
function freshEngine() {
  engineImports += 1
  return import(`${pathToFileURL(ENGINE_PATH).href}?polish-test=${engineImports}`)
}

/** Chunks one successful cleanup call produces. */
function answerWith(text) {
  return [
    { type: 'text-delta', text },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * An adapter refusal, delivered exactly as the runtime delivers it: a terminal
 * finish chunk, not a throw.
 */
const REFUSES_EFFORT = [
  {
    type: 'finish',
    reason: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'no such effort' } },
  },
]

/**
 * Build a transcriber whose llm service replays one script per call.
 *
 * @param {Array<Array<object>>} script - chunks for each successive call.
 * @param {object} [configOverrides] - raw config fields for this case.
 * @returns {Promise<{ transcriber: object, requests: object[] }>}
 */
async function buildTranscriber(script, configOverrides = {}) {
  const { Config, createStreamingTranscriber } = await freshEngine()
  const requests = []
  let call = 0
  const ctx = {
    // The polish route falls back to the deployment's own selection, so a route
    // has to resolve for a call to be attempted at all.
    get: (name) => (name === 'agentDefaultModel'
      ? { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) }
      : undefined),
    effect: () => () => {},
    llm: {
      stream(options) {
        requests.push(options)
        const chunks = script[Math.min(call, script.length - 1)]
        call += 1
        return (async function* () {
          for (const chunk of chunks) yield chunk
        })()
      },
    },
  }
  const validated = Config['~standard'].validate({
    polish: 'conservative',
    prewarm: false,
    polishTimeoutMs: 4_000,
    ...configOverrides,
  })
  assert.equal(validated.issues, undefined, `config rejected: ${JSON.stringify(validated.issues)}`)
  const transcriber = createStreamingTranscriber(ctx, validated.value)
  return {
    requests,
    transcriber: {
      polish: (text) => transcriber.polish(text),
      dispose: () => transcriber.dispose(),
    },
  }
}

test('the cleanup asks the route not to reason, and keeps the answer', async () => {
  const { transcriber, requests } = await buildTranscriber([answerWith(CLEANED)])
  try {
    assert.equal(await transcriber.polish(RAW), CLEANED)
  } finally {
    transcriber.dispose()
  }

  assert.equal(requests.length, 1, 'exactly one cleanup call')
  const request = requests[0]
  // The whole point: naming no effort is what made this slow, because the
  // adapter substitutes `high` and the plugin cannot render reasoning deltas.
  assert.equal(request.reasoningEffort, 'off', 'the cleanup must not spend reasoning tokens')
  assert.equal(request.provider, 'deepseek-official')
  assert.equal(request.model, 'deepseek-flash')
  assert.equal(request.temperature, 0, 'a cleanup is not a creative task')
  assert.equal(request.messages.length, 1)
  assert.equal(request.messages[0].content[0].text, RAW, 'the recognizer text is the request')
  assert.equal(request.messages[0].source.plugin, 'dsh-voice-input')
  assert.ok(typeof request.system === 'string' && request.system.length > 0, 'the constraints ship with it')
  // Tools would invite the model to answer the transcript instead of cleaning it.
  assert.equal(request.tools, undefined)
})

test('a route that cannot refuse reasoning still gets its transcript cleaned', async () => {
  const { transcriber, requests } = await buildTranscriber([REFUSES_EFFORT, answerWith(CLEANED)])
  let cleaned
  try {
    cleaned = await transcriber.polish(RAW)
  } finally {
    transcriber.dispose()
  }

  assert.equal(cleaned, CLEANED, 'the retry must produce the cleaned text')
  assert.equal(requests.length, 2, 'one attempt per effort, and no more')
  assert.equal(requests[0].reasoningEffort, 'off')
  // Omitting the key is what restores inherit-the-deployment-default.
  assert.ok(!('reasoningEffort' in requests[1]), 'the retry must name no effort at all')
})

test('conservative-reasoned restores the inherit-the-default behaviour', async () => {
  const { transcriber, requests } = await buildTranscriber([answerWith(CLEANED)], { polish: 'conservative-reasoned' })
  try {
    assert.equal(await transcriber.polish(RAW), CLEANED)
  } finally {
    transcriber.dispose()
  }
  assert.equal(requests.length, 1)
  assert.ok(!('reasoningEffort' in requests[0]), 'the escape hatch must not name an effort')
})

test('polish off makes no call at all', async () => {
  const { transcriber, requests } = await buildTranscriber([answerWith(CLEANED)], { polish: 'off' })
  try {
    assert.equal(await transcriber.polish(RAW), undefined, 'off returns the recognizer text')
  } finally {
    transcriber.dispose()
  }
  assert.equal(requests.length, 0, 'off must not reach the network')
})

test('the safety rails still hold around the new request shape', async () => {
  const empty = await buildTranscriber([answerWith('')])
  try {
    assert.equal(await empty.transcriber.polish(RAW), undefined, 'an empty cleanup keeps the raw text')
  } finally {
    empty.transcriber.dispose()
  }

  const runaway = await buildTranscriber([answerWith('x'.repeat(400))])
  try {
    assert.equal(await runaway.transcriber.polish(RAW), undefined, 'a 421% rewrite keeps the raw text')
  } finally {
    runaway.transcriber.dispose()
  }

  // Inside the 0.5-1.8 band, and deliberately not CLEANED: a result equal to the
  // other cases' text would prove a cached answer rather than this call's.
  const plausible = 'Can you please refactor the parser, and then run the tests?'
  const kept = await buildTranscriber([answerWith(plausible)])
  try {
    assert.equal(await kept.transcriber.polish(RAW), plausible, 'a plausible rewrite is kept')
  } finally {
    kept.transcriber.dispose()
  }
})

test('the config contract names the reasoning effort and rejects a typo', async () => {
  const { Config } = await freshEngine()
  const validate = Config['~standard'].validate

  assert.equal(validate({}).value.polishReasoning, 'off', 'reasoning is off unless asked for')
  assert.equal(validate({ polishReasoning: 'high' }).issues, undefined, 'a named effort is accepted')
  // A typo would otherwise reach the runtime as one failed call per recording,
  // which reads as a provider fault rather than a configuration mistake.
  const typo = validate({ polishReasoning: 'ultra' })
  assert.equal(typo.value, undefined)
  assert.match(typo.issues[0].message, /polishReasoning must be one of/)

  for (const mode of ['off', 'conservative', 'conservative-reasoned']) {
    assert.equal(validate({ polish: mode }).issues, undefined, `${mode} must be accepted`)
  }
  assert.notEqual(validate({ polish: 'rewrite' }).issues, undefined, 'an unknown mode is rejected')
})

test('the shipped config layer documents the switch', () => {
  const patch = readFileSync(join(PACKAGE_DIR, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes('polishReasoning: off'), 'the layer must ship the effort explicitly')
  for (const mode of ['conservative-reasoned', 'off']) {
    assert.ok(patch.includes(mode), `the layer must document \`${mode}\``)
  }
})

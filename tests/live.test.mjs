/**
 * The live view's wiring, asserted where it can be asserted without a browser.
 *
 * The behaviour itself is covered by `vad.test.mjs` (when is the user speaking)
 * and by driving the route by hand. What is checked here is the part a browser
 * cannot tell you about until it is too late: that the two halves agree on the
 * route, that the recorder actually produces a stream of pieces to decode, and
 * that a live peek never pays for a cleanup it is about to discard.
 *
 * @module dsh-voice-input/tests/live
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (name) => readFileSync(join(PACKAGE_DIR, name), 'utf8')

test('both halves agree on the live-view route', async () => {
  const host = await import(`${join(PACKAGE_DIR, 'index.mjs').replace(/\\/g, '/')}`.replace(/^/, 'file:///'))
  const client = read('client.cjs')
  assert.equal(host.VOICE_INPUT_SEGMENT_ROUTE, '/voice-input/segment')
  assert.ok(
    client.includes(`const SEGMENT_ROUTE = '/voice-input/segment'`),
    'the client must post to the route the host serves',
  )
  // The host registers it, or the client would post into a 404.
  assert.ok(host.apply !== undefined)
  const hostSource = read('index.mjs')
  assert.ok(hostSource.includes('path: VOICE_INPUT_SEGMENT_ROUTE'), 'the segment route must be registered')
})

test('a live peek is decoded without the cleanup pass', () => {
  const host = read('index.mjs')
  // A peek is replaced by the next peek and finally by the full pass, so
  // cleaning it would spend the user's model budget on discarded text.
  assert.ok(
    /transcriber\.run\(bytes, \{ polish: false \}\)/.test(host),
    'the segment route must disable polish for its peek',
  )
})

test('the recorder produces pieces, not one blob at the end', () => {
  const client = read('client.cjs')
  // Without a timeslice the browser hands over everything at `stop`, which is
  // exactly the behaviour that left the draft empty until the button was pressed.
  assert.ok(/recorder\.start\(CHUNK_MS\)/.test(client), 'the recorder must be started with a timeslice')
  const chunkMs = /const CHUNK_MS = (\d+)/.exec(client)
  assert.ok(chunkMs !== null, 'CHUNK_MS must be declared')
  assert.ok(Number(chunkMs[1]) <= 2000, `a timeslice of ${chunkMs?.[1]} ms is too long to feel live`)
})

test('the live view carries the tested span detector', () => {
  const client = read('client.cjs')
  assert.ok(client.includes('BEGIN INLINED lib/vad.mjs'), 'the bundle must carry the detector')
  assert.ok(client.includes('class VoiceActivityDetector'), 'and it must be the real one')
  assert.ok(client.includes('detector.observe(rms)'), 'the detector must be fed the raw level')
  // The peek is driven by a TIMER, not by the detector. Waiting for a detected
  // pause made the live view depend on an estimate of the room, and a hum above
  // the gate read as endless speech — so no pause was ever found and nothing was
  // ever sent. A rolling window of audio needs to know nothing about the room.
  assert.ok(client.includes('requestPeek()'), 'a new chunk of audio must ask for a peek')
  assert.ok(
    /ondataavailable[\s\S]{0,2000}requestPeek\(\)/.test(client),
    'the peek must be triggered where the audio actually arrives',
  )
  // The detector still feeds the muted-microphone hint, which is the one thing
  // it is still trusted for.
  assert.ok(client.includes('detector.snapshot()'), 'the status line still reports the detector')
  // A package subpath is not a specifier the client-module loader answers, so
  // requiring one would throw while the bundle loaded and take the button with it.
  assert.ok(
    !/require\('dsh-voice-input/.test(client),
    'the bundle must not require a subpath of its own package',
  )
})

test('the inlined detector matches its module', () => {
  // The module is the single source of truth; the bundle carries a mechanical
  // copy of it. If they drift, the behaviour the tests prove is not the
  // behaviour the browser runs, which is the worst of both.
  const client = read('client.cjs')
  const module = read('lib/vad.mjs')
  const begin = client.indexOf('// --- BEGIN INLINED lib/vad.mjs')
  const end = client.indexOf('// --- END INLINED lib/vad.mjs')
  assert.ok(begin !== -1 && end > begin, 'the markers must be present')
  const inlined = client.slice(begin, end)
  // Every line of code the module defines must appear in the bundle, modulo the
  // `export` keyword the transform removes and the indentation it adds.
  const significant = module
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('*') && !line.startsWith('/*') && !line.startsWith('//'))
    .map((line) => (line.startsWith('export ') ? line.slice(7) : line))
  const missing = significant.filter((line) => !inlined.includes(line))
  assert.deepEqual(
    missing.slice(0, 5),
    [],
    `the bundle is stale: run \`node tools/inline-vad.mjs\` (${missing.length} line(s) out of date)`,
  )
})

test('the caret marks work in flight and is removable', () => {
  const client = read('client.cjs')
  assert.ok(client.includes('dsh-voice-caret-pulse'), 'the caret must pulse')
  assert.ok(client.includes('CARET'), 'the caret must be a named marker')
  // It is withdrawn with the live text, or the draft would keep a stray glyph.
  assert.ok(/removeLiveText/.test(client), 'the live text must be removable in one operation')
  assert.ok(
    /split\(CARET\)\.join\(''\)/.test(client),
    'removing the live text must remove its caret too',
  )
})

test('the final pass is authoritative over every peek', () => {
  const client = read('client.cjs')
  // The pre-polish live text is withdrawn before the final pass writes, so the
  // draft cannot end up carrying the same words twice.
  const finishIndex = client.indexOf('const base = finishLive()')
  const streamIndex = client.indexOf('accept: \'application/x-ndjson\'')
  assert.ok(finishIndex !== -1, 'the live text must be withdrawn before the final pass')
  assert.ok(streamIndex > finishIndex, 'the withdrawal must happen before the request is sent')
})

test('the packaged files carry what the client needs', () => {
  const manifest = JSON.parse(read('package.json'))
  assert.ok(manifest.files.includes('lib/vad.mjs'), 'the client requires it, so it must ship')
  assert.equal(manifest.exports['./lib/vad.mjs'], './lib/vad.mjs', 'and it must be exportable')
})

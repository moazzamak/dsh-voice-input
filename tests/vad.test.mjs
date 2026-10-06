/**
 * The span detector, driven by synthetic levels so each behaviour is a fact
 * rather than a hope.
 *
 * The levels below are LINEAR RMS, matching what the composer's meter computes.
 * Quiet speech at a normal distance sits near 0.02-0.15; a room with a fridge
 * or a fan running sits somewhere above a silent room but below speech, which is
 * exactly the case a fixed threshold cannot handle.
 *
 * @module dsh-voice-input/tests/vad
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  VoiceActivityDetector,
  MIN_SPEECH_MS,
  PREROLL_MS,
  SILENCE_END_TICKS,
  SPEECH_START_TICKS,
  TICK_MS,
} from '../lib/vad.mjs'

const SILENT_ROOM = 0.0006
const HUMMING_ROOM = 0.02
const SPEAKING = 0.09

/**
 * Drive one detector through a sequence of levels.
 *
 * `observe` is always called first, then `advance` — the same order the client
 * uses, and the order the floor tracking depends on.
 *
 * @param {number[]} levels - one level per tick.
 * @param {object} [options] - detector overrides.
 * @returns {{ events: object[], detector: VoiceActivityDetector }}
 */
function drive(levels, options = {}) {
  const detector = new VoiceActivityDetector(options)
  const events = []
  for (const level of levels) {
    detector.observe(level)
    const event = detector.advance()
    if (event !== null) events.push(event)
  }
  return { events, detector }
}

/** `count` ticks at one level. */
const ticks = (level, count) => new Array(count).fill(level)

/** Level of the `index`-th tick of a quiet room, jittering around `base`. */
const quiet = (index, base) => base * (1 + ((index * 37) % 7) * 0.01)

/** Level of the `index`-th tick of speech, jittering around `base`. */
const loud = (index, base) => base * (1 + ((index * 53) % 9) * 0.02)

/** A quiet room: `count` jittering ticks around `floor`. */
const room = (floor, count) => Array.from({ length: count }, (_, index) => quiet(index, floor))

/** Speech: `count` jittering ticks around `level`. */
const speech = (level, count) => Array.from({ length: count }, (_, index) => loud(index, level))

test('a silent room never opens a span', () => {
  const { events } = drive(room(SILENT_ROOM, 200))
  assert.deepEqual(events, [], 'nothing was said, so nothing may be transcribed')
})

test('a hum above the old fixed threshold does not read as speech', () => {
  // This is the case the previous rule could not survive: `rms <= 0.1` counted
  // a fridge as silence and `rms > 0.1` counted it as speech. Neither is
  // possible here, because the gate is measured from the room itself.
  const { events, detector } = drive([
    ...room(HUMMING_ROOM, 200),
  ])
  assert.deepEqual(events, [], 'a steady hum must never open a span')
  assert.ok(
    detector.noiseFloor > 0.01,
    `the floor must rise to the room, got ${detector.noiseFloor}`,
  )
})

test('an utterance in a humming room opens and closes exactly once', () => {
  const { events } = drive([
    ...room(HUMMING_ROOM, 100),      // the room, measured
    ...speech(SPEAKING, 60),          // three seconds of speech
    ...room(HUMMING_ROOM, 100),      // a pause long enough to close the span
  ])
  assert.equal(events.length, 2, `expected start+end, got ${JSON.stringify(events)}`)
  assert.equal(events[0].type, 'start')
  assert.equal(events[1].type, 'end')
  // The span cannot count the ticks that went into deciding it had begun, so it
  // reports at most SPEECH_START_TICKS less than the audio actually spoken.
  assert.ok(
    events[1].speechMs >= 3000 - SPEECH_START_TICKS * TICK_MS,
    `the span must cover the speech it heard, got ${events[1].speechMs} ms`,
  )
})

test('speech opens the span and reports how far back to look', () => {
  const { events } = drive([
    ...room(SILENT_ROOM, 100),
    ...speech(SPEAKING, 40),
    ...room(SILENT_ROOM, 100),
  ])
  const start = events.find((event) => event.type === 'start')
  assert.ok(start !== undefined, 'speech must open a span')
  // The first phoneme happens before the detector can be sure, so the caller is
  // always asked for the configured pre-roll — it holds the audio either way.
  assert.equal(start.prerollMs, PREROLL_MS)
  assert.ok(start.prerollMs >= SPEECH_START_TICKS * TICK_MS, 'pre-roll must cover the decision ticks')
})

test('a breath inside a sentence does not split it', () => {
  const { events } = drive([
    ...room(SILENT_ROOM, 100),
    ...speech(SPEAKING, 40),
    ...room(SILENT_ROOM, 5),          // a breath: well under SILENCE_END_TICKS
    ...speech(SPEAKING, 40),
    ...room(SILENT_ROOM, 100),
  ])
  const ends = events.filter((event) => event.type === 'end')
  assert.equal(ends.length, 1, `a breath must not close the span: ${JSON.stringify(events)}`)
  // `speechMs` counts SPEECH, so the breath is deliberately excluded from it:
  // two 2 s halves around a 250 ms breath report just under 4 s, and that is the
  // honest number for a field that says how much was said.
  assert.ok(
    ends[0].speechMs >= 4000 - 5 * TICK_MS - SPEECH_START_TICKS * TICK_MS,
    `both halves belong to the one span, got ${ends[0].speechMs} ms`,
  )
})

test('a click is not speech', () => {
  const { events } = drive([
    ...room(SILENT_ROOM, 100),
    ...speech(SPEAKING, 3),           // 150 ms: a click, a cough, a door
    ...room(SILENT_ROOM, 100),
  ])
  assert.deepEqual(events, [], 'a blip costs a decode and returns nothing or an invention')
})

test('unbroken speech is never cut, and no floor is learned from it', () => {
  const { events, detector } = drive(speech(0.5, 200))
  const ends = events.filter((event) => event.type === 'end')
  assert.deepEqual(ends, [], 'a span must not be closed while the user is still speaking')
  assert.ok(
    detector.noiseFloor <= 0.3,
    `speech must not raise the floor to the speech level, got ${detector.noiseFloor}`,
  )
})

test('a quieter room lowers the floor again, so the gate reopens', () => {
  const loud = drive(room(HUMMING_ROOM, 120)).detector
  const level = loud.noiseFloor
  const quiet = drive([
    ...room(HUMMING_ROOM, 60),
    ...room(SILENT_ROOM, 120),
  ]).detector
  assert.ok(
    quiet.noiseFloor < level,
    `the floor must follow the room down (was ${level}, now ${quiet.noiseFloor})`,
  )
})

test('span timing is measured, not guessed', () => {
  const speechTicks = 100
  const { events } = drive([
    ...room(SILENT_ROOM, 100),
    ...ticks(SPEAKING, speechTicks),
    ...room(SILENT_ROOM, 100),
  ])
  const end = events.find((event) => event.type === 'end')
  assert.ok(end !== undefined, 'the span must close')
  const reported = end.speechMs
  const actual = speechTicks * TICK_MS
  assert.ok(
    Math.abs(reported - actual) <= (SPEECH_START_TICKS + SILENCE_END_TICKS) * TICK_MS,
    `reported ${reported} ms for ${actual} ms of speech`,
  )
  assert.ok(reported >= MIN_SPEECH_MS)
})

test('the gate never closes on a muted microphone', () => {
  // A muted or absent input reads as pure zero. Without a lower bound on the
  // floor the gate would become zero too, and every tick would count as speech.
  const { events, detector } = drive(ticks(0, 100))
  assert.deepEqual(events, [], 'silence is not speech')
  assert.ok(detector.gate > 0, 'the gate must stay above zero')
  assert.ok(detector.noiseFloor > 0, 'the floor must stay above zero')
})

test('a hum louder than the gate is counted as speech, and that no longer matters', () => {
  // A KNOWN LIMITATION, pinned here so nobody rediscovers it as a bug.
  //
  // The gate is derived from a floor the detector estimates, and that estimate
  // can sit below the room: a quiet moment seeds it, or the room's hum is simply
  // louder than the quietest thing it ever heard. A hum ABOVE the gate is then
  // indistinguishable from a voice, no silence is ever seen, and the span never
  // closes.
  //
  // This was fatal when a closed span was what triggered transcription: the user
  // talked, paused, and nothing was ever sent, with no error to explain it. The
  // live view no longer asks the detector anything — it submits a rolling window
  // of audio on a timer — so a span that never closes costs nothing. What relies
  // on the detector now is only the muted-microphone hint, and that reads the
  // level directly rather than the span state.
  const { events, detector } = drive([
    ...room(SILENT_ROOM, 100),
    ...speech(SPEAKING, 60),
    ...room(0.012, 200),            // a hum well above the gate
  ])
  const ends = events.filter((event) => event.type === 'end')
  assert.equal(ends.length, 0, 'the detector cannot close this span - the live view must not depend on it')
  assert.ok(detector.speaking, 'and it still believes someone is talking')
  assert.ok(detector.gate < 0.012, `the hum is above the gate (${detector.gate.toFixed(4)})`)
})







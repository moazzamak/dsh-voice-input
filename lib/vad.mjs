/**
 * When is the user speaking, and when is the room merely humming?
 *
 * This is the piece that decides where one spoken span ends and the next
 * begins, and everything downstream depends on its answers: a live transcript
 * can only appear early if spans are closed early, and it can only be trusted
 * if spans are closed at SILENCE rather than mid-word. A prefix of a recording
 * that is cut inside a word does not fail loudly — the recognizer invents a
 * plausible ending for it, which is worse, because it reads like something the
 * user said.
 *
 * The hard part is not detecting loudness but knowing what quiet LOOKS like on
 * this machine. A fixed threshold (`rms > 0.1`) is defeated by any constant
 * hum: a fridge, a fan, a laptop under load all sit above it permanently, so
 * speech never stands out and no span ever closes. This module therefore tracks
 * the room's own noise floor and compares against that instead.
 *
 * Pure logic on purpose: no DOM, no timers, no audio objects. The caller feeds
 * it one level per tick — which the composer already computes at 20 Hz for its
 * meter — so the whole decision surface is testable in Node, and the browser
 * half stays a thin adapter over it.
 *
 * @module dsh-voice-input/vad
 */

/** How often the caller reports a level. 50 ms = the composer's meter cadence. */
export const TICK_MS = 50

/** Levels sampled over one baseline window (2 s at 20 Hz). */
export const BASELINE_WINDOW = 40

/**
 * Consecutive loud levels that start a span (~200 ms).
 *
 * Long enough that a keyboard click, a cough, or a door never opens one; short
 * enough that the first syllable is not waiting on it.
 */
export const SPEECH_START_TICKS = 4

/**
 * Consecutive quiet levels that close a span (~500 ms).
 *
 * Natural pauses inside a sentence are shorter than this, so a breath does not
 * end a span; a real pause between instructions is longer, so it does.
 */
export const SILENCE_END_TICKS = 10

/** A span quieter than this is a blip, not speech, and is dropped. */
export const MIN_SPEECH_MS = 300

/**
 * Audio kept from BEFORE the span opened (~400 ms).
 *
 * The detector only knows speech began after it has heard a few loud ticks, by
 * which time the first phoneme is already in the past. Without this the
 * transcript would start mid-word.
 */
export const PREROLL_MS = 400

/** How far above the noise floor speech must rise to count (~+7 dB). */
const GATE_FACTOR = 2.6

/**
 * How near the floor a level must fall to count as silence again (~+1 dB).
 *
 * Deliberately just above the floor rather than a comfortable margin above it.
 * When the floor has been corrected onto a room's hum, the hum IS the quiet
 * level, so a "well below speech" margin would sit above the hum and the span
 * would never be seen to end.
 */
const REARM_FACTOR = 1.1

/**
 * Levels used for the first measurement, before any adaptive tracking (~1 s).
 *
 * Deliberately long: calibration ticks are the quietest the detector will ever
 * see on a real recording, because the microphone is opened moments earlier and
 * nobody speaks into a button they have just pressed. Seeding from too few of
 * them anchors the floor BELOW the room, and every later measurement then looks
 * like speech.
 */
const CALIBRATION_TICKS = 20

/** The floor never drops below this, so a muted microphone cannot zero the gate. */
const FLOOR_FLOOR = 0.0008

/**
 * Where the floor starts, before this room has been measured (~-34 dBFS).
 *
 * It must sit ABOVE a quiet room and BELOW speech, and both bounds matter:
 *
 *   too low   a steady hum counts as speech from the first tick. Speech is what
 *             suppresses floor learning, so the detector then cannot measure the
 *             hum it is mishearing, and the mistake is self-sustaining.
 *   too high  ordinary speech never reaches the gate and no span ever opens.
 *
 * A quiet room reads around 0.0005-0.002 and speech around 0.02-0.15, so the
 * gap between them is wide and this sits in the middle of it. It is a starting
 * point, not the decision rule — one window of real ambience replaces it, in
 * either direction.
 */
const FLOOR_START = 0.004

/** Absolute ceiling on the floor, so a noisy room cannot gate out real speech. */
const FLOOR_CEILING = 0.08

/**
 * How uniform a window must be to count as ambience.
 *
 * Tight on purpose. A window is only evidence about the room if nothing in it
 * moved much, and the margin has to be small enough that the natural variation
 * WITHIN speech — a syllable to syllable swing of tens of percent — disqualifies
 * it. Measured against speech that jitters by 16%, a band of 1.6 accepts it and
 * the floor climbs onto the speaker's own voice; the gate then rises above them
 * and every span stays open forever.
 */
const QUIET_BAND = 1.2

/**
 * Tracks one room's noise floor and reports where speech spans begin and end.
 *
 * Feed it `observe` then `advance` once per tick, in that order, with the level
 * the meter already computed.
 */
export class VoiceActivityDetector {
  /**
   * @param {object} [options] - tuning overrides, mainly for tests.
   * @param {number} [options.tickMs] - length of one tick in milliseconds.
   */
  constructor(options = {}) {
    this.tickMs = options.tickMs ?? TICK_MS
    /** The room's own level, in the same linear RMS units as the meter. */
    this.noiseFloor = FLOOR_START
    /** True once speech is loud enough to have opened a span. */
    this.speaking = false
    /** Levels seen since the current span opened, as an approximate duration. */
    this.speechTicks = 0
    /** True while the opening calibration is still gathering its sample. */
    this.calibrating = true

    this._window = new Float64Array(BASELINE_WINDOW)
    this._windowCount = 0
    this._windowNext = 0
    this._calibrationSum = 0
    this._calibrationCount = 0
    this._loudTicks = 0
    this._quietTicks = 0
    this._latest = 0
  }

  /** The level at which a span opens. Always above the floor by `GATE_FACTOR`. */
  get gate() {
    return Math.max(this.noiseFloor * GATE_FACTOR, FLOOR_FLOOR * GATE_FACTOR)
  }

  /** The level a span must fall back to before its silence count starts. */
  get rearm() {
    return Math.max(this.noiseFloor * REARM_FACTOR, FLOOR_FLOOR)
  }

  /**
   * Record this tick's level and refine the noise floor.
   *
   * The floor is derived from the smallest level in a trailing window rather
   * than from an average: speech raises an average permanently, so an
   * average-based floor drifts up during a long instruction and the gate closes
   * on the speaker. The minimum is untouched by speech, because speech only
   * ever makes the window louder.
   *
   * @param {number} level - this tick's linear RMS level.
   */
  observe(level) {
    const value = Number.isFinite(level) && level > 0 ? level : 0
    this._latest = value

    // Seed during the opening ticks, so the gate is meaningful immediately
    // rather than after a full window of speech has already gone by.
    if (this.calibrating) {
      this._calibrationCount += 1
      this._calibrationSum = this._calibrationCount === 1
        ? value
        : Math.min(this._calibrationSum, value)
      if (this._calibrationCount >= CALIBRATION_TICKS) {
        this.calibrating = false
        this._seedFloor(this._calibrationSum)
      }
    }

    this._window[this._windowNext] = value
    this._windowNext = (this._windowNext + 1) % BASELINE_WINDOW
    if (this._windowCount < BASELINE_WINDOW) {
      this._windowCount += 1
      return
    }

    let quietest = Infinity
    let loudest = 0
    for (let index = 0; index < BASELINE_WINDOW; index += 1) {
      const sample = this._window[index]
      if (sample < quietest) quietest = sample
      if (sample > loudest) loudest = sample
    }
    // A measurement is trusted only when the WHOLE window is ambience: every
    // level in it within `QUIET_BAND` of its quietest. A window containing speech
    // is refused, because its quietest level is a pause between words, and
    // adopting that would teach the detector that the speaker's voice is the room.
    const isPureAmbience = loudest <= quietest * QUIET_BAND
    if (!isPureAmbience) return
    // While a span is open, a measurement may only LOWER the floor. Speech can
    // never lower it, so this cannot be abused by a speaker, and it is the one
    // correction that matters: a floor left too high by an earlier loud room
    // would otherwise hold the gate above the speaker and no span would ever
    // open. Raising it while a span is open is forbidden — the gate is what
    // decides the speaker has stopped, so a gate lifted onto their own voice
    // would never let a span close.
    if (this.speaking) {
      if (quietest < this.noiseFloor) this._seedFloor(quietest)
      return
    }
    this._seedFloor(quietest)
  }

  /**
   * Advance the state machine one tick and report a span boundary.
   *
   * @returns {{ type: 'start', prerollMs: number } | { type: 'end', speechMs: number } | null}
   *   `start` when a span opened, `end` when one closed with enough speech to be
   *   worth transcribing, otherwise `null`.
   */
  advance() {
    // No span may open before the room has been measured. Otherwise the very
    // first loud ticks — which arrive while the floor is still its placeholder —
    // open a span against a floor that means nothing, and a span that opens too
    // early also freezes floor learning, so the mistake becomes permanent.
    if (this.calibrating) return null
    // Nothing is decided until the floor has had one full window of the room to
    // correct itself against. Speech cannot be told from a steady hum before
    // then, and a span opened in that window opens against a floor that is still
    // a guess.
    if (this._windowCount < BASELINE_WINDOW) return null

    if (this._latest >= this.gate) {
      this._quietTicks = 0
      if (!this.speaking) {
        this._loudTicks += 1
        if (this._loudTicks >= SPEECH_START_TICKS) {
          this.speaking = true
          this._loudTicks = 0
          this.speechTicks = 0
          // The span reached back into the ticks already spent deciding, and the
          // caller is asked for the configured pre-roll regardless — it has the
          // audio buffered either way, and the extra is trimmed at the cut.
          return { type: 'start', prerollMs: Math.max(PREROLL_MS, SPEECH_START_TICKS * this.tickMs) }
        }
      } else {
        this.speechTicks += 1
      }
      return null
    }

    this._loudTicks = 0
    if (!this.speaking) return null

    // Only ticks that are still loud enough to be speech are counted, so the
    // reported duration is the SPOKEN part. Counting the closing silence too
    // would add `SILENCE_END_TICKS` to every span, which for a short utterance is
    // the difference between clearing the minimum and being discarded as a blip.
    if (this._latest >= this.rearm) {
      this.speechTicks += 1
      // Sound came back, so the pause did not end the span. Without this reset a
      // speaker's own breaths accumulate: a sentence with a few natural pauses
      // would reach the closing threshold and be cut into pieces even though the
      // user never stopped talking.
      this._quietTicks = 0
      return null
    }
    this._quietTicks += 1
    if (this._quietTicks < SILENCE_END_TICKS) return null

    const speechMs = this.speechTicks * this.tickMs
    this.speaking = false
    this._quietTicks = 0
    this.speechTicks = 0
    // Too short to be speech: a click, a cough, or a door. Dropped rather than
    // transcribed, because a lone blip costs a whole decode and returns either
    // nothing or an invention.
    if (speechMs < MIN_SPEECH_MS) return null
    return { type: 'end', speechMs }
  }

  /** Current state, for the client's indicator and for tests. */
  snapshot() {
    return {
      noiseFloor: this.noiseFloor,
      gate: this.gate,
      speaking: this.speaking,
      calibrating: this.calibrating,
    }
  }

  /**
   * Adopt a measured room level.
   *
   * Asymmetric on purpose. Downward is applied at once, because the room really
   * did get quieter and hearing that promptly is what reopens the gate after a
   * fan switches off. Upward is smoothed and bounded, so a stretch of speech
   * that slipped past the gate cannot ratchet the floor up in one step and
   * deafen the detector to the speaker it is listening to.
   *
   * @param {number} measured - the quietest level of an accepted window.
   */
  _seedFloor(measured) {
    const bounded = Math.min(Math.max(measured, FLOOR_FLOOR), FLOOR_CEILING)
    if (bounded < this.noiseFloor) {
      this.noiseFloor = bounded
      return
    }
    // Above the current floor: converge toward it, but never past the ceiling
    // that keeps a loud room from gating out real speech.
    const blended = this.noiseFloor * 0.7 + bounded * 0.3
    this.noiseFloor = Math.min(blended, FLOOR_CEILING)
  }
}

/**
 * Absolute-RMS floor used when no adaptive measurement is available yet.
 *
 * Speech at a normal distance sits near 0.02-0.15 linear RMS, so this is the
 * "obviously quiet" line — it is a starting point, never the decision rule.
 */
export const DEFAULT_NOISE_FLOOR = 0.005


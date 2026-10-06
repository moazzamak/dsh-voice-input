/**
 * LocalAgreement: turn a stream of full-recording hypotheses into stable text.
 *
 * A batch recogniser applied to a growing recording does not produce a stream of
 * settled words. Each pass re-reads everything it is given, so the tail of every
 * hypothesis is a guess that the next pass may revise — and a draft built from
 * those guesses visibly rewrites itself as the user talks.
 *
 * The established answer, from `whisper_streaming` (Macháček et al., IJCNLP 2023
 * demo), is to show a word only once consecutive hypotheses AGREE on it. The
 * longest common word prefix of the last two hypotheses is confirmed; everything
 * after it is withheld. Confirmed text never changes, so the draft only ever
 * grows, and the tail that would have flickered is simply not shown yet.
 *
 * This is pure logic — no audio, no network, no timers — because it is the part
 * where a mistake is invisible in the UI: text that is merely *different* looks
 * like text that is *wrong*, and neither throws.
 *
 * @module dsh-voice-input/local-agreement
 */

/**
 * How many consecutive hypotheses must agree before their shared prefix is shown.
 *
 * Two is the reference default (`LocalAgreement-2`) and the value its authors
 * recommend: one hypothesis is a guess, and requiring three costs a full extra
 * pass of latency for a difference nobody can hear.
 */
export const MIN_AGREEMENT = 2

/**
 * Split a transcript into comparable words.
 *
 * Case and surrounding punctuation are ignored when COMPARING, because the
 * recogniser's punctuation of the same word is not stable between passes, and
 * treating "cache." and "cache" as different words would withhold text that is
 * in fact settled. The original spelling of whichever hypothesis is shown is
 * kept for display.
 *
 * @param {string} text - one hypothesis.
 * @returns {string[]} its words.
 */
function words(text) {
  return text.trim() === '' ? [] : text.trim().split(/\s+/u)
}

/**
 * The key two words must share to count as the same word.
 *
 * @param {string} word - one word.
 * @returns {string} its comparison form.
 */
function key(word) {
  return word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}

/**
 * Longest common prefix of two hypotheses, in words.
 *
 * @param {string[]} a - earlier hypothesis.
 * @param {string[]} b - later hypothesis.
 * @returns {string[]} the shared leading words, in `a`'s spelling.
 */
export function commonPrefix(a, b) {
  const shared = []
  const limit = Math.min(a.length, b.length)
  for (let index = 0; index < limit; index += 1) {
    if (key(a[index]) !== key(b[index]) || key(a[index]) === '') break
    shared.push(a[index])
  }
  return shared
}

/**
 * Accumulates hypotheses and reports what is safe to show.
 *
 * Usage: call {@link LocalAgreement#push} with each full transcript of the audio
 * so far, then render `result.confirmed + result.pending` — or render only
 * `confirmed` for text that will never change.
 */
export class LocalAgreement {
  /**
   * @param {object} [options] - tuning overrides, mainly for tests.
   * @param {number} [options.minAgreement] - hypotheses that must agree.
   */
  constructor(options = {}) {
    this.minAgreement = options.minAgreement ?? MIN_AGREEMENT
    /** Text every recent hypothesis agreed on. Never revised. */
    this.confirmed = ''
    /** The tail of the newest hypothesis, still liable to change. */
    this.pending = ''
    this._history = []
  }

  /**
   * Offer one new hypothesis and learn what is now settled.
   *
   * @param {string} hypothesis - the full transcript of the audio so far.
   * @returns {{ confirmed: string, pending: string, changed: boolean }}
   *   `confirmed` is settled text, `pending` is what the newest pass guessed
   *   beyond it, and `changed` says whether the draft needs rewriting at all.
   */
  push(hypothesis) {
    const next = typeof hypothesis === 'string' ? hypothesis.trim() : ''
    this._history.push(words(next))
    // Only the last `minAgreement` hypotheses can confirm anything, so older ones
    // are dropped: keeping them would grow without bound and could never change
    // an answer.
    if (this._history.length > this.minAgreement) this._history.shift()

    if (this._history.length >= this.minAgreement) {
      let agreed = this._history[0]
      for (const other of this._history.slice(1)) {
        agreed = commonPrefix(agreed, other)
        if (agreed.length === 0) break
      }
      const agreedText = agreed.join(' ')
      // The boundary only ever moves forward. A later pass that agrees on LESS
      // than an earlier one has not un-said anything the user already read; it
      // has merely lost confidence in a word that was already settled, and
      // withdrawing text the user has seen is worse than keeping it.
      if (agreedText.length > this.confirmed.length) this.confirmed = agreedText
      // A confirmation means the next pass starts from a fresh pair, so the
      // history is emptied exactly as the reference implementation does.
      if (agreedText !== '') this._history = [words(next)]
    }

    const confirmedWords = words(this.confirmed)
    const nextWords = words(next)
    this.pending = nextWords.slice(confirmedWords.length).join(' ')
    return {
      confirmed: this.confirmed,
      pending: this.pending,
      changed: true,
    }
  }

  /**
   * The text to show: settled words, then the newest guess beyond them.
   *
   * @returns {string} the displayable transcript.
   */
  text() {
    return [this.confirmed, this.pending].filter((part) => part !== '').join(' ')
  }

  /**
   * Take a final transcript as the whole truth and stop accumulating.
   *
   * The finished recording is transcribed in one pass, which is strictly better
   * information than any hypothesis the stream produced: it saw all the audio at
   * once. Whatever it says replaces everything — confirmed and pending alike —
   * so a word the stream settled on wrongly does not survive.
   *
   * @param {string} finalText - the transcript of the complete recording.
   * @returns {string} that text.
   */
  settle(finalText) {
    const text = typeof finalText === 'string' ? finalText.trim() : ''
    this.confirmed = text
    this.pending = ''
    this._history = []
    return text
  }
}

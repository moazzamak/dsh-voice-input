/**
 * LocalAgreement, tested on the behaviour that matters: what the user sees, and
 * whether it ever changes under them.
 *
 * The failure this guards against is not a crash. It is a draft that rewrites
 * itself: words appear, get replaced, and the sentence the user is reading stops
 * being the sentence they said. That is invisible to a type checker and looks
 * like nothing at all in a log, so it is pinned here instead.
 *
 * @module dsh-voice-input/tests/local-agreement
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LocalAgreement, commonPrefix, MIN_AGREEMENT } from '../lib/local-agreement.mjs'

test('nothing is shown until two hypotheses agree', () => {
  const agreement = new LocalAgreement()
  const first = agreement.push('please refactor the parser')
  assert.equal(first.confirmed, '', 'one hypothesis is a guess, not a settled word')
  assert.equal(agreement.text(), 'please refactor the parser', 'but it is still worth showing as pending')

  const second = agreement.push('please refactor the parser and run')
  assert.equal(second.confirmed, 'please refactor the parser', 'the shared prefix is now settled')
  assert.equal(second.pending, 'and run')
})

test('a word the second pass revises is never shown as settled', () => {
  const agreement = new LocalAgreement()
  agreement.push('open the cash folder')
  const result = agreement.push('open the cache folder')
  // "cash" and "cache" differ, so the agreement stops before them. This is the
  // whole point: the mishearing never reaches the draft as a settled word.
  assert.equal(result.confirmed, 'open the')
  assert.equal(result.pending, 'cache folder')
})

test('settled text is never withdrawn', () => {
  const agreement = new LocalAgreement()
  agreement.push('send the report to the team')
  agreement.push('send the report to the team today')
  const settled = agreement.confirmed
  assert.equal(settled, 'send the report to the team')

  // A later, worse pass must not take back words the user has already read.
  const later = agreement.push('send the report')
  assert.equal(later.confirmed, settled, 'confidence lost is not truth withdrawn')
  assert.ok(agreement.text().startsWith(settled))
})

test('the draft only ever grows', () => {
  const agreement = new LocalAgreement()
  // A deliberately noisy stream, as a real recogniser produces: the tail is
  // rewritten on almost every pass.
  const stream = [
    'the quick brown',
    'the quick brown fox',
    'the quick brown fox jumps',
    'the quick brown fox jumps over',
    'the quick brown fox jumps over the',
    'the quick brown fox jumps over the lazy',
    'the quick brown fox jumps over the lazy dog',
  ]
  let previous = ''
  for (const hypothesis of stream) {
    agreement.push(hypothesis)
    const shown = agreement.text()
    assert.ok(
      shown.length >= previous.length && shown.slice(0, previous.length) === previous,
      `the draft must only append: was "${previous}", now "${shown}"`,
    )
    previous = shown
  }
  assert.equal(previous, 'the quick brown fox jumps over the lazy dog')
})

test('the settled prefix survives punctuation and casing differences', () => {
  const agreement = new LocalAgreement()
  agreement.push('Run the tests, then commit.')
  const result = agreement.push('Run the tests then commit')
  // The recogniser's punctuation of the same words is not stable between passes.
  // Compared as words, these two hypotheses say the same thing, so all of it is
  // settled and none of it is withheld pending a third pass. Comparing raw
  // strings instead would have kept the whole sentence in the unstable tail.
  //
  // The shown words keep the EARLIER hypothesis's punctuation — the text the
  // user is already reading. Re-punctuating settled words would change
  // characters under them for no gain.
  assert.equal(result.confirmed, 'Run the tests, then commit.')
  assert.equal(result.pending, '')
})

test('a genuinely revised word stops the agreement there', () => {
  const agreement = new LocalAgreement()
  agreement.push('Run the tests')
  const result = agreement.push('Run the text')
  // "tests" and "text" are different words, so agreement stops before them and
  // the mishearing never reaches the draft as settled text.
  assert.equal(result.confirmed, 'Run the')
  assert.equal(result.pending, 'text')
})

test('a final transcript replaces everything, settled words included', () => {
  const agreement = new LocalAgreement()
  agreement.push('open the cash folder')
  agreement.push('open the cash folder now')
  assert.equal(agreement.confirmed, 'open the cash folder')

  // The whole recording, transcribed in one pass, is strictly better
  // information than any hypothesis the stream produced.
  const final = agreement.settle('open the cache folder now')
  assert.equal(final, 'open the cache folder now')
  assert.equal(agreement.text(), 'open the cache folder now', 'no trace of the mishearing remains')
  assert.equal(agreement.pending, '')
})

test('commonPrefix compares words, not characters', () => {
  assert.deepEqual(commonPrefix(['cache', 'cash'], ['cache', 'cashed']), ['cache'])
  assert.deepEqual(commonPrefix(['a', 'b'], ['a', 'c']), ['a'])
  assert.deepEqual(commonPrefix(['a'], ['b']), [])
  // A word made only of punctuation cannot agree with anything.
  assert.deepEqual(commonPrefix(['—'], ['—']), [])
})

test('the default agreement depth is the reference implementation s', () => {
  assert.equal(MIN_AGREEMENT, 2, 'LocalAgreement-2 is what whisper_streaming recommends')
})

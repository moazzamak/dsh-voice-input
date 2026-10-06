/**
 * The browser bundle must not reference a name it never declares.
 *
 * This exists because of a single typo: `flushPeek` read `heldRef.current` while
 * the ref was declared as `held`. One misspelled identifier, on the first line of
 * the only function the live view runs, and the result was:
 *
 *   - a ReferenceError on every call;
 *   - thrown inside a promise the caller discarded with `void`, so it surfaced
 *     nowhere a user could see it;
 *   - therefore no request, no draft text, no caret, and no error — a fully
 *     wired feature in exactly the state of one that had never been connected.
 *
 * It survived four rounds of investigation, and every test in this suite passed
 * throughout, because they all asserted on what the source TEXT contains. A
 * missing name is invisible to that kind of test: the string `heldRef` was
 * present, spelled consistently, and simply did not exist.
 *
 * So this test looks for references without declarations. It is a heuristic — a
 * real parser would need a dependency this bundle deliberately does not have —
 * and it is aimed at the mistake that actually happened: a ref-family name
 * written once.
 *
 * @module dsh-voice-input/tests/bundle-identifiers
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Names for which an undeclared reference is ALWAYS a bug.
 *
 * A misspelled local can only be caught by a parser; a misspelled *ref* is worth
 * catching by pattern, because the `-Ref` suffix is this bundle's own convention
 * and every one of them is declared with `React.useRef`.
 */
const REF_SUFFIX = /Ref$/

/** Every `name.current` / `name.` read in the source, with its line number. */
function referenceSites(source) {
  const sites = []
  source.split('\n').forEach((line, index) => {
    const code = line.replace(/\/\/.*$/, '').replace(/[^]*/g, '')
    // Skip the generated, inlined detector: it is verified against its module by
    // `live.test.mjs`, and its identifiers come from there.
    for (const match of code.matchAll(/\b([A-Za-z_$][\w$]*)\.(current|\w+)/g)) {
      sites.push({ name: match[1], line: index + 1, text: line.trim() })
    }
  })
  return sites
}

test('no ref-family name is used without being declared', () => {
  const source = readFileSync(join(PACKAGE_DIR, 'client.cjs'), 'utf8')
  const begin = source.indexOf('// --- BEGIN INLINED lib/vad.mjs')
  const end = source.indexOf('// --- END INLINED lib/vad.mjs')
  const hand = begin === -1 ? source : source.slice(0, begin) + source.slice(end)

  const declared = new Set()
  for (const match of hand.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(match[1])
  for (const match of hand.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) declared.add(match[1])
  // Destructuring and parameters, by name, since this bundle is plain JS and
  // reads better than it parses.
  for (const match of hand.matchAll(/\{([^{}]*)\}\s*=/g)) {
    for (const piece of match[1].split(',')) {
      const name = piece.trim().split(':').pop()?.trim()
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name)
    }
  }

  const offenders = [
    ...new Map(
      referenceSites(hand)
        .filter((site) => REF_SUFFIX.test(site.name) && !declared.has(site.name))
        .map((site) => [site.name, site]),
    ).values(),
  ]

  assert.deepEqual(
    offenders.map((site) => `${site.name} (line ${site.line}): ${site.text}`),
    [],
    'a name ending in "Ref" is read but never declared — it will throw at runtime',
  )
})

test('the live path never discards the promise it starts', () => {
  const source = readFileSync(join(PACKAGE_DIR, 'client.cjs'), 'utf8')
  // `void flushPeek()` is how a throw inside the peek became invisible: the
  // rejection has no handler and no route to the user. Every call must catch.
  const bare = [...source.matchAll(/void\s+flushPeek\(\)/g)]
  const code = source.split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
  const bareInCode = code.filter((line) => /void\s+flushPeek\(\)/.test(line))
  assert.deepEqual(
    bareInCode,
    [],
    `flushPeek must be invoked with a rejection handler (${bare.length} bare call(s) found)`,
  )
})

test('no ref is read without .current', () => {
  const source = readFileSync(join(PACKAGE_DIR, 'client.cjs'), 'utf8')
  const begin = source.indexOf('// --- BEGIN INLINED lib/vad.mjs')
  const end = source.indexOf('// --- END INLINED lib/local-agreement.mjs')
  const body = begin === -1 || end === -1 ? source : source.slice(0, begin) + source.slice(end)
  const lines = body.split('\n')

  // Every ref this bundle declares.
  const refs = []
  for (const match of body.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*React\.useRef\(/g)) refs.push(match[1])
  assert.ok(refs.length >= 4, `expected several refs in the bundle, found ${refs.length}`)

  // A ref is an object, so its fields live under `.current`. Reading `held.chunks`
  // yields undefined and the next `.length` throws — and because that throw lands
  // in an event handler with no catch, the handler dies without a word. That is
  // how the live view came to report "17 chunks" in one place and never send
  // anything in another: the two read the same ref, and only one read it right.
  const offenders = []
  for (const ref of refs) {
    const pattern = new RegExp(`(?<![.\\w])${ref}\\.(?!current)([A-Za-z_$][\\w$]*)`, 'g')
    for (const match of body.matchAll(pattern)) {
      const line = body.slice(0, match.index).split('\n').length
      const text = (lines[line - 1] ?? '').trim()
      // A comment can describe this mistake; it cannot make it.
      if (text.startsWith('*') || text.startsWith('//')) continue
      offenders.push(`${ref}.${match[1]} (line ${line}): ${text}`)
    }
  }
  assert.deepEqual(offenders, [], 'a ref is read without .current — it will throw at runtime')
})

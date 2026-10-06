/**
 * The browser half's stylesheet, and who owns it.
 *
 * `client.cjs` has no build step, so nothing type-checks it and nothing loads it
 * outside a browser. This file pins the one wiring rule that fails silently in
 * the running app: the harness client loader owns plugin styles by the
 * `data-plugin` attribute. `claimStyles` marks every <style> that LACKS it as
 * belonging to whichever plugin materialises next, and `removeOwnedStyles(id)`
 * deletes every <style> whose `data-plugin` equals an id when that entry is
 * replaced or pruned. A sheet tagged only with a private `data-…` attribute
 * therefore looks unowned: another plugin claims it, and that plugin's first
 * refresh deletes it. Losing the sheet is not cosmetic — an SVG <path> with no
 * `fill: none` fills black, and buttons fall back to the browser's default.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** Minimal React: elements keep their shape, so nothing is mounted but the
 * bundle's module scope and `apply` can run. */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: () => [null, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useMemo: () => null,
  useCallback: (fn) => fn,
  Fragment: Symbol('Fragment'),
}

/**
 * Minimal DOM, with the two selectors that decide style ownership: the bundle's
 * own duplicate guard and the loader's `style:not([data-plugin])` claim rule.
 */
function installDocumentStub() {
  const head = {
    children: [],
    append(child) { this.children.push(child) },
  }

  /** Read one attribute, seeing `dataset` writes as the browser reflects them. */
  function attributeOf(element, name) {
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
      if (Object.prototype.hasOwnProperty.call(element.dataset, key)) return element.dataset[key]
    }
    return element.attributes?.[name] ?? null
  }

  /** Whether one element matches the single, attribute-only selectors used here. */
  function matches(element, selector) {
    if (element.tagName !== 'style') return false
    const owned = selector.match(/^style:not\(\[([\w-]+)\]\)$/)
    if (owned !== null) return attributeOf(element, owned[1]) === null
    const exact = selector.match(/^style\[([\w-]+)="([^"]*)"\]$/)
    if (exact !== null) return attributeOf(element, exact[1]) === exact[2]
    throw new Error(`the DOM stub does not implement the selector ${selector}`)
  }

  globalThis.document = {
    head,
    createElement(tagName) {
      return {
        tagName,
        dataset: {},
        attributes: {},
        textContent: '',
        setAttribute(name, value) { this.attributes[name] = value },
        getAttribute(name) { return attributeOf(this, name) },
        remove() {
          this.removed = true
          const at = head.children.indexOf(this)
          if (at >= 0) head.children.splice(at, 1)
        },
      }
    },
    querySelector(selector) { return head.children.find((child) => matches(child, selector)) ?? null },
    querySelectorAll(selector) { return head.children.filter((child) => matches(child, selector)) },
  }
  return head
}

/** Load the shipped client bundle the way the harness does, and return its exports. */
function loadClient() {
  installDocumentStub()
  let definition = null
  globalThis.window = { __ModuleLoader__: { load(candidate) { definition = candidate } } }
  const path = require.resolve('../client.cjs')
  delete require.cache[path]
  require('../client.cjs')
  assert.ok(definition !== null, 'the bundle did not register itself with the module loader')
  assert.equal(definition.id, 'dsh-voice-input')
  return definition.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error(`the client bundle required an undeclared module: ${name}`)
  })
}

/** A context covering the two services the browser half declares. */
function fakeContext() {
  return {
    slots: { inject() {}, register() { return () => {} } },
    interval: () => () => {},
    get: () => undefined,
    effect(fn, _label) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
}

test('the stylesheet is tagged the way the harness loader owns plugin styles', () => {
  const client = loadClient()
  // `loadClient` installs the document stub, so the head must be read after it.
  const head = globalThis.document.head
  client.apply(fakeContext())

  const sheet = head.children.find((child) => child.dataset.dshVoiceInput === 'true')
  assert.ok(sheet, 'no stylesheet was installed')

  assert.equal(sheet.dataset.plugin, 'dsh-voice-input',
    'the sheet does not name its owner, so the loader hands it to whichever plugin '
    + 'materialises next and deletes it with that plugin')
  assert.equal(sheet.dataset.pluginCss, 'dsh-voice-input/styles',
    'the sheet has no per-sheet identity for the loader to inventory')

  const claimable = globalThis.document.querySelectorAll('style:not([data-plugin])')
  assert.equal(claimable.length, 0,
    'the sheet is still claimable by whichever plugin materialises next')
})

test('a second apply does not stack a second stylesheet', () => {
  const client = loadClient()
  const head = globalThis.document.head
  client.apply(fakeContext())
  client.apply(fakeContext())

  const sheets = head.children.filter((child) => child.dataset.dshVoiceInput === 'true')
  assert.equal(sheets.length, 1, `expected one sheet, found ${sheets.length}`)
})

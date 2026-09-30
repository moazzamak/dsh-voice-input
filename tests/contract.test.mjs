/**
 * Contract smoke test for the published package.
 *
 * Run with `node --test` — no dev dependencies, so it works from a checkout and
 * from the installed package alike.
 *
 * These assertions cover the three things that silently break a DSH bundle:
 * the host module's Cordis shape, the browser bundle's registration wire
 * format, and the manifest fields the loader and the client module table read.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))

/** Import one package file by URL: dynamic `import()` rejects bare Windows drive paths. */
const importPackageFile = (name) => import(pathToFileURL(join(PACKAGE_DIR, name)).href)

test('manifest declares the bundle patch and the browser half', () => {
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh?.client?.platform, 'web')
  // `files` must carry the patch, or an install activates no layer at all.
  assert.ok(manifest.files.includes('cordis.patch.yml'))
  // An out-of-tree client is resolved through this exact export.
  assert.equal(manifest.exports['./client'], './client.cjs')
  // Every path the loader may resolve must exist in the published set.
  for (const entry of ['index.mjs', 'client.cjs', 'python/transcribe.py', 'python/setup.py']) {
    assert.ok(manifest.files.includes(entry), `${entry} missing from files`)
  }
})

test('host half exposes the Cordis plugin shape', async () => {
  const host = await importPackageFile('index.mjs')
  assert.equal(host.name, 'voice-input')
  assert.deepEqual(host.inject, ['shell', 'tools', 'fs'])
  assert.equal(typeof host.apply, 'function')
  assert.equal(typeof host.VOICE_INPUT_ROUTE, 'string')
  // The client half posts to this exact path, so it is a cross-half contract.
  assert.equal(host.VOICE_INPUT_ROUTE, '/voice-input/transcribe')
  assert.equal(typeof host.Config?.['~standard']?.validate, 'function')
})

test('the model-facing tool keeps its name and registerable shape', async () => {
  const host = await importPackageFile('index.mjs')
  assert.equal(host.TRANSCRIBE_TOOL_NAME, 'voice_transcribe')
  const source = readFileSync(join(PACKAGE_DIR, 'index.mjs'), 'utf8')
  // The registry rejects a definition without output { schema, render }, so
  // both must be present on the raw JSON-Schema form this package uses.
  assert.ok(source.includes('ctx.tools.register('), 'tool must register through ctx.tools')
  assert.ok(/output: \{\s*schema: \{ type: 'string' \},\s*render:/.test(source), 'output needs schema + render')
  assert.ok(source.includes('readBytes(target, exec?.signal, MAX_TOOL_FILE_BYTES)'), 'reads must be bounded')
})

test('host config validation defaults every field and refuses bad values', async () => {
  const { Config } = await importPackageFile('index.mjs')
  const validate = Config['~standard'].validate

  const defaults = validate(undefined)
  assert.deepEqual(defaults.issues, undefined)
  assert.deepEqual(
    {
      model: defaults.value.model,
      language: defaults.value.language,
      computeType: defaults.value.computeType,
      timeoutMs: defaults.value.timeoutMs,
    },
    { model: 'base.en', language: 'en', computeType: 'int8', timeoutMs: 300_000 },
  )

  // A user's own extra keys survive validation.
  assert.equal(validate({ model: 'small.en', custom: 1 }).value.custom, 1)

  const bad = validate({ model: '', computeType: 'float16', timeoutMs: 10 })
  assert.equal(bad.value, undefined)
  assert.equal(bad.issues.length, 3)
  assert.equal(validate([]).issues[0].message, 'voice-input config must be an object')
})

test('browser half registers its factory in the harness wire format', () => {
  const source = readFileSync(join(PACKAGE_DIR, 'client.cjs'), 'utf8')
  assert.ok(source.includes('window.__ModuleLoader__.load('), 'missing registration call')
  assert.ok(source.includes("id: 'dsh-voice-input'"), 'registration id must be the package name')
  assert.ok(source.includes('factory: (require) =>'), 'missing factory wrapper')
  assert.ok(source.includes("require('react')"), 'React must come from the shared module table')

  // The bundle must export the plugin face the client Loader drives, and must
  // declare the slot it registers into.
  assert.ok(/module\.exports\.apply\s*=/.test(source), 'missing apply export')
  assert.ok(/module\.exports\.inject\s*=/.test(source), 'missing inject export')
  assert.ok(source.includes("'conversation.input.left'"), 'missing target slot')
  assert.ok(source.includes("'@deepseek-ai/dsh-client-ui-slots'") === false, 'must not import a non-baseline module')
})

test('browser and host halves agree on the route', () => {
  const client = readFileSync(join(PACKAGE_DIR, 'client.cjs'), 'utf8')
  assert.ok(
    client.includes("'/voice-input/transcribe'"),
    'client route literal must match VOICE_INPUT_ROUTE',
  )
})

test('config layer inserts the row by package name', () => {
  const patch = readFileSync(join(PACKAGE_DIR, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes('- insert:'), 'patch must insert rows')
  assert.ok(patch.includes(`name: ${manifest.name}`), 'row must reference the package by name')
  assert.ok(patch.includes('id: voice-input'), 'row id must be stable for user overrides')
})

test('engine CLI help is reachable and declares its contract', () => {
  const script = readFileSync(join(PACKAGE_DIR, 'python/transcribe.py'), 'utf8')
  assert.ok(script.includes('--audio'), 'CLI must accept an audio path')
  assert.ok(script.includes('--audio-base64-file') === false, 'child must not write; host stages the file')
  assert.ok(script.includes('"ok": True'), 'CLI must print the documented JSON result')
})

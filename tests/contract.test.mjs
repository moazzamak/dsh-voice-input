/**
 * Contract smoke test for the published package.
 *
 * Run with `node --test` — no dev dependencies, so it works from a checkout and
 * from the installed package alike.
 *
 * These assertions cover the things that silently break a DSH bundle: the host
 * modules' Cordis shapes, the row split that keeps the tool alive without a
 * browser, the browser bundle's registration wire format, and the manifest
 * fields the loader and the client module table read.
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
  for (const entry of [
    'index.mjs', 'client.cjs', 'lib/engine.mjs', 'python/transcribe.py', 'python/setup.py',
  ]) {
    assert.ok(manifest.files.includes(entry), `${entry} missing from files`)
  }
})

test('the host row defers its browser route instead of declaring webServer', async () => {
  const tool = await importPackageFile('index.mjs')
  assert.equal(tool.name, 'voice-input')
  // A hard `webServer` dependency would park this row in every profile without
  // a browser — where the tool is the only thing that can work.
  assert.deepEqual(tool.inject, ['shell', 'tools', 'fs'])
  assert.equal(tool.TRANSCRIBE_TOOL_NAME, 'voice_transcribe')
  assert.equal(tool.VOICE_INPUT_ROUTE, '/voice-input/transcribe')
  assert.equal(typeof tool.apply, 'function')
  assert.equal(typeof tool.Config?.['~standard']?.validate, 'function')

  // The route is deferred: a second row that merely waits for `webServer` fails
  // the boot audit, and reading it once during apply silently misses it.
  const source = readFileSync(join(PACKAGE_DIR, 'index.mjs'), 'utf8')
  assert.ok(source.includes("ctx.inject(['webServer']"), 'route must be registered through ctx.inject')
  assert.ok(!source.includes("ctx.get('webServer')"), 'must not probe the carrier once during apply')
})

test('the host row and the engine agree on shared identity', async () => {
  const tool = await importPackageFile('index.mjs')
  const engine = await importPackageFile('lib/engine.mjs')
  assert.equal(tool.Config, engine.Config)
  assert.equal(tool.TRANSCRIBE_TOOL_NAME, engine.TRANSCRIBE_TOOL_NAME)
  assert.equal(tool.VOICE_INPUT_ROUTE, engine.VOICE_INPUT_ROUTE)
})

test('the model-facing tool keeps its registerable shape', async () => {
  const tool = await importPackageFile('index.mjs')
  const source = readFileSync(join(PACKAGE_DIR, 'index.mjs'), 'utf8')
  // The registry rejects a definition without output { schema, render }, so
  // both must be present on the raw JSON-Schema form this package uses.
  assert.ok(source.includes('ctx.tools.register('), 'tool must register through ctx.tools')
  assert.ok(/output: \{\s*schema: \{ type: 'string' \},\s*render:/.test(source), 'output needs schema + render')
  assert.ok(source.includes('readBytes(target, exec?.signal, MAX_TOOL_FILE_BYTES)'), 'reads must be bounded')

  // Assert the exact wire schema: the provider validates `parameters` verbatim,
  // and an in-repo style per-property `required: true` is rejected there.
  const parameters = tool.TRANSCRIBE_PARAMETERS
  assert.equal(parameters.type, 'object')
  assert.deepEqual(parameters.required, ['path'])
  assert.deepEqual(Object.keys(parameters.properties).sort(), ['language', 'path'])
  for (const [key, property] of Object.entries(parameters.properties)) {
    assert.equal(property.type, 'string', `${key} must be a string`)
    assert.equal(property.required, undefined, `${key} must not carry a per-property required flag`)
    assert.equal(typeof property.description, 'string', `${key} needs a description`)
  }
})

test('host config validation defaults every field and refuses bad values', async () => {
  const { Config } = await importPackageFile('lib/engine.mjs')
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

  // A slot name is NOT a service: declaring it in `inject` leaves the browser
  // entry pending forever and fails the boot audit with
  // "pending (waiting for service: conversation.input.left)". `slots.inject` is
  // the mechanism that waits for the slot declaration. The timer is probed for
  // the same class of reason.
  const declared = source.match(/const inject = \[([^\]]*)\]/)
  assert.ok(declared !== null, 'inject must be a literal array')
  assert.equal(declared[1].trim(), "'slots'", 'only the slot registry may be injected')
})

test('the browser half proves it can hear the user', () => {
  const source = readFileSync(join(PACKAGE_DIR, 'client.cjs'), 'utf8')
  // A recording indicator that never moves cannot be told apart from a muted
  // microphone, so a live level meter and a running clock are requirements.
  assert.ok(source.includes('createAnalyser(stream)'), 'must analyse the recorded stream')
  assert.ok(source.includes('getByteTimeDomainData'), 'must sample the time-domain level')
  assert.ok(source.includes('METER_BARS'), 'must render a multi-bar meter')
  assert.ok(source.includes("role: 'img'") || source.includes("'aria-label'"), 'meter needs an accessible label')
  assert.ok(source.includes('no sound — check your microphone'), 'must warn when the input is silent')
  assert.ok(source.includes('elapsedText(elapsed)'), 'clock must render React state, not a bare Date.now()')
  assert.ok(source.includes('startLevelLoop'), 'clock and meter need the timer service')
  // The analyser must never be routed to the speakers (feedback loop).
  assert.ok(source.includes('connect(audioContext.destination)') === false, 'must not monitor to the destination')
})

test('browser and host halves agree on the route', () => {
  const client = readFileSync(join(PACKAGE_DIR, 'client.cjs'), 'utf8')
  const engine = readFileSync(join(PACKAGE_DIR, 'lib', 'engine.mjs'), 'utf8')
  assert.ok(client.includes("'/voice-input/transcribe'"), 'client route literal missing')
  assert.ok(engine.includes("'/voice-input/transcribe'"), 'engine route literal missing')
})

test('config layer inserts the row by package name', () => {
  const patch = readFileSync(join(PACKAGE_DIR, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes('- insert:'), 'patch must insert rows')
  assert.ok(patch.includes(`name: ${manifest.name}\n`), 'row must reference the package by name')
  assert.ok(patch.includes('id: voice-input'), 'row id must be stable for user overrides')
  // Exactly one row: a second one waiting on webServer fails the boot audit.
  assert.equal(patch.match(/^\s*- id:/gm)?.length, 1, 'the layer must insert exactly one row')
})

test('engine CLI help is reachable and declares its contract', () => {
  const script = readFileSync(join(PACKAGE_DIR, 'python/transcribe.py'), 'utf8')
  assert.ok(script.includes('--audio'), 'CLI must accept an audio path')
  assert.ok(script.includes('--audio-base64-file') === false, 'child must not write; host stages the file')
  assert.ok(script.includes('"ok": True'), 'CLI must print the documented JSON result')
})

/**
 * Headless browser check for the dsh-voice-input client half.
 *
 * Loads the running harness page in Chrome, waits for the boot to settle, then
 * CLICKS the microphone button and samples the DOM to confirm that the meter
 * moves and the clock advances. Those two behaviours are what the client boot
 * audit cannot check and what a person would otherwise have to eyeball.
 *
 * Chrome's fake capture device supplies a synthetic audio stream, so a moving
 * meter proves the analyser path works end to end.
 *
 * Usage: node cdp-check.mjs <url> <debugPort>
 */

import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const [, , targetUrl, debugPort] = process.argv
if (targetUrl === undefined || debugPort === undefined) {
  console.error('usage: node cdp-check.mjs <url> <debugPort>')
  process.exit(2)
}

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PROFILE = `${process.env.TEMP}\\voice-cdp-profile`
const consoleLines = []
const exceptions = []

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  // A fake capture device keeps getUserMedia from waiting on real hardware. Its
  // synthetic tone is exactly what should make the meter move; if the meter
  // stays flat, the analyser path is broken rather than merely silent.
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  'about:blank',
], { stdio: 'ignore' })

/** Poll the DevTools HTTP endpoint until Chrome reports a page target. */
async function pageTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
      const targets = await response.json()
      const page = targets.find((candidate) => candidate.type === 'page')
      if (page?.webSocketDebuggerUrl !== undefined) return page
    } catch {
      // Not up yet.
    }
    await delay(500)
  }
  throw new Error('Chrome DevTools endpoint never became ready')
}

const target = await pageTarget()
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message.result)
    pending.delete(message.id)
    return
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    const text = (message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' ')
    consoleLines.push(`[${message.params.type}] ${text}`)
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails
    exceptions.push(details.exception?.description ?? details.text ?? 'unknown exception')
  }
})

/** Send one CDP command and await its result. */
function send(method, params = {}) {
  const id = nextId
  nextId += 1
  return new Promise((resolve) => {
    pending.set(id, resolve)
    socket.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (pending.delete(id)) resolve(undefined)
    }, 10_000)
  })
}

/** Evaluate one expression in the page and return its value. */
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false })
  const remote = result?.result
  if (remote === undefined) return '<no response>'
  if (remote.subtype === 'error') return `ERROR: ${remote.description}`
  return remote.value
}

/** DOM summary used to judge the recording state at one instant. */
const SAMPLE = `(() => {
  const button = document.querySelector('.dsh-voice-button')
  const bars = Array.from(document.querySelectorAll('.dsh-voice-bar'))
  const clock = document.querySelector('.dsh-voice-watch')
  const hint = document.querySelector('.dsh-voice-hint')
  const error = document.querySelector('.dsh-voice-error')
  return {
    state: button ? button.getAttribute('data-state') : null,
    bars: bars.map(b => Math.round(parseFloat(b.style.height) || 0)),
    clock: clock ? clock.textContent : null,
    hint: hint ? hint.textContent : null,
    error: error ? error.textContent : null,
  }
})()`

send('Runtime.enable')
send('Page.enable')
await delay(300)
send('Page.navigate', { url: targetUrl })
await delay(20_000)

const facts = {
  href: await evaluate('location.href'),
  readyState: await evaluate('document.readyState'),
  voiceEntry: await evaluate('window.__DSH_BOOT__.entries.some(e => e.id === "dsh-voice-input")'),
  micButton: await evaluate('document.querySelector(".dsh-voice-button") !== null'),
}

console.log('--- page facts ---')
for (const [key, value] of Object.entries(facts)) console.log(`  ${key.padEnd(12)}: ${JSON.stringify(value)}`)

// Click, then watch: the state must become "recording", the clock must advance,
// and the bars must move.
const clicked = await evaluate('(() => { const b = document.querySelector(".dsh-voice-button"); if (!b) return false; if (b.disabled) return "disabled"; b.click(); return true })()')
console.log('\nclick result :', JSON.stringify(clicked))

const samples = []
for (let step = 0; step < 8; step += 1) {
  await delay(700)
  samples.push(await evaluate(SAMPLE))
}

console.log('\n--- recording samples (every ~700ms) ---')
for (const [index, sample] of samples.entries()) {
  const nonZero = sample.bars.filter((height) => height > 8).length
  console.log(`  t+${(index + 1) * 0.7}s state=${sample.state} clock=${sample.clock} barsLit=${nonZero}/${sample.bars.length} peak=${Math.max(0, ...sample.bars)} hint=${sample.hint}`)
}

// Stop, so the recording does not sit open.
await evaluate('(() => { const b = document.querySelector(".dsh-voice-button"); if (b && !b.disabled) b.click(); return true })()')
await delay(3000)
const after = await evaluate(SAMPLE)
console.log('\nafter stop   :', JSON.stringify(after))

const all = [...consoleLines, ...exceptions].join('\n')
const auditFailed = /entry did not activate|Failed to load plugins/i.test(all)
const injectError = /without inject/i.test(all)
const recording = samples.some((sample) => sample.state === 'recording')
const clockAdvanced = new Set(samples.map((sample) => sample.clock).filter(Boolean)).size > 1
const meterMoved = new Set(samples.flatMap((sample) => sample.bars)).size > 1

console.log('\n--- verdict ---')
console.log('  boot audit failed :', auditFailed)
console.log('  inject guard error:', injectError)
console.log('  entered recording :', recording)
console.log('  clock advanced    :', clockAdvanced)
console.log('  meter moved       :', meterMoved)
if (consoleLines.length > 0) {
  console.log('\n--- console (tail) ---')
  console.log(consoleLines.slice(-15).join('\n'))
}
if (exceptions.length > 0) {
  console.log('\n--- exceptions ---')
  console.log(exceptions.slice(-3).join('\n---\n'))
}

socket.close()
chrome.kill()
process.exit(auditFailed || injectError || !recording || !clockAdvanced || !meterMoved ? 1 : 0)

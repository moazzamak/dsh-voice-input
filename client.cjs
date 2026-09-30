/**
 * Browser half of `dsh-voice-input`, in the harness client-bundle format
 * (`window.__ModuleLoader__.load({ id, factory })`).
 *
 * Registers one microphone button in the composer's tool row. It records with
 * `MediaRecorder`, samples the same stream through an `AnalyserNode` so the
 * user can SEE that audio is arriving, posts the bytes to the host half's
 * route, and inserts the returned transcript into the chat draft for review.
 *
 * The level meter is not decoration. A recording indicator that never moves is
 * indistinguishable from a muted microphone: without it the user has no way to
 * know their words are not being captured until the transcript comes back
 * wrong — or empty.
 *
 * The bundle is plain CommonJS-before-bundling by design: it stays readable and
 * needs no build step, so a git install works without a `prepare` script.
 */
window.__ModuleLoader__.load({
  id: 'dsh-voice-input',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** Host route the browser half posts recordings to; must match engine.mjs. */
    const ROUTE = '/voice-input/transcribe'
    const SLOT = 'conversation.input.left'
    const ENTRY_ID = 'voice-input-microphone'

    /** Meter geometry, and how often the analyser is sampled. */
    const METER_BARS = 14
    // 50 ms keeps the meter reading as motion (20 fps) rather than as a series
    // of jumps, at a negligible cost: one analyser read and fourteen spans.
    const METER_INTERVAL_MS = 50
    /** Consecutive near-silent samples before the muted-microphone hint appears. */
    const QUIET_SAMPLES_BEFORE_HINT = 30

    const CLASS = {
      root: 'dsh-voice-root',
      button: 'dsh-voice-button',
      meter: 'dsh-voice-meter',
      bar: 'dsh-voice-bar',
      watch: 'dsh-voice-watch',
      hint: 'dsh-voice-hint',
      error: 'dsh-voice-error',
    }

    const CSS = `
.${CLASS.root} { display: inline-flex; align-items: center; gap: 6px; }
.${CLASS.button} {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; padding: 0; border: 0; border-radius: 50%;
  background: transparent; color: inherit; opacity: 0.75; cursor: pointer;
}
.${CLASS.button}:hover:not(:disabled) { opacity: 1; background: color-mix(in srgb, currentColor 12%, transparent); }
.${CLASS.button}:disabled { opacity: 0.35; cursor: default; }
.${CLASS.button}[data-state='recording'], .${CLASS.button}[data-state='transcribing'] { color: #e5484d; opacity: 1; }
.${CLASS.meter} { display: inline-flex; align-items: flex-end; gap: 2px; height: 16px; }
.${CLASS.bar} { width: 2px; border-radius: 1px; background: currentColor; opacity: 0.35; transition: height 60ms linear; }
.${CLASS.meter}[data-live='true'] .${CLASS.bar} { opacity: 0.9; }
.${CLASS.watch} { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-variant-numeric: tabular-nums; opacity: 0.8; }
.${CLASS.hint} { font-size: 11px; color: #e5a34d; white-space: nowrap; }
.${CLASS.error} { max-width: 320px; overflow: hidden; font-size: 11px; color: #e5484d; text-overflow: ellipsis; white-space: nowrap; }
`

    /** Install this bundle's stylesheet once per page and return its remover. */
    function insertStyles() {
      const tag = document.createElement('style')
      tag.dataset.dshVoiceInput = 'true'
      tag.textContent = CSS
      document.head.append(tag)
      return () => { tag.remove() }
    }

    function MicrophoneIcon() {
      return React.createElement('svg', {
        viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': true,
      },
        React.createElement('rect', { x: 6, y: 1.5, width: 4, height: 8, rx: 2 }),
        React.createElement('path', { d: 'M3.5 7.5a4.5 4.5 0 0 0 9 0' }),
        React.createElement('path', { d: 'M8 12v2.5' }),
      )
    }

    function StopIcon() {
      return React.createElement('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true },
        React.createElement('rect', { x: 4, y: 4, width: 8, height: 8, rx: 2, fill: 'currentColor' }))
    }

    /** Elapsed recording time as `m:ss`. */
    function elapsedText(ms) {
      const total = Math.floor(Math.max(0, ms) / 1000)
      return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
    }

    /**
     * Map one RMS amplitude to a visible bar fraction.
     *
     * Speech at a normal distance sits near 0.02–0.15 RMS, so a linear scale
     * would leave the meter almost flat; the square root lifts quiet speech into
     * view while still separating loud from soft.
     *
     * @param {number} rms - root-mean-square amplitude in [0, 1].
     * @returns {number} bar height fraction in [0, 1].
     */
    function levelFraction(rms) {
      const lifted = Math.sqrt(Math.min(1, Math.max(0, rms) * 6))
      return Math.max(0.08, Math.min(1, lifted))
    }

    /** The best container this browser records, preferring Opus in WebM. */
    function pickAudioMimeType() {
      const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
      if (typeof MediaRecorder === 'undefined' || MediaRecorder.isTypeSupported === undefined) return undefined
      for (const candidate of candidates) {
        if (MediaRecorder.isTypeSupported(candidate)) return candidate
      }
      return undefined
    }

    function recordingSupported() {
      return typeof MediaRecorder !== 'undefined'
        && typeof navigator !== 'undefined'
        && navigator.mediaDevices !== undefined
        && typeof navigator.mediaDevices.getUserMedia === 'function'
    }

    /** An audio-graph analyser if this browser can build one, else null. */
    function createAnalyser(stream) {
      const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext
      if (Ctor === undefined) return null
      try {
        const audioContext = new Ctor()
        const source = audioContext.createMediaStreamSource(stream)
        const analyser = audioContext.createAnalyser()
        analyser.fftSize = 512
        analyser.smoothingTimeConstant = 0.2
        source.connect(analyser)
        // Deliberately NOT connected to the destination: monitoring the mic
        // through the speakers feeds back.
        return {
          audioContext,
          analyser,
          samples: new Uint8Array(analyser.fftSize),
          close: () => { void audioContext.close().catch(() => {}) },
        }
      } catch (error) {
        console.error('voice-input: level metering unavailable', error)
        return null
      }
    }

    /** Root-mean-square amplitude of one time-domain sample window. */
    function rmsOf(samples) {
      let sum = 0
      for (let index = 0; index < samples.length; index += 1) {
        const centred = (samples[index] - 128) / 128
        sum += centred * centred
      }
      return Math.sqrt(sum / samples.length)
    }

    /**
     * Record one voice instruction, show that audio is arriving, transcribe it
     * on the host, and append the result to the current draft.
     */
    function VoiceMic(props) {
      const actions = props.inputActions
      const draft = props.useInput((state) => state.draft)
      const startLevelLoop = props.startLevelLoop
      const [state, setState] = React.useState({ phase: 'idle' })
      const [levels, setLevels] = React.useState(() => new Array(METER_BARS).fill(0))
      const [elapsed, setElapsed] = React.useState(0)
      const [quiet, setQuiet] = React.useState(false)
      const held = React.useRef({ recorder: null, chunks: [], stream: null, startedAt: 0, voice: null })
      const quietStreak = React.useRef(0)

      const supported = recordingSupported()

      const releaseStream = () => {
        const stream = held.current.stream
        held.current.stream = null
        if (stream === null) return
        for (const track of stream.getTracks()) track.stop()
      }

      const releaseVoice = () => {
        const voice = held.current.voice
        held.current.voice = null
        if (voice !== null) voice.close()
      }

      React.useEffect(() => () => {
        const recorder = held.current.recorder
        if (recorder !== null && recorder.state !== 'inactive') {
          try {
            recorder.stop()
          } catch (error) {
            console.error('voice-input: stopping the recorder on unmount failed', error)
          }
        }
        releaseStream()
        releaseVoice()
      }, [])

      // The clock and the meter both need a periodic nudge. React cannot
      // re-render from a bare Date.now() read, and the browser's own timer
      // globals are not the sanctioned surface here, so this uses the timer
      // mixin on the plugin context, disposed automatically with the fiber.
      React.useEffect(() => {
        if (state.phase !== 'recording' || startLevelLoop === undefined) return undefined
        const tick = () => {
          setElapsed(Date.now() - held.current.startedAt)
          const voice = held.current.voice
          if (voice === null) return
          voice.analyser.getByteTimeDomainData(voice.samples)
          const level = levelFraction(rmsOf(voice.samples))
          setLevels((previous) => [...previous.slice(1), level])
          quietStreak.current = level <= 0.1 ? quietStreak.current + 1 : 0
          setQuiet(quietStreak.current >= QUIET_SAMPLES_BEFORE_HINT)
        }
        const dispose = startLevelLoop(tick, METER_INTERVAL_MS)
        return () => { dispose() }
      }, [state.phase, startLevelLoop])

      const insertTranscript = (text) => {
        if (actions === undefined) {
          setState({ phase: 'error', message: 'The composer input is unavailable in this session.' })
          return
        }
        const existing = typeof draft === 'string' ? draft : ''
        const separator = existing === '' || /\s$/.test(existing) ? '' : ' '
        actions.setDraft(existing + separator + text)
        setState({ phase: 'idle' })
      }

      const submitAudio = async (blob) => {
        setState({ phase: 'transcribing' })
        try {
          if (blob.size === 0) {
            setState({ phase: 'error', message: 'The recording was empty; check the microphone input.' })
            return
          }
          const response = await fetch(ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: blob,
          })
          let payload = {}
          try {
            payload = await response.json()
          } catch (error) {
            // A non-JSON body means the route failed before it could answer.
            console.error('voice-input: the host answered with no readable body', error)
          }
          if (payload.ok !== true) {
            const reason = typeof payload.error === 'string' ? payload.error : `transcription failed (HTTP ${response.status})`
            setState({ phase: 'error', message: reason })
            return
          }
          insertTranscript(String(payload.text).trim())
        } catch (error) {
          setState({
            phase: 'error',
            message: `Transcription request failed: ${error && error.message ? error.message : String(error)}`,
          })
        }
      }

      const resetMeter = () => {
        setLevels(new Array(METER_BARS).fill(0))
        setElapsed(0)
        setQuiet(false)
        quietStreak.current = 0
      }

      const finishRecording = () => {
        const recorder = held.current.recorder
        if (recorder === null || recorder.state === 'inactive') return
        setState({ phase: 'transcribing' })
        try {
          recorder.stop()
        } catch (error) {
          setState({ phase: 'error', message: `Stopping the recorder failed: ${String(error)}` })
        }
      }

      const beginRecording = async () => {
        if (state.phase !== 'idle' && state.phase !== 'error') return
        setState({ phase: 'starting' })
        resetMeter()
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          const voice = createAnalyser(stream)
          if (voice !== null && voice.audioContext.state === 'suspended') {
            await voice.audioContext.resume().catch(() => {})
          }
          const mimeType = pickAudioMimeType()
          const recorder = new MediaRecorder(stream, mimeType === undefined ? undefined : { mimeType })
          held.current = { recorder, chunks: [], stream, startedAt: Date.now(), voice }
          recorder.ondataavailable = (event) => {
            if (event.data !== undefined && event.data !== null && event.data.size > 0) {
              held.current.chunks.push(event.data)
            }
          }
          recorder.onerror = (event) => {
            const detail = event !== null && event.error !== undefined && event.error !== null ? event.error.name : 'unknown error'
            releaseStream()
            releaseVoice()
            setState({ phase: 'error', message: `The microphone recorder failed: ${detail}` })
          }
          recorder.onstop = () => {
            releaseStream()
            releaseVoice()
            const chunks = held.current.chunks
            const type = recorder.mimeType === '' || recorder.mimeType === undefined ? 'audio/webm' : recorder.mimeType
            held.current = { recorder: null, chunks: [], stream: null, startedAt: 0, voice: null }
            void submitAudio(new Blob(chunks, { type }))
          }
          recorder.start()
          held.current.startedAt = Date.now()
          setState({ phase: 'recording', startedAt: held.current.startedAt })
        } catch (error) {
          releaseStream()
          releaseVoice()
          const name = error !== null && error !== undefined ? error.name : ''
          const detail = name === 'NotAllowedError'
            ? 'Microphone permission was denied; allow the microphone for this page.'
            : name === 'NotFoundError'
              ? 'No microphone was found on this machine.'
              : `The microphone could not be opened: ${error && error.message ? error.message : String(error)}`
          setState({ phase: 'error', message: detail })
        }
      }

      const phase = state.phase
      const busy = phase === 'starting' || phase === 'transcribing'
      const recording = phase === 'recording'
      const label = recording
        ? 'Stop recording and transcribe'
        : phase === 'transcribing' ? 'Transcribing your recording' : 'Record a voice instruction'

      const children = [
        React.createElement('button', {
          key: 'button',
          type: 'button',
          className: CLASS.button,
          'aria-label': label,
          title: supported ? label : 'Voice input needs a browser with microphone recording support',
          'data-state': phase,
          disabled: !supported || busy,
          onClick: recording ? finishRecording : beginRecording,
        }, recording ? StopIcon() : MicrophoneIcon()),
      ]

      if (recording) {
        // The meter carries the "we can hear you" signal; its own aria-label
        // states the same fact for a screen reader.
        children.push(React.createElement('span', {
          key: 'meter',
          className: CLASS.meter,
          'data-live': quiet ? 'false' : 'true',
          role: 'img',
          'aria-label': quiet ? 'No sound detected' : 'Microphone level',
        }, levels.map((level, index) => React.createElement('span', {
          key: index,
          className: CLASS.bar,
          style: { height: `${Math.round(level * 100)}%` },
        }))))
        children.push(React.createElement('span', { key: 'watch', className: CLASS.watch, role: 'timer' },
          elapsedText(elapsed)))
      }
      if (recording && quiet) {
        children.push(React.createElement('span', { key: 'quiet', className: CLASS.hint, role: 'status' },
          'no sound — check your microphone'))
      }
      if (phase === 'transcribing') {
        children.push(React.createElement('span', { key: 'busy', className: CLASS.watch, role: 'status' }, 'transcribing…'))
      }
      if (phase === 'error') {
        children.push(React.createElement('span', {
          key: 'error', className: CLASS.error, role: 'status', title: state.message,
        }, state.message))
      }

      return React.createElement('div', { className: CLASS.root }, ...children)
    }

    /**
     * The only declared dependency: the slot registry.
     *
     * The target slot itself must NOT be declared here. A slot name is not a
     * service, so declaring `conversation.input.left` leaves this browser entry
     * pending forever and the client boot audit fails the whole page —
     * `slots.inject(…)` below is the mechanism that waits for the slot
     * declaration, and the client Loader resolves `inject` before `apply` runs.
     *
     * The timer service is probed rather than declared for the same class of
     * reason: a declared dependency that the shell ever fails to publish would
     * take the whole boot down, and the meter degrades harmlessly without it.
     */
    const inject = ['slots']

    /** Register the microphone button for the life of this plugin fiber. */
    function apply(ctx) {
      const removeStyles = insertStyles()
      ctx.effect(() => removeStyles, 'voice-input styles')
      const slots = ctx.slots
      // The timer helpers are mixed onto the CONTEXT, and a slot component
      // receives no context, so a bound interval helper is captured here and
      // handed down. Both spellings are accepted because which object carries
      // the helper is a Cordis implementation detail; without either, the clock
      // and meter simply stay still rather than breaking the button.
      const timer = ctx.get('timer')
      const interval = typeof ctx.interval === 'function'
        ? (callback, delay) => ctx.interval(callback, delay)
        : timer !== undefined && typeof timer.interval === 'function'
          ? (callback, delay) => timer.interval(callback, delay)
          : undefined
      const startLevelLoop = interval
      slots.inject(SLOT, () => slots.register(
        { name: SLOT, id: ENTRY_ID, order: 50, label: 'Voice input' },
        (props) => (props.inputActions === undefined || props.useInput === undefined
          ? null
          : React.createElement(VoiceMic, { ...props, startLevelLoop })),
      ))
    }

    module.exports.inject = inject
    module.exports.apply = apply
    module.exports.VoiceMic = VoiceMic
    module.exports.levelFraction = levelFraction
    return module.exports
  },
})

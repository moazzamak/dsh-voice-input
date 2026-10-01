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
    /** Pinged when recording starts so the model can load while the user speaks. */
    const WARM_ROUTE = '/voice-input/warm'
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
      note: 'dsh-voice-note',
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
.${CLASS.note} { font-size: 11px; opacity: 0.55; white-space: nowrap; }
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

    /**
     * Apply one host frame to the composer draft.
     *
     * Kept at module scope, and driven only through its `sink`, so the
     * partial-transcript logic is testable without a DOM or a React renderer:
     * `sink.setDraft` receives the complete draft text every time.
     *
     * The transcript is appended AFTER whatever the user had already typed —
     * `streamed.base` is captured once, before streaming starts — so a partial
     * update never rewrites or loses existing draft text.
     *
     * @param {{type: string, stage?: string, text?: string, error?: string, polished?: boolean}} frame
     * @param {{base: string, separator: string, text: string, written: boolean}} streamed
     * @param {{setDraft: (text: string) => void, setState: (state: object) => void}} sink
     */
    function applyFrameToDraft(frame, streamed, sink) {
      if (frame === null || typeof frame !== 'object') return
      if (frame.type === 'status') {
        if (frame.stage === 'loading') sink.setState({ phase: 'transcribing', warming: true })
        return
      }
      if (frame.type === 'partial') {
        const text = typeof frame.text === 'string' ? frame.text : ''
        if (text === '') return
        streamed.text = text
        streamed.written = true
        sink.setDraft(streamed.base + streamed.separator + text)
        return
      }
      if (frame.type === 'final') {
        const text = typeof frame.text === 'string' ? frame.text : ''
        streamed.text = text
        sink.setDraft(streamed.base + streamed.separator + text)
        sink.setState({ phase: 'idle', ...(frame.polished === true ? { note: 'cleaned up' } : {}) })
        return
      }
      if (frame.type === 'error') {
        if (streamed.written) {
          // Keep whatever arrived: a half transcript is still the user's words.
          sink.setState({ phase: 'idle', note: frame.error ?? 'transcription stopped early' })
        } else {
          sink.setState({ phase: 'error', message: frame.error ?? 'transcription failed' })
        }
      }
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
      /** The in-flight transcription request, so unmount or a new take can stop it. */
      const abortRef = React.useRef(null)
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
        const controller = abortRef.current
        if (controller !== null) {
          try {
            controller.abort()
          } catch (error) {
            console.error('voice-input: cancelling the transcription on unmount failed', error)
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

      const insertTranscript = (text, note) => {
        if (actions === undefined) {
          setState({ phase: 'error', message: 'The composer input is unavailable in this session.' })
          return
        }
        const existing = typeof draft === 'string' ? draft : ''
        const separator = existing === '' || /\s$/.test(existing) ? '' : ' '
        actions.setDraft(existing + separator + text)
        setState(note === null ? { phase: 'idle' } : { phase: 'idle', note })
      }

      /** One 'status' | 'partial' | 'final' | 'error' frame from the host. */
      const applyFrame = (frame, streamed) => applyFrameToDraft(frame, streamed, {
        setDraft: (value) => {
          if (actions !== undefined) actions.setDraft(value)
        },
        setState,
      })

      const submitAudio = async (blob) => {
        if (actions === undefined) {
          setState({ phase: 'error', message: 'The composer input is unavailable in this session.' })
          return
        }
        setState({ phase: 'transcribing' })
        if (blob.size === 0) {
          setState({ phase: 'error', message: 'The recording was empty; check the microphone input.' })
          return
        }

        // The draft as it stood when the transcription began: everything the
        // user already typed stays untouched, and the transcript is appended
        // after it as the host streams more of it.
        const base = typeof draft === 'string' ? draft : ''
        const separator = base === '' || /\s$/.test(base) ? '' : ' '
        const streamed = { base, separator, text: '', written: false }
        const controller = new AbortController()
        abortRef.current = controller

        try {
          const response = await fetch(ROUTE, {
            method: 'POST',
            headers: {
              'content-type': 'application/octet-stream',
              // Ask for progress frames rather than one final object.
              accept: 'application/x-ndjson',
            },
            body: blob,
            signal: controller.signal,
          })

          const streamable = response.body !== null
            && typeof response.body.getReader === 'function'
            && String(response.headers.get('content-type') ?? '').includes('ndjson')

          if (!streamable) {
            // An older host answers with one JSON object; keep working with it.
            let payload = {}
            try {
              payload = await response.json()
            } catch (error) {
              console.error('voice-input: the host answered with no readable body', error)
            }
            if (payload.ok !== true) {
              setState({
                phase: 'error',
                message: typeof payload.error === 'string' ? payload.error : `transcription failed (HTTP ${response.status})`,
              })
              return
            }
            insertTranscript(String(payload.text).trim(), payload.polished === true ? 'cleaned up' : null)
            return
          }

          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let newline = buffer.indexOf('\n')
            while (newline !== -1) {
              const line = buffer.slice(0, newline).trim()
              buffer = buffer.slice(newline + 1)
              if (line !== '') {
                try {
                  applyFrame(JSON.parse(line), streamed)
                } catch (error) {
                  console.error('voice-input: unreadable frame from the host', error)
                }
              }
              newline = buffer.indexOf('\n')
            }
          }
          // A zero-speech recording ends with an error frame and no draft text.
          if (!streamed.written && streamed.text === '') setState({ phase: 'idle' })
        } catch (error) {
          if (error !== null && error !== undefined && error.name === 'AbortError') {
            setState({ phase: 'idle', note: 'transcription cancelled' })
            return
          }
          setState({
            phase: 'error',
            message: `Transcription request failed: ${error && error.message ? error.message : String(error)}`,
          })
        } finally {
          if (abortRef.current === controller) abortRef.current = null
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
          // Ask the host to load the model NOW, while the user is still
          // speaking: that turns the model-load cost into time the recording
          // was going to take anyway, so the first transcript comes back
          // without a visible pause.
          try {
            void fetch(WARM_ROUTE, { method: 'POST' }).catch(() => {})
          } catch (error) {
            console.error('voice-input: prewarming the model failed', error)
          }
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
        children.push(React.createElement('span', {
          key: 'busy', className: CLASS.watch, role: 'status',
        }, state.warming === true ? 'loading the model…' : 'transcribing…'))
      }
      if (phase === 'error') {
        children.push(React.createElement('span', {
          key: 'error', className: CLASS.error, role: 'status', title: state.message,
        }, state.message))
      }
      if (phase === 'idle' && state.note !== undefined) {
        // A quiet marker, not a notice: the text is already in the draft, and
        // this only says a cleanup pass ran on the way there.
        children.push(React.createElement('span', {
          key: 'note', className: CLASS.note, role: 'status',
        }, state.note))
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
     * declaration.
     *
     * `timer` IS a real service (the client runner publishes it during its own
     * startup), and the context Guard refuses `ctx.interval` without the
     * declaration: 'cannot get property "interval" without inject'. Probing it
     * with `ctx.get` cannot work around that — the property read is itself what
     * the Guard refuses, before any undefined check runs.
     */
    const inject = ['slots', 'timer']

    /** Register the microphone button for the life of this plugin fiber. */
    function apply(ctx) {
      const removeStyles = insertStyles()
      ctx.effect(() => removeStyles, 'voice-input styles')
      const slots = ctx.slots
      // The timer helpers are mixed onto the CONTEXT, and a slot component
      // receives no context, so the bound interval helper is captured here and
      // handed down as a prop.
      const startLevelLoop = (callback, delay) => ctx.interval(callback, delay)
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
    module.exports.applyFrameToDraft = applyFrameToDraft
    return module.exports
  },
})

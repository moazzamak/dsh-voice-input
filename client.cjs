/**
 * Browser half of `dsh-voice-input`, in the harness client-bundle format
 * (`window.__ModuleLoader__.load({ id, factory })`).
 *
 * Registers one microphone button in the composer's tool row. It records with
 * `MediaRecorder`, posts the raw bytes to the host half's route, and inserts
 * the returned transcript into the chat draft for review before sending.
 *
 * The bundle is plain CommonJS-before-bundling by design: it stays readable
 * and needs no build step, so a git install works without a `prepare` script.
 */
window.__ModuleLoader__.load({
  id: 'dsh-voice-input',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** Host route the browser half posts recordings to; must match index.js. */
    const ROUTE = '/voice-input/transcribe'
    const SLOT = 'conversation.input.left'
    const ENTRY_ID = 'voice-input-microphone'

    const CLASS = {
      root: 'dsh-voice-root',
      button: 'dsh-voice-button',
      watch: 'dsh-voice-watch',
      pulse: 'dsh-voice-pulse',
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
.${CLASS.watch} { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-variant-numeric: tabular-nums; opacity: 0.8; }
.${CLASS.pulse} { width: 7px; height: 7px; border-radius: 50%; background: #e5484d; animation: dsh-voice-pulse 1.1s ease-in-out infinite; }
@keyframes dsh-voice-pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.25 } }
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
      const total = Math.floor(ms / 1000)
      return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
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
     * Record one voice instruction, transcribe it on the host, and append the
     * result to the current draft.
     */
    function VoiceMic(props) {
      const actions = props.inputActions
      const draft = props.useInput((state) => state.draft)
      const [state, setState] = React.useState({ phase: 'idle' })
      const held = React.useRef({ recorder: null, chunks: [], stream: null, startedAt: 0 })

      const supported = recordingSupported()

      const releaseStream = () => {
        const stream = held.current.stream
        held.current.stream = null
        if (stream === null) return
        for (const track of stream.getTracks()) track.stop()
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
      }, [])

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
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          const mimeType = pickAudioMimeType()
          const recorder = new MediaRecorder(stream, mimeType === undefined ? undefined : { mimeType })
          held.current = { recorder, chunks: [], stream, startedAt: Date.now() }
          recorder.ondataavailable = (event) => {
            if (event.data !== undefined && event.data !== null && event.data.size > 0) {
              held.current.chunks.push(event.data)
            }
          }
          recorder.onerror = (event) => {
            const detail = event !== null && event.error !== undefined && event.error !== null ? event.error.name : 'unknown error'
            releaseStream()
            setState({ phase: 'error', message: `The microphone recorder failed: ${detail}` })
          }
          recorder.onstop = () => {
            releaseStream()
            const chunks = held.current.chunks
            const type = recorder.mimeType === '' || recorder.mimeType === undefined ? 'audio/webm' : recorder.mimeType
            held.current = { recorder: null, chunks: [], stream: null, startedAt: 0 }
            void submitAudio(new Blob(chunks, { type }))
          }
          recorder.start()
          setState({ phase: 'recording', startedAt: Date.now() })
        } catch (error) {
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
      const label = phase === 'recording'
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
          onClick: phase === 'recording' ? finishRecording : beginRecording,
        }, phase === 'recording' ? StopIcon() : MicrophoneIcon()),
      ]
      if (phase === 'recording') {
        children.push(React.createElement('span', { key: 'watch', className: CLASS.watch, role: 'status' },
          React.createElement('span', { className: CLASS.pulse }),
          elapsedText(Date.now() - state.startedAt)))
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

    /** Where the browser half puts its button: the composer's left tool row. */
    const inject = ['slots', SLOT]

    /** Register the microphone button for the life of this plugin fiber. */
    function apply(ctx) {
      const removeStyles = insertStyles()
      ctx.effect(() => removeStyles, 'voice-input styles')
      const slots = ctx.slots
      slots.inject(SLOT, () => slots.register(
        { name: SLOT, id: ENTRY_ID, order: 50, label: 'Voice input' },
        (props) => (props.inputActions === undefined || props.useInput === undefined
          ? null
          : React.createElement(VoiceMic, props)),
      ))
    }

    module.exports.inject = inject
    module.exports.apply = apply
    module.exports.VoiceMic = VoiceMic
    return module.exports
  },
})

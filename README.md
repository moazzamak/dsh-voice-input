# dsh-voice-input

Offline local speech-to-text for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) composer.

A microphone button appears in the chat composer. Click it, speak, click again, and the
recognized text is appended to the draft — so you can fix a misheard word and press Enter
yourself. Nothing is uploaded: audio is recorded in your browser, posted to the harness
process on your own machine, and decoded there with [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
running on CPU.

## Requirements

- A DSH installation with the Web GUI (the `web` profile).
- **Python 3.9+** on `PATH` for the one-time engine setup (`python` on Windows, `python3` elsewhere).
- [uv](https://docs.astral.sh/uv/) is optional; the setup uses it when present and falls back to `pip`.
- A Chromium-based browser or Firefox with microphone recording support.

## Install

```sh
# 1. Install the bundle into your profile.
dsh plugin --profile web add github:moazzamak/dsh-voice-input

# 2. Build the local engine once. It lives inside the installed package, which
#    creates a venv there and pre-downloads the default model.
python "$HOME/.dsh/profiles/web/node_modules/dsh-voice-input/python/setup.py"
```

On Windows (PowerShell):

```powershell
dsh plugin --profile web add github:moazzamak/dsh-voice-input
python "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-voice-input\python\setup.py"
```

Then restart DSH. Note that `dsh web` is a fixed alias for the **`web`** profile —
`dsh web --profile other` does not exist, and `dsh plugin` must target the same profile you
actually boot.

### Alternatives to a git install

A git install fetches sources, and pnpm ≥10 refuses to run a package's `prepare` script
until you allow it. This package ships plain JavaScript with no build step, so there is
nothing to run and nothing to allow.

- **Tarball:** `pnpm pack` in this directory, then
  `dsh plugin --profile web add ./dsh-voice-input-0.1.0.tgz`.
- **Local checkout:** `dsh plugin --profile web add /path/to/dsh-voice-input`.
- **npm:** `dsh plugin --profile web add dsh-voice-input` (if published).

## Use

### In the Web GUI

The microphone button sits in the composer's tool row, left of the model selector.

| State | What you see |
| --- | --- |
| Idle | Grey microphone |
| Recording | Red stop square, a **live level meter**, and a running `m:ss` clock |
| Silent input | The meter stays flat and `no sound — check your microphone` appears |
| Transcribing | Red microphone, `transcribing…` |
| Failure | Red message beside the button (permission denied, no speech, engine error) |

The **level meter is the point**, not decoration: a recording indicator that never moves cannot
be told apart from a muted microphone. Fourteen bars track the incoming level, sampled from the
same stream through an `AnalyserNode`, so you can watch your voice arrive before you stop. The
analyser is deliberately never connected to the audio output — that would feed back through
your speakers.

If the input stays silent for about 1.5 seconds, the meter dims and the hint appears. That covers
the case the meter alone cannot: a muted microphone and a paused speaker both look flat, and the
hint tells you which to check.

The transcript is appended to whatever the draft already contains, separated by a space.
It is never sent for you.

### On any surface, as a tool

The same engine is also a model-facing tool, so a CLI, SDK, or ACP session can transcribe
an audio file with no browser involved:

```sh
dsh --profile headless "transcribe /path/to/meeting.m4a and save the transcript next to it"
```

The tool is `voice_transcribe`:

| Argument | Required | Meaning |
| --- | --- | --- |
| `path` | yes | Audio file to transcribe; relative paths resolve against the session working directory |
| `language` | no | Language code, or `auto`; defaults to the configured language |

It returns the transcript as text, or a message naming the failure. Accepted containers are
whatever ffmpeg decodes — `wav`, `mp3`, `m4a`, `webm`/`opus`, `ogg`, `flac`. The browser
route and the tool share one engine, one cache, and one configuration.

Because the tool exists on every surface but the route only where a browser can reach it,
the plugin declares no hard dependency on `webServer`: a headless or SDK profile loads it,
registers the tool, and skips the route.

## Configuration

Every option has a working default, so configuration is optional. To change one, override
the row in `$DSH_HOME/profiles/web/cordis.patch.yml` — a patch replaces a row's **entire**
`config`, so restate every key you still want:

```yaml
- id: voice-input
  name: dsh-voice-input
  config:
    model: small.en
    language: en
    computeType: int8
    timeoutMs: 300000
```

| Key | Default | Meaning |
| --- | --- | --- |
| `model` | `base.en` | Whisper model size or name |
| `language` | `en` | Spoken language, or `auto` to detect |
| `computeType` | `int8` | CTranslate2 compute type |
| `timeoutMs` | `300000` | Deadline for one transcription |
| `pythonPath` | package `.venv` | Interpreter with `faster-whisper` |
| `scriptPath` | bundled CLI | The transcription script |
| `cacheDir` | `$DSH_HOME/cache/voice-models` | Model weights cache |

### Choosing a model

| Model | Size | Notes |
| --- | --- | --- |
| `tiny.en` | ~75 MB | Fastest, least accurate |
| `base.en` | ~150 MB | Default; roughly 1 s of CPU per 5 s of speech |
| `small.en` | ~500 MB | Noticeably better, about 3× the compute |

Drop the `.en` suffix for multilingual models (`base`, `small`) and pair them with
`language: auto`. A model that is not cached downloads on first use and needs network
access once.

If `huggingface.co` is blocked, set `DSH_VOICE_HF_ENDPOINT` to a mirror such as
`https://hf-mirror.com` before starting DSH.

## Privacy

- Audio is recorded by the browser and posted to the harness's own loopback HTTP server.
- Transcription runs in a local child process. No audio, text, or model request leaves the
  machine; the only network access is the one-time model download.
- The route is guarded by the composition's `connection` trust fence when one is mounted
  (Host/Origin checks that defeat DNS rebinding and cross-site posts), and by the server's
  loopback binding otherwise.
- Recordings are staged under the OS temp directory and are not cleaned up automatically;
  clear `%TEMP%\dsh-voice-input` (Windows) or `/tmp/dsh-voice-input` when you want the space
  back.

## How it works

Two halves, one npm package:

- **Host half** (`index.mjs`) registers a model-facing `voice_transcribe` tool on `tools`, and
  one exact POST route, `/voice-input/transcribe`, on the composition's `webServer`. It stages
  audio to a temp file and runs the bundled CLI (`lib/engine.mjs`) through the `shell` service.
- **Browser half** (`client.cjs`) registers a microphone button in the
  `conversation.input.left` slot, records with `MediaRecorder`, meters the same stream through
  an `AnalyserNode`, posts the bytes, and calls `inputActions.setDraft()` with the result.

Five details are load-bearing, and every one was found by testing rather than reading:

- **The host stages; the engine only reads.** A confined shell refuses writes outside the
  session workspace — including the platform temp root — so an engine that wrote its own
  decoded copy would fail with `PermissionError`. Keeping every write in the host process
  keeps the engine usable under any sandbox policy.
- **The shell parses a command string with its own interpreter** (`pwsh -Command` on
  Windows). Quoted paths in command position are therefore not an executable to PowerShell,
  so the Windows command is wrapped in `cmd /c`.
- **The route is deferred, not declared.** `webServer` must not be a hard dependency (no
  headless/SDK/ACP profile has one), and it is published *after* this row's `apply` — so
  reading it once there sees `undefined` and the route silently never registers. A second
  row that waits for it is equally wrong: the boot audit fails on any entry left pending
  (`N entry did not activate`). `ctx.inject(['webServer'], …)` is the form that defers
  correctly and stays green everywhere.
- **The tool schema is standard JSON Schema.** The provider validates `parameters` verbatim,
  so requiredness must be the object-level `required: [...]` array. The in-repo
  `defineTool` helper accepts a per-property `required: true` convenience form that is
  rejected on the wire.
- **A slot name is not a service.** The browser Loader resolves a bundle's `inject` list
  before `apply` runs, and the client boot audit fails the page on any pending entry — so
  declaring `conversation.input.left` produced
  `pending (waiting for service: conversation.input.left)` and took the whole Web boot down.
  `slots.inject(…)` is what waits for the slot declaration; the bundle declares only `slots`.
  The timer service is *probed* rather than declared for the same class of reason, and the
  meter degrades harmlessly without it.

The engine venv lives at the **package root** (`<package>/.venv`), resolved from
`lib/engine.mjs`, so both host responsibilities find the same interpreter.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| No microphone button | The bundle is installed in a different profile than the one booted. `dsh web` always means the `web` profile. |
| `pending (waiting for service: webServer)` at boot | An older build declared `webServer` as a hard dependency or as a separate waiting row. Update; the route is now deferred with `ctx.inject`. |
| Button appears but every recording fails with an engine path error | An older build resolved the venv relative to the wrong module. Update, then re-run `python/setup.py`. |
| `Invalid schema for function 'voice_transcribe'` | An older build used the in-repo per-property `required: true` form. Update. |
| `faster-whisper is not installed in this interpreter` | Run `python/setup.py`; or point `pythonPath` at the interpreter you did install into. |
| `ModuleNotFoundError: av` / `metadata_errors` | `av` 19 removed an argument faster-whisper passes. `setup.py` pins `av<19`; reinstall with it. |
| `Microphone permission was denied` | Allow the microphone for the harness origin in your browser's site settings. |
| `no speech was recognized` | The recording was silent or too short. |
| `the transcription engine exited with code 1 … PermissionError` | An older build staged the payload for the child to write. Update. |

## Development

Install the checkout directly into a scratch profile built from the web template:

```sh
dsh --profile voicetest --from-default-profile web --dump-config
dsh plugin --profile voicetest add /path/to/dsh-voice-input
dsh --profile voicetest
```

The engine can be exercised without the harness:

```sh
python/.venv/Scripts/python.exe python/transcribe.py --audio sample.webm
```

Contract tests (`npm test`) cover the host and browser plugin shapes, the row split, the
bundle's registration format, and the tool's parameter schema. They cannot cover browser
behaviour, so `tools/cdp-check.mjs` drives a real Chrome over the DevTools Protocol: it loads
the running page, asserts the client entry applied, clicks the microphone, and samples the DOM
to confirm the clock advances and the meter moves.

```sh
# Against a harness already listening (its logged URL carries the token):
node tools/cdp-check.mjs "http://127.0.0.1:3080/?token=<token>" 9333
```

It launches its own Chrome on a separate debugging port, uses Chrome's fake capture device,
and exits non-zero if the boot audit fails or the meter or clock stays still. That is the half
no unit test can reach — it is what caught the timer and inject defects.

## License

MIT

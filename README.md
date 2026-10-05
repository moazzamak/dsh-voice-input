# dsh-voice-input

Offline local speech-to-text for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) composer.

A microphone button appears in the chat composer. Click it, speak, click again, and the
recognized text is appended to the draft — so you can fix a misheard word and press Enter
yourself. Nothing is uploaded: audio is recorded in your browser, posted to the harness
process on your own machine, and decoded there.

The model loads **once** and stays warm, so later recordings cost only the decode. Measured
on this machine with `base.en` on a Ryzen 7 7800X3D, warm: **~0.4 s per recording** on the CPU
engine, ~0.1 s on the GPU engine. Before that change every recording reloaded the model, which
took ~10 s.

Text appears in the draft while the audio is still being decoded, so a long instruction can be
watched rather than waited for.

## Engines

| | CPU (default) | GPU (`whisper.cpp`) |
| --- | --- | --- |
| decoder | faster-whisper / CTranslate2 | whisper.cpp |
| accelerator | CUDA if an NVIDIA card is present | Vulkan (AMD, Intel, NVIDIA) |
| warm latency, `base.en` | ~0.4 s | ~0.1 s |
| first run | ~0.7 s model load | 1.7–3.3 s once, while the driver compiles Vulkan pipelines |
| in-progress text | progressive, while decoding | one update when the transcript is ready |
| GPU-resident state | none | one model copy (~418 MB) per running engine |

The CPU engine is the default: it is already sub-second warm, its text appears progressively,
and it holds no GPU state that could accumulate. The bundled
[whisper.cpp](https://github.com/ggml-org/whisper.cpp) engine is there because CTranslate2 — and
therefore faster-whisper — accelerates only through CUDA, which leaves AMD cards on Windows
unreachable without it. Set `backend: auto` (or `ggml` to require it) in the row to use it.

## Requirements

- A DSH installation with the Web GUI (the `web` profile).
- **Python 3.9+** on `PATH` for the one-time engine setup (`python` on Windows, `python3` elsewhere).
- [uv](https://docs.astral.sh/uv/) is optional; the setup uses it when present and falls back to `pip`.
- A Chromium-based browser or Firefox with microphone recording support.
- For the GPU engine only: a Vulkan-capable GPU and a Windows whisper.cpp Vulkan build
  (bundled here). Its GGML model downloads on first use (~142 MB).

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

### Cleanup pass

Speech contains filler, false starts, and the occasional mishearing. After recognition, the
transcript is passed through the model this deployment already selects, which removes filler
(`um`, `uh`, a hesitant "like"), collapses stutters, adds punctuation, and fixes obvious
mishearings — while being explicitly forbidden from changing meaning, translating, or touching
identifiers and technical terms.

Worked example, on a deliberately filler-heavy recording:

| Stage | Text |
| --- | --- |
| Whisper | `Umm, so, uhh, like, can you please, you know, refactor the parser and then, umm, run the tests.` |
| Cleaned | `Can you please refactor the parser and then run the tests?` |

A small `cleaned up` marker appears beside the button afterwards, so you know a pass ran.

**The cleanup is best-effort and can never cost you a transcript.** Any of these keeps the
recognizer's own text instead, with the reason written to the host log:

- the cleanup call errors, times out, or returns nothing;
- the rewrite changes length by less than half or more than 1.8× — the signature of a model
  answering the request rather than cleaning it;
- no model route can be resolved.

Turn it off with `polish: off`, or pin it to a specific (small, cheap) route with
`polishProvider` + `polishModel` so cleanup does not ride the large model the agent is using.
The `voice_transcribe` tool accepts `polish: false` per call.

**The cleanup does not think, on purpose.** A model call that names no reasoning effort inherits
the adapter's default, which is `high` on a deployment that configures none — and this plugin
renders only text deltas, never reasoning deltas, so that entire phase is time the user spends
waiting with nothing in the draft. Removing filler words is mechanical work, so the request asks
the route not to reason (`polishReasoning: off`). On a route that cannot express that, the cleanup
is retried once with the deployment's own default rather than being lost.

| `polish` | Behaviour |
| --- | --- |
| `conservative` | clean without spending reasoning tokens — the default, and the fast one |
| `conservative-reasoned` | let the cleanup think; slower, for comparison |
| `off` | return the recognizer's text untouched |

| Key | Default | Meaning |
| --- | --- | --- |
| `polishReasoning` | `off` | Reasoning effort for the cleanup, one of `off`/`low`/`high`/`max`; ignored by `conservative-reasoned` |

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
| `polish` | no | `false` returns the recognizer's text without the cleanup pass |

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
| `polish` | `conservative` | Clean the transcript with a model; `off` returns the raw text |
| `polishTimeoutMs` | `15000` | Deadline for the cleanup call alone |
| `polishProvider` / `polishModel` | current selection | Pin cleanup to a specific route |
| `pythonPath` | package `.venv` | Interpreter with `faster-whisper` |
| `scriptPath` | bundled CLI | The transcription script |
| `cacheDir` | `$DSH_HOME/cache/voice-models` | Model weights cache |

The cleanup uses the model the deployment already selects, so it needs no second credential and
no extra configuration. It is a normal `ctx.llm.stream` call — the same route the agent uses —
and it runs with `temperature: 0` under its own deadline.

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
- **The resident worker reads a live pipe.** The `subprocess` seam exposes a live
  `child.stdout` only for the stdio mode `'pipe'`; a `{maxBytes}` spec routes the bytes to
  `collected` and leaves `child.stdout` `undefined`. The worker needs each protocol line the
  moment it flushes, so it spawns with `'pipe'` — and because nobody else then reads a live
  stderr, it drains that too (an unread OS pipe fills at ~64 KiB and silently blocks the
  child forever). Pending requests are released on exit before any `await`, and `run()`
  enforces `timeoutMs` as a hard deadline, so a wedged request ends in a clean error naming
  the deadline instead of a hang that only killing DSH can clear.

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
| A transcription never returns; only killing DSH clears it | An older build spawned the worker with collected output, which the seam hides behind `collected`, so the pump read `undefined` and no request was ever answered or failed. Update, then restart DSH. |

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

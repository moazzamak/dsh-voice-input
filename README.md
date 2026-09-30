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

The microphone button sits in the composer's tool row, left of the model selector.

| State | What you see |
| --- | --- |
| Idle | Grey microphone |
| Recording | Red stop square, pulsing dot, elapsed `m:ss` |
| Transcribing | Red microphone, `transcribing…` |
| Failure | Red message beside the button (permission denied, no speech, engine error) |

The transcript is appended to whatever the draft already contains, separated by a space.
It is never sent for you.

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

- **Host half** (`index.mjs`) registers one exact POST route, `/voice-input/transcribe`, on
  the composition's `webServer`. It stages the uploaded bytes to a temp file and runs the
  bundled CLI through the `shell` service.
- **Browser half** (`client.cjs`) registers a microphone button in the
  `conversation.input.left` slot, records with `MediaRecorder`, posts the bytes, and calls
  `inputActions.setDraft()` with the result.

Two details are load-bearing, and both were found by testing rather than reading:

- **The host decodes and stages; the engine only reads.** A confined shell refuses writes
  outside the session workspace — including the platform temp root — so an engine that
  wrote its own decoded copy would fail with `PermissionError`. Keeping every write in the
  host process keeps the engine usable under any sandbox policy.
- **The shell parses a command string with its own interpreter** (`pwsh -Command` on
  Windows). Quoted paths in command position are therefore not an executable to PowerShell,
  so the Windows command is wrapped in `cmd /c`.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| No microphone button | The bundle is installed in a different profile than the one booted. `dsh web` always means the `web` profile. |
| `pending (waiting for service: webServer)` at boot | The profile has no Web GUI. Install into a profile created from the `web` template. |
| `faster-whisper is not installed in this interpreter` | Run `python/setup.py`; or point `pythonPath` at the interpreter you did install into. |
| `ModuleNotFoundError: av` / `metadata_errors` | `av` 19 removed an argument faster-whisper passes. `setup.py` pins `av<19`; reinstall with it. |
| `Microphone permission was denied` | Allow the microphone for the harness origin in your browser's site settings. |
| `no speech was recognized` | The recording was silent or too short. |
| `the transcription engine exited with code 1 … PermissionError` | An older build staged the payload for the child to write. Update to ≥0.1.0 final. |

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

## License

MIT

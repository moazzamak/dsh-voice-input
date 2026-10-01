"""Resident transcription engine for the `dsh-voice-input` plugin.

Why this exists
---------------
The one-shot `transcribe.py` CLI reloads the Whisper model on every request.
That reload is several seconds of pure latency before any audio is decoded, and
it makes intermediate text impossible because the process only ever prints one
final JSON line.

This script is a long-lived worker instead. It reads one JSON request per line
on stdin and writes one JSON event per line on stdout, so the host can:

  * load the model ONCE and keep it warm across recordings;
  * forward each decoded segment the moment faster-whisper yields it, which is
    what lets the composer show text while the rest of the audio is still being
    decoded;
  * reuse the same process, and therefore the same loaded weights, for every
    later recording.

Device selection
----------------
Nothing here is hard-coded to one machine. `discover()` asks the interpreter and
the OS what accelerators exist, `plan()` ranks the usable ones (discrete before
integrated, more VRAM first), and the highest-ranked plan that actually loads a
model wins. A pinned override always outranks auto-detection:

    HIP_VISIBLE_DEVICES / CUDA_VISIBLE_DEVICES   e.g. "1" or "0,1"

Both are read by the runtime at import time, so the host sets them on this
child's environment; when either is present it decides the device, and this
module only records that fact. `device: "cpu"` in a request forces CPU,
`device: "auto"` (the default) runs the ranking.

Protocol
--------
Request  (one JSON object per line on stdin):
    {"id": "<opaque>", "op": "transcribe", "audio": "<path>", "model": "base.en",
     "language": "en", "computeType": "int8", "device": "auto|gpu|cpu",
     "deviceIndex": 0, "wordTimestamps": false, "beamSize": 1, "vad": true}
    {"id": "<opaque>", "op": "warm",  ...same model fields...}
    {"id": "<opaque>", "op": "caps"}         # report discovery without loading
    {"id": "<opaque>", "op": "release"}      # drop the loaded model
    {"id": "<opaque>", "op": "shutdown"}

Events (one JSON object per line on stdout):
    {"id": ..., "event": "ready",   "backend": ..., "device": ..., "deviceName": ...}
    {"id": ..., "event": "loading", "model": ..., "plan": {...}}
    {"id": ..., "event": "start",   "duration": 6.57, "language": "en", ...}
    {"id": ..., "event": "segment", "text": "...", "start": 1.2, "end": 2.4,
     "index": 0, "elapsed": 0.9}
    {"id": ..., "event": "done",    "text": "<full transcript>", "elapsed": ...}
    {"id": ..., "event": "error",   "message": "...", "code": "..."}

stdout carries protocol lines ONLY. Diagnostics go to stderr, which the host
surfaces verbatim when a request fails.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
import uuid

#: Device preference order for `device: "auto"`: fastest backend first.
BACKEND_PREFERENCE = ("rocm", "cuda", "vulkan", "dml", "cpu")

#: Vendor name fragments that mean "integrated", ranked below real cards.
INTEGRATED_MARKERS = ("graphics", "vega", "uhd", "iris", "radeon(tm) graphics")

_DISCOVERY: dict | None = None



# --------------------------------------------------------------------------- #
# Discovery: what accelerators does this machine actually have?
# --------------------------------------------------------------------------- #


def _run_quiet(argv: list[str], timeout: float = 6.0) -> str:
    """Run one probe command, returning stdout+stderr or '' on any failure."""
    try:
        completed = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except Exception:
        return ""
    return (completed.stdout or "") + (completed.stderr or "")


def _torch_facts() -> dict:
    """What a torch installation offers, if one is present at all.

    A ROCm/HIP build of torch exposes the AMD GPU through its CUDA shim, so
    `torch.cuda.is_available()` is the right question for both vendors; the
    `torch.version.hip` string is what proves the build is ROCm and not CUDA.
    """
    try:
        import torch  # noqa: PLC0415 - optional and expensive to import
    except Exception as error:
        return {"installed": False, "error": f"{type(error).__name__}: {error}"}
    try:
        version = getattr(torch, "version", None)
        hip = getattr(version, "hip", None)
        cuda = getattr(version, "cuda", None)
        available = bool(torch.cuda.is_available())
        devices = []
        if available:
            for index in range(torch.cuda.device_count()):
                entry = {"index": index, "name": torch.cuda.get_device_name(index)}
                try:
                    entry["totalMemoryBytes"] = int(torch.cuda.get_device_properties(index).total_memory)
                except Exception:
                    pass
                devices.append(entry)
        return {
            "installed": True,
            "torchVersion": getattr(torch, "__version__", None),
            "hip": hip,
            "cuda": cuda,
            "kind": "rocm" if hip else ("cuda" if cuda else "cpu-only"),
            "available": available,
            "devices": devices,
        }
    except Exception as error:  # pragma: no cover - defensive
        return {"installed": True, "available": False, "error": f"{type(error).__name__}: {error}"}


def _ctranslate2_facts() -> dict:
    """Whether CTranslate2 itself has an accelerator it will accept."""
    try:
        import ctranslate2  # noqa: PLC0415
    except Exception as error:
        return {"installed": False, "error": f"{type(error).__name__}: {error}"}
    facts: dict = {"installed": True, "version": getattr(ctranslate2, "__version__", None)}
    try:
        facts["cudaDevices"] = int(ctranslate2.get_cuda_device_count())
    except Exception as error:
        facts["cudaDevices"] = 0
        facts["cudaError"] = str(error)
    return facts


def _system_gpus() -> list[dict]:
    """Enumerate every display adapter the OS knows about.

    This is what makes a machine WITHOUT a working compute stack still
    diagnosable: the discrete card shows up here even when no backend can use it
    yet, which is exactly the fact a user needs in order to install one.
    """
    gpus: list[dict] = []
    if sys.platform == "win32":
        command = (
            "Get-CimInstance Win32_VideoController | "
            "Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress"
        )
        raw = _run_quiet(["powershell", "-NoProfile", "-NonInteractive", "-Command", command], timeout=15.0)
        try:
            parsed = json.loads(raw) if raw.strip() else []
            if isinstance(parsed, dict):
                parsed = [parsed]
            for item in parsed:
                gpus.append({
                    "name": str(item.get("Name") or "unknown"),
                    "vramBytes": int(item.get("AdapterRAM") or 0),
                    "driver": item.get("DriverVersion"),
                })
            return gpus
        except Exception:
            return gpus

    # POSIX: nvidia-smi is authoritative where present, rocm-smi otherwise.
    smi = _run_quiet([
        "nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits",
    ])
    for line in smi.splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) >= 2 and parts[0]:
            try:
                vram = int(float(parts[1]) * 1024 * 1024)
            except ValueError:
                vram = 0
            gpus.append({"name": parts[0], "vramBytes": vram, "driver": None})

    rocm = _run_quiet(["rocm-smi", "--showproductname", "--showmeminfo", "vram", "--csv"])
    for line in rocm.splitlines():
        if "card" not in line.lower():
            continue
        match = re.search(r"card\d+", line)
        if match:
            gpus.append({"name": f"AMD {match.group(0)}", "vramBytes": 0, "driver": None})
    return gpus


def discover(refresh: bool = False) -> dict:
    """Probe this machine once, then remember the answer."""
    global _DISCOVERY
    if _DISCOVERY is not None and not refresh:
        return _DISCOVERY

    torch_facts = _torch_facts()
    ct2_facts = _ctranslate2_facts()
    system = _system_gpus()

    # How far can each backend actually get?
    #
    # CTranslate2 is the engine faster-whisper actually decodes with, so a
    # CTranslate2 build that reports CUDA devices is sufficient on its own —
    # no torch required. That is exactly the shape of the official Windows ROCm
    # wheel, where CTranslate2 talks HIP through its CUDA-named device path.
    # torch matters only as a second opinion.
    ct2_devices = int(ct2_facts.get("cudaDevices") or 0)
    torch_gpu = bool(torch_facts.get("installed") and torch_facts.get("available"))
    torch_vendor = torch_facts.get("kind") if torch_gpu else None

    rocm_usable = bool(ct2_devices or (torch_gpu and torch_vendor == "rocm"))
    cuda_usable = bool(ct2_devices or (torch_gpu and torch_vendor == "cuda"))
    vendor = "rocm" if rocm_usable and ct2_devices and not (torch_gpu and torch_vendor == "cuda") else (
        torch_vendor or ("cuda" if cuda_usable else None)
    )

    discovery = {
        "python": sys.version.split()[0],
        "platform": sys.platform,
        "torch": torch_facts,
        "ctranslate2": ct2_facts,
        "systemGpus": system,
        "usable": {
            "rocm": rocm_usable,
            "cuda": cuda_usable,
            # A host-provided whisper.cpp build announces itself here; the Node
            # half sets this when it locates one.
            "vulkan": bool(os.environ.get("DSH_VOICE_VULKAN_BIN")),
        },
        "accelerator": {
            "available": bool(rocm_usable or cuda_usable),
            "vendor": vendor,
            "deviceCount": ct2_devices or (int(torch_facts.get("devices") and len(torch_facts["devices"]) or 0)),
            "via": "ctranslate2" if ct2_devices else ("torch" if torch_gpu else None),
        },
        "overrides": {
            "HIP_VISIBLE_DEVICES": os.environ.get("HIP_VISIBLE_DEVICES"),
            "CUDA_VISIBLE_DEVICES": os.environ.get("CUDA_VISIBLE_DEVICES"),
            "HSA_OVERRIDE_GFX_VERSION": os.environ.get("HSA_OVERRIDE_GFX_VERSION"),
        },
        "note": "",
    }
    if system and not (rocm_usable or cuda_usable):
        discovery["note"] = (
            "GPUs are present but no compute backend can use them from this interpreter. "
            "faster-whisper decodes through CTranslate2, whose PyPI Windows wheels are CUDA-only; "
            "for an AMD card, CTranslate2 publishes separate ROCm wheels that need the matching "
            "ROCm runtime. Without one, this engine runs on the CPU (int8), which is already "
            "several times faster than real time for short utterances."
        )
    _DISCOVERY = discovery
    return discovery


# --------------------------------------------------------------------------- #
# Planning: pick the best usable accelerator for this request
# --------------------------------------------------------------------------- #


def _device_rank(device: dict) -> tuple[int, int]:
    """Sort key: real cards before integrated ones, then more VRAM first."""
    name = str(device.get("name") or "").lower()
    integrated = any(marker in name for marker in INTEGRATED_MARKERS)
    return (0 if integrated else 1, int(device.get("vramBytes") or 0))


def _parse_visible(raw: str | None) -> list[str] | None:
    """Parse a *_VISIBLE_DEVICES value into indices, or None when unset."""
    if raw is None:
        return None
    value = raw.strip()
    if value == "":
        return []
    entries = [entry.strip() for entry in value.split(",") if entry.strip() != ""]
    if not entries:
        return None
    for entry in entries:
        if not entry.isdigit():
            # UUID / name forms exist for NVIDIA. We cannot map those reliably,
            # so treat the variable as opaque and let index 0 mean "as filtered".
            return ["opaque"]
    return entries


def plan(requested: str = "auto", requested_index: int | None = None, compute_hint: str = "") -> dict:
    """Choose backend, device index, and compute type for one request.

    Returns a dict with `backend`, `device`, `deviceIndex`, `computeType`,
    `deviceName`, `reason`, and the raw `discovery` facts behind the choice.
    `compute_hint` is the caller's explicit `computeType`; empty means "follow
    whatever the chosen backend prefers".
    """
    facts = discover()
    overrides = facts["overrides"]
    system = list(facts.get("systemGpus") or [])
    system.sort(key=_device_rank, reverse=True)  # best card first

    torch_facts = facts["torch"]
    accelerator = facts.get("accelerator") or {}
    hip_pinned = _parse_visible(overrides.get("HIP_VISIBLE_DEVICES"))
    cuda_pinned = _parse_visible(overrides.get("CUDA_VISIBLE_DEVICES"))

    def finish(backend: str, device_index: int, compute: str, name: str | None, reason: str) -> dict:
        # An explicit caller compute type always wins over the backend default.
        return {
            "backend": backend,
            "device": "cpu" if backend == "cpu" else "cuda",
            "deviceIndex": device_index,
            "computeType": compute_hint or compute,
            "deviceName": name,
            "reason": reason,
            "discovery": facts,
        }

    if requested == "cpu":
        return finish("cpu", 0, "int8", _best_system_name(system), "cpu requested")

    if requested in ("auto", "gpu"):
        # An explicit pin wins over everything. The accelerator runtime reads
        # these variables at import time and re-indexes the surviving devices
        # from 0, so inside this process the selected card is always index 0 —
        # which is also why the index the user names is reported back verbatim
        # in `reason` rather than echoed as deviceIndex.
        if accelerator.get("available"):
            kind = accelerator.get("vendor") or "cuda"
            names = [entry.get("name") for entry in (torch_facts.get("devices") or [])]
            variable = "HIP_VISIBLE_DEVICES" if hip_pinned is not None else "CUDA_VISIBLE_DEVICES"
            if hip_pinned is not None or cuda_pinned is not None:
                reason = f"{kind} accelerator; device pinned by {variable}={overrides.get(variable)}"
            else:
                count = accelerator.get("deviceCount") or 1
                reason = f"{kind} accelerator via {accelerator.get('via')} ({count} device(s))"
            return finish(kind, 0, "float16", names[0] if names else _best_system_name(system), reason)

        if requested == "gpu":
            reason = "no usable GPU accelerator in this interpreter"
            if not facts.get("systemGpus"):
                reason += " (no GPU reported by the OS)"
            else:
                reason += (
                    " (CTranslate2 reports no CUDA device; its PyPI Windows wheels are CUDA-only,"
                    " and the AMD ROCm wheels need a matching ROCm runtime)"
                )
            return finish("cpu", 0, "int8", _best_system_name(system), reason)
        return finish("cpu", 0, "int8", _best_system_name(system), "no GPU accelerator; using cpu")

    # Unknown request values behave like auto rather than failing the request.
    return finish("cpu", 0, "int8", _best_system_name(system), f"unrecognized device {requested!r}; using cpu")


def _best_system_name(system: list[dict]) -> str | None:
    """The strongest card the OS reports, used to name a CPU fallback honestly."""
    if not system:
        return None
    return str(system[0].get("name") or "") or None


def capabilities() -> dict:
    """Facts for the host and for the GUI's device status line."""
    facts = discover()
    return {
        "python": facts["python"],
        "platform": facts["platform"],
        "torch": facts["torch"],
        "ctranslate2": facts["ctranslate2"],
        "systemGpus": facts["systemGpus"],
        "usable": facts["usable"],
        "overrides": facts["overrides"],
        # whisper.cpp/Vulkan needs no ROCm, so it is reported separately from
        # the CTranslate2 accelerators above.
        "ggml": {
            "binary": os.environ.get("DSH_VOICE_GGML_BIN"),
            "model": os.environ.get("DSH_VOICE_GGML_MODEL"),
            "available": bool(
                os.environ.get("DSH_VOICE_GGML_BIN")
                and os.environ.get("DSH_VOICE_GGML_MODEL")
                and os.path.isfile(str(os.environ.get("DSH_VOICE_GGML_BIN")))
                and os.path.isfile(str(os.environ.get("DSH_VOICE_GGML_MODEL")))
            ),
        },
        "plan": {k: v for k, v in plan("auto").items() if k != "discovery"},
        "note": facts.get("note", ""),
    }


# --------------------------------------------------------------------------- #
# The loaded model
# --------------------------------------------------------------------------- #


class GgmlServer:
    """A resident `whisper-server` (whisper.cpp) child.

    This is the AMD path by default: whisper.cpp reaches an AMD card through
    Vulkan, which needs no ROCm runtime at all, whereas CTranslate2 — and
    therefore faster-whisper — can only accelerate through CUDA on Windows.

    The server owns the model and its Vulkan pipelines for its whole lifetime,
    so the first request after a start pays the pipeline build and every later
    one does not. Measured on an RX 9070 XT with a Vulkan build and `base.en`:
    ready in ~0.30 s including the model load, then ~0.09-0.15 s per request.
    """

    def __init__(self) -> None:
        self._process: subprocess.Popen | None = None
        self._key: tuple | None = None
        self._port: int | None = None
        self._binary = ""
        self._model = ""
        self._load_ms = 0
        self._child_output: list[str] = []

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self._port}"

    @staticmethod
    def configured(request: dict) -> bool:
        """Whether this request names a whisper.cpp binary AND model that exist.

        Checked without touching the filesystem beyond two stats, so it is safe
        to call on every request.
        """
        if str(request.get("backend") or "").lower() != "ggml":
            return False
        binary = str(request.get("ggmlBinary") or "")
        model = str(request.get("ggmlModel") or "")
        return os.path.isfile(binary) and os.path.isfile(model)

    @property
    def running(self) -> bool:
        return self._process is not None and self._process.poll() is None

    def stop(self) -> None:
        process = self._process
        self._process = None
        self._port = None
        self._key = None
        if process is None:
            return
        try:
            if process.stdin is not None:
                process.stdin.close()
        except Exception:
            pass
        try:
            process.terminate()
            process.wait(timeout=8)
        except Exception:
            try:
                process.kill()
            except Exception:
                pass

    def _drain_child_output(self) -> None:
        """Continuously consume the child's combined stdout/stderr.

        This MUST run for the whole life of the child. `whisper-server` logs
        steadily while it loads the model and decodes; if nobody reads the pipe
        it fills (about 64 KiB on Windows) and the native process blocks on
        write forever. That is not hypothetical: with the output left undrained,
        the server started, logged its way to the model load, and then hung —
        0.5 s of CPU and no response — while the same binary answered in 0.1 s
        when run with its output discarded. The tail is kept for diagnostics.
        """
        process = self._process
        if process is None or process.stdout is None:
            return
        try:
            for line in process.stdout:
                self._child_output.append(line.rstrip())
                if len(self._child_output) > 400:
                    del self._child_output[:200]
        except Exception:
            # A closed pipe while shutting down is expected.
            return

    def ensure(self, request: dict, emit) -> None:
        """Start the server for this request's model, or reuse the running one."""
        binary = str(request.get("ggmlBinary") or "")
        model = str(request.get("ggmlModel") or "")
        threads = int(request.get("cpuThreads") or 0)
        device = int(request.get("ggmlDevice") or 0)
        key = (binary, model, threads, device)
        if self.running and key == self._key:
            return
        self.stop()

        if not os.path.isfile(binary):
            raise FileNotFoundError(f"whisper-server not found: {binary}")
        if not os.path.isfile(model):
            raise FileNotFoundError(
                f"whisper.cpp model not found: {model}. Download ggml-base.en.bin "
                f"(~142 MB) from https://huggingface.co/ggerganov/whisper.cpp"
            )

        port = _free_port()
        command = [
            binary, "-m", model,
            "-t", str(threads if threads > 0 else 8),
            "--host", "127.0.0.1", "--port", str(port),
            # Pin the accelerator. Without this, ggml picks the first Vulkan
            # device it finds, which on a desktop with an integrated Radeon is
            # not necessarily the discrete card.
            "-dev", str(device),
        ]
        if request.get("ggmlDisableGpu"):
            # Ask for CPU explicitly, so a broken GPU reports itself instead of
            # quietly being three times slower.
            command.append("--no-gpu")
        emit({"event": "loading", "model": os.path.basename(model), "backend": "vulkan", "port": port})
        started = time.monotonic()
        creation = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        self._process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=creation,
        )
        self._port = port
        self._binary = binary
        self._model = model
        self._key = key
        self._load_ms = 0

        # Start draining BEFORE waiting for the listener: the child blocks as
        # soon as its pipe fills, which happens during model load.
        threading.Thread(target=self._drain_child_output, daemon=True).start()

        # Wait for the listener, watching the child so a crash is reported with
        # the child's own last words rather than as a bare timeout.
        deadline = time.monotonic() + 180.0
        while time.monotonic() < deadline:
            if self._process.poll() is not None:
                # The drain thread already captured the child's output as it
                # arrived, so the tail is available without reading the pipe here.
                detail = " | ".join(self._child_output[-5:])
                raise RuntimeError(f"whisper-server exited during startup: {detail}")
            with socket.socket() as sock:
                sock.settimeout(0.25)
                if sock.connect_ex(("127.0.0.1", port)) == 0:
                    self._load_ms = int((time.monotonic() - started) * 1000)
                    return
            time.sleep(0.05)
        detail = " | ".join(self._child_output[-8:])
        self.stop()
        raise TimeoutError(f"whisper-server did not begin listening within 180 s ({detail})")

    def transcribe(self, request: dict, emit) -> None:
        self.ensure(request, emit)
        audio_path = str(request.get("audio") or "")
        language = str(request.get("language") or "auto") or "auto"
        beam = int(request.get("beamSize") or 1)
        started = time.monotonic()

        body, content_type = _multipart_audio(audio_path, {
            "response_format": "json",
            "language": language,
            "temperature": "0",
            "beam_size": str(beam),
            "best_of": str(max(1, beam)),
        })
        request_http = urllib.request.Request(
            f"{self.base_url}/inference",
            data=body,
            headers={"Content-Type": content_type},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request_http, timeout=float(request.get("timeoutMs") or 300000) / 1000.0) as response:
                raw = response.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")[:400]
            print(f"whisper-server rejected {audio_path}: HTTP {error.code} {detail}", file=sys.stderr)
            raise RuntimeError(f"whisper-server rejected the request ({error.code}): {detail}") from error

        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as error:
            raise RuntimeError(f"whisper-server returned unreadable JSON: {raw[:200]}") from error

        text = str(payload.get("text") or "").strip()
        elapsed = round(time.monotonic() - started, 3)

        # The server answers with the finished transcript; it exposes no
        # per-segment progress over HTTP, so a caller gets one segment here and
        # the UI simply receives its text slightly later than the streaming
        # backend would deliver it.
        emit({
            "event": "start",
            "duration": None,
            "language": payload.get("language") or language,
            "backend": "vulkan",
            "computeType": "fp16",
            "deviceIndex": 0,
            "deviceName": None,
            "segmentsHint": "whisper.cpp",
        })
        if text != "":
            emit({"event": "segment", "index": 0, "start": 0.0, "end": None, "text": text, "elapsed": elapsed})
        emit({
            "event": "done",
            "text": text,
            "segments": 1 if text != "" else 0,
            "elapsed": elapsed,
            "backend": "vulkan",
            "computeType": "fp16",
            "deviceIndex": 0,
            "model": os.path.basename(self._model),
        })


def _free_port() -> int:
    """Ask the OS for an unused loopback port, then release it for the child."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _multipart_audio(audio_path: str, fields: dict[str, str]) -> tuple[bytes, str]:
    """Build a multipart/form-data body carrying one audio file plus text fields."""
    boundary = "----dshvoiceinput" + uuid.uuid4().hex
    parts: list[bytes] = []
    for name, value in fields.items():
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode("utf-8")
        )
    with open(audio_path, "rb") as handle:
        payload = handle.read()
    filename = os.path.basename(audio_path)
    content_type = mimetypes.guess_type(audio_path)[0] or "application/octet-stream"
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n".encode("utf-8")
    )
    parts.append(payload)
    parts.append(f"\r\n--{boundary}--\r\n".encode("utf-8"))
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


class Engine:
    """Owns at most one loaded model at a time, on either backend."""

    def __init__(self) -> None:
        self._key: tuple | None = None
        self._model = None
        self._plan: dict | None = None
        self._ggml = GgmlServer()
        self._ggml_key: tuple | None = None
        self._ggml_plan: dict | None = None

    @staticmethod
    def _key_for(request: dict) -> tuple:
        return (
            str(request.get("model", "base.en")),
            str(request.get("device", "auto")),
            str(request.get("computeType") or ""),
            int(request.get("deviceIndex")) if request.get("deviceIndex") is not None else None,
            int(request.get("cpuThreads") or 0),
            str(request.get("cacheDir") or ""),
        )

    @staticmethod
    def ggml_ready(request: dict) -> bool:
        """Whether this request can be served by whisper.cpp.

        Both the binary and the GGML model must exist, and the caller must not
        have pinned the CPU: `device: "cpu"` means "do not use an accelerator",
        and whisper.cpp would use the GPU when it can.
        """
        if str(request.get("device") or "auto") == "cpu":
            return False
        return GgmlServer.configured(request)

    def warm(self, request: dict, emit) -> None:
        """Load whichever backend this request would use, without transcribing.

        Called when a recording starts, so the model load (and, for whisper.cpp,
        the Vulkan pipeline build) overlaps with the user still speaking.
        """
        if self.ggml_ready(request):
            self._ggml.ensure(request, emit)
            self._ggml_plan = {"backend": "vulkan", "accelerator": "whisper.cpp"}
            return
        self.ensure(request, emit)

    def release(self) -> None:
        self._model = None
        self._key = None
        self._plan = None
        self._ggml.stop()
        self._ggml_key = None
        self._ggml_plan = None

    @property
    def plan_facts(self) -> dict | None:
        return self._plan

    def ensure(self, request: dict, emit) -> None:
        """Load (or reuse) the model this request asks for."""
        key = self._key_for(request)
        if self._model is not None and key == self._key:
            return

        from faster_whisper import WhisperModel  # noqa: PLC0415 - imported once, lazily

        model_name, requested_device, requested_compute, requested_index, cpu_threads, cache_dir = key
        chosen = plan(requested_device, requested_index, requested_compute)
        compute_type = chosen["computeType"]
        index = requested_index if requested_index is not None else chosen["deviceIndex"]

        emit({
            "event": "loading",
            "model": model_name,
            "plan": {k: v for k, v in chosen.items() if k != "discovery"},
        })

        # An accelerator can still refuse a compute type at load time (an older
        # card, a driver without fp16). Retrying int8_float16 on the SAME device
        # keeps the GPU instead of silently dropping to CPU.
        attempts: list[tuple[str, str, int]] = [(chosen["backend"], compute_type, index)]
        if chosen["backend"] != "cpu" and compute_type not in ("int8_float16", "int8"):
            attempts.append((chosen["backend"], "int8_float16", index))
        attempts.append(("cpu", "int8", 0))

        started = time.monotonic()
        failures: list[str] = []
        for backend, candidate_compute, candidate_index in attempts:
            device = "cpu" if backend == "cpu" else "cuda"
            try:
                model = WhisperModel(
                    model_name,
                    device=device,
                    device_index=candidate_index,
                    compute_type=candidate_compute,
                    cpu_threads=cpu_threads,
                    download_root=cache_dir or None,
                )
            except Exception as error:  # noqa: BLE001 - every attempt is reported
                failures.append(f"{backend}/{candidate_compute}: {type(error).__name__}: {error}")
                continue

            self._model = model
            self._key = key
            self._plan = {**chosen, "backend": backend, "computeType": candidate_compute, "deviceIndex": candidate_index}
            if backend == "cpu" and chosen["backend"] != "cpu":
                self._plan["reason"] = f"{chosen['backend']} load failed; using cpu"
            emit({
                "event": "ready",
                "model": model_name,
                "backend": backend,
                "device": device,
                "deviceIndex": candidate_index,
                "computeType": candidate_compute,
                "deviceName": chosen.get("deviceName"),
                "reason": self._plan["reason"],
                "loadMs": int((time.monotonic() - started) * 1000),
                "failures": failures,
                "capabilities": capabilities(),
            })
            return

        raise RuntimeError("no backend could load the model: " + "; ".join(failures))

    # -- one transcription ------------------------------------------------------
    def transcribe(self, request: dict, emit) -> None:
        """Serve one recording, on whichever backend this request can use.

        whisper.cpp (Vulkan) is preferred when its binary and GGML model are
        both present, because it is the only way to reach an AMD card here.
        faster-whisper remains the fallback, and is the streaming one: its
        segment generator yields progress during the decode, which whisper.cpp's
        HTTP surface does not expose.

        A whitelisted caller (`backend: "ggml"`) is NOT allowed to fall through
        to the CPU: it asked for the accelerator, so a broken engine is reported
        with its reason instead of being silently papered over.
        """
        audio_path = str(request.get("audio") or "")
        if not audio_path or not os.path.isfile(audio_path):
            raise FileNotFoundError(f"audio file not found: {audio_path}")

        if self.ggml_ready(request):
            try:
                self._ggml.transcribe(request, emit)
                self._ggml_plan = {"backend": "vulkan", "accelerator": "whisper.cpp"}
                return
            except Exception as error:  # noqa: BLE001 - degrade, or report
                traceback.print_exc(file=sys.stderr)
                reason = f"{type(error).__name__}: {error}"
                # `allowFallback` is the caller's explicit permission to use the
                # CPU. The backend NAME cannot carry this meaning: the host labels
                # every whisper.cpp request "ggml" even when the user's row says
                # `auto`, because that is the engine it chose to advertise.
                if request.get("allowFallback") is False:
                    raise RuntimeError(
                        f"the whisper.cpp engine is unavailable, and this request requires it ({reason})"
                    ) from error
                emit({
                    "event": "status",
                    "stage": "fallback",
                    "detail": {"from": "vulkan", "reason": reason},
                })

        from faster_whisper.audio import decode_audio  # noqa: PLC0415

        self.ensure(request, emit)
        model = self._model
        assert model is not None

        language = request.get("language")
        if language in ("", "auto", "none", None):
            language = None
        beam_size = int(request.get("beamSize") or 1)
        word_timestamps = bool(request.get("wordTimestamps"))
        vad = request.get("vad")
        vad = True if vad is None else bool(vad)

        started = time.monotonic()
        audio = decode_audio(audio_path, sampling_rate=16000)
        decode_ms = int((time.monotonic() - started) * 1000)

        segments, info = model.transcribe(
            audio,
            language=language,
            beam_size=beam_size,
            vad_filter=vad,
            word_timestamps=word_timestamps,
            condition_on_previous_text=False,
        )

        emit({
            "event": "start",
            "duration": float(getattr(info, "duration", 0.0) or 0.0),
            "language": getattr(info, "language", None),
            "languageProbability": getattr(info, "language_probability", None),
            "backend": (self._plan or {}).get("backend"),
            "computeType": (self._plan or {}).get("computeType"),
            "deviceIndex": (self._plan or {}).get("deviceIndex"),
            "deviceName": (self._plan or {}).get("deviceName"),
            "decodeMs": decode_ms,
            "audioSeconds": getattr(info, "duration_after_vad", None),
        })

        pieces: list[str] = []
        count = 0
        # `segments` is a LAZY generator: each iteration performs the decode work
        # for the next window, so emitting as we go is genuine incremental
        # progress rather than a replay of a finished transcript.
        for segment in segments:
            text = (segment.text or "").strip()
            if text == "":
                continue
            pieces.append(text)
            emit({
                "event": "segment",
                "index": count,
                "start": round(float(segment.start), 3),
                "end": round(float(segment.end), 3),
                "text": text,
                "elapsed": round(time.monotonic() - started, 3),
            })
            count += 1

        text = " ".join(pieces).strip()
        emit({
            "event": "done",
            "text": text,
            "segments": count,
            "elapsed": round(time.monotonic() - started, 3),
            "backend": (self._plan or {}).get("backend"),
            "computeType": (self._plan or {}).get("computeType"),
            "deviceIndex": (self._plan or {}).get("deviceIndex"),
            "deviceName": (self._plan or {}).get("deviceName"),
            "model": self._key[0] if self._key else None,
        })


# --------------------------------------------------------------------------- #
# Worker loop
# --------------------------------------------------------------------------- #


class Worker:
    def __init__(self, out) -> None:
        self._out = out
        self._engine = Engine()
        # One request at a time, and a REENTRANT lock because `handle` emits
        # while holding it. `whisper-server` owns a port and a GPU context, so
        # overlapping work must never start a second one alongside the first.
        self._lock = threading.RLock()

    def emit(self, request_id, payload: dict) -> None:
        line = json.dumps({"id": request_id, **payload}, ensure_ascii=False)
        with self._lock:
            self._out.write(line + "\n")
            self._out.flush()

    def shutdown(self) -> None:
        """Release every child process this worker owns. Safe to call twice."""
        with self._lock:
            try:
                self._engine.release()
            except Exception:
                pass

    def handle(self, request: dict) -> None:
        """Serve one request, exclusively."""
        with self._lock:
            self._handle_locked(request)

    def _handle_locked(self, request: dict) -> None:
        request_id = request.get("id")
        op = request.get("op") or "transcribe"
        emit = lambda payload: self.emit(request_id, payload)  # noqa: E731

        if op == "shutdown":
            emit({"event": "bye"})
            self.shutdown()
            raise SystemExit(0)

        if op == "release":
            self._engine.release()
            emit({"event": "released"})
            return

        if op == "caps":
            emit({"event": "caps", "capabilities": capabilities()})
            return

        if op == "warm":
            try:
                # `warm` (not `ensure`): it picks the same backend a transcribe
                # request would, so a prewarm during recording actually loads the
                # engine that will be used. Calling `ensure` here would load
                # faster-whisper and leave the GPU engine cold.
                self._engine.warm(request, emit)
            except Exception as error:  # noqa: BLE001
                traceback.print_exc(file=sys.stderr)
                emit({"event": "error", "message": f"{type(error).__name__}: {error}", "code": "warm-failed"})
            return

        if op != "transcribe":
            emit({"event": "error", "message": f"unknown op: {op}", "code": "bad-op"})
            return

        try:
            self._engine.transcribe(request, emit)
        except Exception as error:  # noqa: BLE001 - every failure becomes one event
            traceback.print_exc(file=sys.stderr)
            emit({
                "event": "error",
                "message": f"{type(error).__name__}: {error}",
                "code": "transcribe-failed",
            })

    def run(self) -> None:
        """Serve requests until stdin closes, then release every child.

        The cleanup in `finally` is load-bearing, not tidiness: `whisper-server`
        holds its model in GPU memory for as long as it lives, so a worker that
        dies without reaping it leaks VRAM until the machine is restarted. That
        is exactly what happened here — the host process was killed and left
        whisper.cpp holding ~400 MB each time.

        A stdin EOF means the host closed the pipe, so this process is now
        orphaned even though nothing asked it to stop.
        """
        try:
            for line in sys.stdin:
                line = line.strip()
                if line == "":
                    continue
                try:
                    request = json.loads(line)
                except json.JSONDecodeError as error:
                    self.emit(None, {"event": "error", "message": f"unreadable request: {error}", "code": "bad-json"})
                    continue
                if not isinstance(request, dict):
                    self.emit(None, {"event": "error", "message": "request must be an object", "code": "bad-json"})
                    continue
                self.handle(request)
        finally:
            self._engine.release()


def _parent_alive(parent_pid: int) -> bool:
    """Whether the process that spawned this worker still exists."""
    if sys.platform == "win32":
        import ctypes  # noqa: PLC0415 - Windows-only

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, parent_pid)
        if not handle:
            return False
        try:
            exit_code = ctypes.c_ulong()
            if kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return exit_code.value == 259  # STILL_ACTIVE
            return True
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(parent_pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _watch_parent(worker: "Worker", parent_pid: int) -> None:
    """Exit if the host dies without closing our stdin.

    A killed Electron host does not always tear its process tree down, and a
    `whisper-server` left behind keeps its model resident on the GPU. Polling the
    parent is the only reliable signal available to a child on Windows.
    """
    while True:
        time.sleep(2.0)
        if not _parent_alive(parent_pid):
            print("parent process is gone; releasing the engine", file=sys.stderr)
            worker.shutdown()
            os._exit(0)


def main() -> int:
    parser = argparse.ArgumentParser(description="Resident faster-whisper worker for dsh-voice-input.")
    parser.add_argument("--caps", action="store_true", help="Print capability facts as one JSON line and exit.")
    args = parser.parse_args()

    if args.caps:
        print(json.dumps(capabilities(), ensure_ascii=False), flush=True)
        return 0

    # Protocol lines must be the only thing on stdout, and every line must be
    # flushed the moment it exists or the host cannot stream it.
    try:
        sys.stdout.reconfigure(encoding="utf-8", newline="\n")
        sys.stdin.reconfigure(encoding="utf-8")
    except Exception:  # pragma: no cover - older interpreters
        pass

    worker = Worker(sys.stdout)
    # A killed host does not always close our stdin or tear down the tree. This
    # is the belt to the `finally` in `run()`'s braces: it guarantees the
    # GPU-resident whisper.cpp child is released even on an abrupt host death.
    parent_pid = os.getppid()
    if parent_pid and parent_pid > 0:
        threading.Thread(target=_watch_parent, args=(worker, parent_pid), daemon=True).start()

    worker.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

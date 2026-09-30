"""One-time setup: build the local speech-to-text engine for `dsh-voice-input`.

Creates a virtual environment inside the package, installs faster-whisper, and
pre-downloads the default model so the first recording transcribes without
network access.

Run it once after installing the plugin:

    python python/setup.py

Options:
    --model small.en        pre-download a different model
    --skip-model            install the engine but download no model yet
    --python <path>         interpreter used to create the venv (default: the
                            running interpreter, or `uv` when available)
    --force                 rebuild an existing environment

Everything is installed under this package's `.venv`; nothing is installed
globally and no system Python is modified.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import venv

PACKAGE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENV_DIR = os.path.join(PACKAGE_DIR, ".venv")

# `av` 19 removed the `metadata_errors` argument that faster-whisper passes to
# `av.open`, so an unbounded install fails at transcribe time. Pin it here, in
# the one place that decides the engine's dependency set.
REQUIREMENTS = ["faster-whisper", "av<19"]


def venv_python(root: str) -> str:
    """The interpreter path inside a virtual environment on this platform."""
    if os.name == "nt":
        return os.path.join(root, "Scripts", "python.exe")
    return os.path.join(root, "bin", "python")


def run(command: list[str], description: str) -> None:
    print(f"==> {description}", flush=True)
    completed = subprocess.run(command)
    if completed.returncode != 0:
        raise SystemExit(f"setup failed ({description}): exit code {completed.returncode}")


def uv_path() -> str | None:
    """The `uv` launcher, which installs this dependency set far faster than pip."""
    return shutil.which("uv") or shutil.which("uv.exe")


def create_environment(python_path: str, force: bool) -> None:
    if os.path.isdir(VENV_DIR) and force:
        shutil.rmtree(VENV_DIR)
    if os.path.isfile(venv_python(VENV_DIR)):
        print(f"==> reusing the existing environment at {VENV_DIR}")
        return
    uv = uv_path()
    if uv is not None:
        run([uv, "venv", "--python", python_path, VENV_DIR], "creating the virtual environment (uv)")
    else:
        print(f"==> creating the virtual environment at {VENV_DIR}")
        venv.EnvBuilder(with_pip=True, clear=False).create(VENV_DIR)


def install_engine(python_path: str) -> None:
    uv = uv_path()
    if uv is not None:
        run([uv, "pip", "install", "--python", python_path, *REQUIREMENTS], f"installing {', '.join(REQUIREMENTS)}")
    else:
        run([python_path, "-m", "pip", "install", "--upgrade", "pip"], "upgrading pip")
        run([python_path, "-m", "pip", "install", *REQUIREMENTS], f"installing {', '.join(REQUIREMENTS)}")


def download_model(python_path: str, model: str) -> None:
    cache_dir = os.path.join(os.path.expanduser("~"), ".dsh", "cache", "voice-models")
    script = os.path.join(PACKAGE_DIR, "python", "transcribe.py")
    print(f"==> downloading the {model} model into {cache_dir}", flush=True)
    # A silent 1-second clip: enough to make the CLI load (and therefore fetch)
    # the model, without needing real speech or a recording device.
    probe_dir = os.path.join(cache_dir, "tmp", "setup-probe")
    os.makedirs(probe_dir, exist_ok=True)
    probe = os.path.join(probe_dir, "silence.wav")
    with open(probe, "wb") as sink:
        sink.write(silent_wav_bytes())
    completed = subprocess.run([
        python_path, script,
        "--audio", probe,
        "--model", model,
        "--cache-dir", cache_dir,
    ], capture_output=True, text=True)
    if completed.returncode != 0:
        # The model download is a convenience, not a precondition: the plugin
        # downloads on first use too. Report and continue.
        print("==> model pre-download did not complete; the plugin will fetch it on first use")
        tail = (completed.stderr or completed.stdout).strip().splitlines()[-3:]
        for line in tail:
            print(f"    {line}")
        return
    print(f"==> {model} ready")


def silent_wav_bytes(seconds: int = 1, sample_rate: int = 16000) -> bytes:
    """A minimal mono 16-bit PCM WAV of silence."""
    import struct

    frames = b"\x00\x00" * (sample_rate * seconds)
    header = b"RIFF" + struct.pack("<I", 36 + len(frames)) + b"WAVE"
    header += b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16)
    header += b"data" + struct.pack("<I", len(frames))
    return header + frames


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the local faster-whisper engine for dsh-voice-input.")
    parser.add_argument("--model", default="base.en", help="Model to pre-download (default: base.en).")
    parser.add_argument("--skip-model", action="store_true", help="Install the engine without downloading a model.")
    parser.add_argument("--python", default=sys.executable, help="Interpreter used to create the venv.")
    parser.add_argument("--force", action="store_true", help="Rebuild an existing environment.")
    args = parser.parse_args()

    print(f"==> package: {PACKAGE_DIR}")
    create_environment(args.python, args.force)
    interpreter = venv_python(VENV_DIR)
    install_engine(interpreter)

    verify = subprocess.run(
        [interpreter, "-c", "import faster_whisper, av; print('faster-whisper', faster_whisper.__version__, '| av', av.__version__)"],
        capture_output=True, text=True,
    )
    if verify.returncode != 0:
        raise SystemExit(f"setup failed (engine import): {verify.stderr.strip()}")
    print(f"==> {verify.stdout.strip()}")

    if not args.skip_model:
        download_model(interpreter, args.model)

    print()
    print("Voice input is ready. Restart the harness if it was running:")
    print("  dsh plugin --profile <name> add dsh-voice-input")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

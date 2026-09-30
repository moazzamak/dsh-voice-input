"""Transcribe one audio file with faster-whisper and print a JSON result.

This is the local speech-to-text engine behind the `dsh-voice-input` plugin. It
runs entirely offline once a model is cached; nothing is uploaded anywhere.

Usage:
    python transcribe.py --audio <path> [--model base.en] [--language en] [--compute-type int8]

stdout: one JSON object, e.g.
    {"ok": true, "text": "hello world", "language": "en", "languageProbability": 0.98,
     "duration": 3.2, "audioSeconds": 3.2, "elapsed": 1.1, "model": "base.en"}

stderr: a human-readable message on failure; the process exits non-zero.

The caller stages the audio file and this process only reads it, so it works
unchanged under a confined shell that denies writes outside the workspace.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback

# Model weights are cached here so the engine keeps working with no network at all.
DEFAULT_CACHE = os.path.join(os.path.expanduser("~"), ".dsh", "cache", "voice-models")

# Hugging Face endpoint override, for networks where huggingface.co is blocked.
# Set DSH_VOICE_HF_ENDPOINT (for example https://hf-mirror.com) to use a mirror.
HF_ENDPOINT_ENV = "DSH_VOICE_HF_ENDPOINT"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Transcribe an audio file with faster-whisper.")
    parser.add_argument("--audio", required=True, help="Path of the audio file to transcribe.")
    parser.add_argument("--model", default="base.en", help="Whisper model size or name (default: base.en).")
    parser.add_argument("--language", default="en", help="Spoken language code, or 'auto' to detect (default: en).")
    parser.add_argument(
        "--compute-type",
        default="int8",
        help="CTranslate2 compute type; int8 is the fast CPU default (default: int8).",
    )
    parser.add_argument("--beam-size", type=int, default=1, help="Beam width; 1 is greedy and fastest (default: 1).")
    parser.add_argument("--cache-dir", default=DEFAULT_CACHE, help="Directory holding downloaded model weights.")
    return parser


def fail(message: str, code: int = 1) -> None:
    print(message, file=sys.stderr, flush=True)
    raise SystemExit(code)


def main() -> int:
    args = build_parser().parse_args()

    if not os.path.isfile(args.audio):
        fail(f"audio file not found: {args.audio}", 2)

    endpoint = os.environ.get(HF_ENDPOINT_ENV)
    if endpoint:
        os.environ["HF_ENDPOINT"] = endpoint

    os.makedirs(args.cache_dir, exist_ok=True)

    try:
        from faster_whisper import WhisperModel
    except ImportError as error:  # pragma: no cover - setup failure, reported to the caller
        fail(
            "faster-whisper is not installed in this interpreter: "
            f"{error}. Run `python python/setup.py` from the dsh-voice-input package.",
            3,
        )

    language = None if args.language in ("", "auto", "none") else args.language

    started = time.monotonic()
    try:
        model = WhisperModel(
            args.model,
            device="cpu",
            compute_type=args.compute_type,
            download_root=args.cache_dir,
        )
        segments, info = model.transcribe(
            args.audio,
            language=language,
            beam_size=args.beam_size,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        # segments is a lazy generator: the decode happens while this is consumed.
        text = " ".join(segment.text.strip() for segment in segments).strip()
    except Exception as error:  # noqa: BLE001 - any backend failure becomes one reported diagnostic
        # The full traceback goes to stderr, which the plugin surfaces to the
        # user: a one-line message alone cannot distinguish a broken dependency
        # from unsupported audio.
        traceback.print_exc()
        fail(f"transcription failed: {type(error).__name__}: {error}", 4)

    payload = {
        "ok": True,
        "text": text,
        "language": getattr(info, "language", None),
        "languageProbability": getattr(info, "language_probability", None),
        "duration": getattr(info, "duration", None),
        "audioSeconds": getattr(info, "duration_after_vad", None),
        "elapsed": round(time.monotonic() - started, 3),
        "model": args.model,
    }
    print(json.dumps(payload, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

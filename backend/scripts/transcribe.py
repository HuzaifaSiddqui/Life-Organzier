"""Local speech-to-text for WhatsApp voice notes (backend/src/ai/stt.ts FasterWhisperProvider).

Prints one JSON line: {"text": ..., "language": ..., "confidence": 0..1 or null}. Audio never leaves this machine.
Needs: python -m pip install -r scripts/requirements-voice.txt (faster-whisper). The model downloads on first use.
"""
import argparse
import json
import math
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True)
    parser.add_argument("--model", default="small")
    parser.add_argument("--check", action="store_true", help="only check that faster-whisper is installed")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("faster-whisper is not installed. Run: python -m pip install -r scripts/requirements-voice.txt", file=sys.stderr)
        return 2
    if args.check:
        print(json.dumps({"ok": True}))
        return 0

    try:
        model = WhisperModel(args.model, device="cpu", compute_type="int8")
        segments, info = model.transcribe(args.file, beam_size=5)
        segments = list(segments)
        text = " ".join(segment.text.strip() for segment in segments).strip()
        logprobs = [segment.avg_logprob for segment in segments if segment.avg_logprob is not None]
        confidence = math.exp(sum(logprobs) / len(logprobs)) if logprobs else None
        print(json.dumps({"text": text, "language": info.language, "confidence": confidence}))
        return 0
    except Exception as error:  # noqa: BLE001 - reported to the caller as a failed transcription
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

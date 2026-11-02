"""Does the microphone this pipeline listens to actually hear you?

The one question the system could not answer about itself. A conversation that
stores nothing looks identical to one that was never listened to, because the
only difference lives in counters the transcriber throws away.

This measures the SAME signal the transcriber gates on, against the SAME
threshold, on the SAME device, and tells you which side of it you are.

    python ai/../scripts/check_mic.py          10 seconds, default device
    python scripts/check_mic.py --seconds 20
    python scripts/check_mic.py --device 5     one of the devices it lists
    python scripts/check_mic.py --transcribe   also run Whisper on it

Run it, then talk normally from where the wearer would be. If the bars stay
under the gate while you are speaking, the microphone is not the one near the
conversation -- which is the expected result when the pipeline runs on a laptop
and the camera is somewhere else, because cv2.VideoCapture carries no audio and
this listens to the local machine, never the stream.
"""

from __future__ import annotations

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ai.audio_capture import AudioCapture, SILENCE_RMS   # noqa: E402


def rms(block) -> float:
    return float((block.astype("float64") ** 2).mean() ** 0.5)


def bar(value: float, gate: float, width: int = 36) -> str:
    """Log scale, because speech sits one to two decades above a quiet room
    and a linear bar spends all its width on the gap between them."""
    import math
    floor = 1e-5
    lo, hi = math.log10(floor), math.log10(gate * 25)
    pos = (math.log10(max(value, floor)) - lo) / (hi - lo)
    n = max(0, min(width, int(pos * width)))
    gate_at = max(0, min(width - 1, int(((math.log10(gate) - lo) / (hi - lo)) * width)))
    cells = ["#" if i < n else "." for i in range(width)]
    cells[gate_at] = "|" if cells[gate_at] == "." else "|"
    return "".join(cells)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=10.0)
    ap.add_argument("--device", type=int, default=None)
    ap.add_argument("--transcribe", action="store_true",
                    help="run the same Whisper pass the pipeline would")
    args = ap.parse_args()

    try:
        import sounddevice as sd
    except Exception as e:
        print(f"sounddevice is not installed: {e}")
        print("It is what AudioCapture uses. Without it there is no audio at all.")
        return 2

    print("Input devices this machine offers:")
    for i, d in enumerate(sd.query_devices()):
        if d["max_input_channels"] > 0:
            mark = " <- default" if i == sd.default.device[0] else ""
            print(f"  [{i:2}] {d['name'][:58]}{mark}")
    print()

    cap = AudioCapture(device=args.device)
    if not cap.start():
        print(f"Could not open the microphone: {cap.last_error}")
        print("This is exactly what makes the pipeline run with transcriber=None.")
        return 1

    gate = SILENCE_RMS
    print(f"Listening for {args.seconds:.0f}s. Talk normally, from where the wearer")
    print(f"would be. The | is the silence gate ({gate}); bars must pass it.")
    print()

    loud = 0
    checks = 0
    peak = 0.0
    t_end = time.time() + args.seconds
    while time.time() < t_end:
        time.sleep(0.5)
        block = cap.read_window(0.5)
        if block is None:
            continue
        v = rms(block)
        peak = max(peak, v)
        checks += 1
        if v >= gate:
            loud += 1
        print(f"  {bar(v, gate)}  rms={v:.5f}  {'HEARD' if v >= gate else 'silence'}")

    print()
    if checks == 0:
        print("No audio was read at all. The device opened but produced nothing.")
        cap.stop()
        return 1

    print(f"{loud} of {checks} half-second windows cleared the gate. Peak rms {peak:.5f}, "
          f"gate {gate} ({peak / gate:.1f}x).")
    if loud == 0:
        print()
        print("Every window counted as silence, which is what the transcriber does")
        print("with them: skipped, never sent to Whisper, nothing stored. If you")
        print("were speaking just now, this microphone is not the one near the")
        print("conversation -- the pipeline hears the machine it runs on, not the")
        print("camera's stream.")

    if args.transcribe and peak >= gate:
        print()
        print("Running the same Whisper pass the pipeline would...")
        from ai.transcriber import Transcriber
        t = Transcriber(user_id="")
        t.capture = cap
        window = cap.read_window(min(args.seconds, 10.0))
        text = t.transcribe_window(window) if window is not None else None
        print(f"  -> {text!r}")
        if text is None:
            print(f"     (silent={t.windows_skipped_silent} "
                  f"invented={t.windows_skipped_invented} error={t.last_error})")

    cap.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

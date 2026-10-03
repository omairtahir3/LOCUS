"""Module A FE-1: the audio half of capture.

The pipeline has always read video through cv2.VideoCapture, which cannot carry
audio at all, so FE-1's "capture video AND audio" was half done. This adds the
other half as a rolling window of recent microphone audio, shaped like the
keyframe extractor's rolling window of recent frames: a fixed span of history
that the transcriber reads from, overwritten continuously.

NOTHING HERE IS EVER WRITTEN TO DISK. The ring buffer is memory the operating
system hands back on exit, the transcriber reads from it and keeps only text,
and no code path in this module opens a file. That is the decision behind
FE-3's "transcript text only": a household's audio is the most invasive thing
this system could hold, and an mp3 of it is not evidence anyone asked for.

Capture is optional and non-fatal by design. A machine with no microphone, a
denied permission, or a device already held by another process leaves
`available` false, and the pipeline runs exactly as it did before.

ponytail: sounddevice, which was ALREADY installed, rather than pyaudio or a
wrapper over an ffmpeg subprocess. It is a thin CFFI binding over PortAudio and
hands back the numpy array this needs with no copy or conversion step.
"""

from __future__ import annotations

import threading
import numpy as np

# Whisper resamples everything to 16 kHz mono internally, so capturing at
# exactly that costs nothing and saves a resample per window. 30 s of it is
# 1.9 MB, which is the whole memory cost of this file.
SAMPLE_RATE = 16000
CHANNELS = 1
BUFFER_SECONDS = 30.0

# Below this RMS a window is a quiet room, and is never transcribed. This is not
# only a saving: Whisper asked to transcribe silence invents text, reliably and
# confidently ("Thank you.", "Subtitles by..."), because nothing in its training
# looked like nothing. The gate is the fix for that, not an optimisation.
SILENCE_RMS = 0.004


class AudioCapture:
    """A rolling window of the most recent `BUFFER_SECONDS` of microphone audio.

    The buffer is fed by PortAudio's callback thread and read by the
    transcriber's thread, so every touch of it is under one lock. Writes are
    small and frequent, reads are large and rare, which is the cheap direction
    for a lock to be contended.
    """

    def __init__(self, sample_rate: int = SAMPLE_RATE, buffer_seconds: float = BUFFER_SECONDS,
                 device=None):
        self.sample_rate = int(sample_rate)
        self.capacity = int(self.sample_rate * buffer_seconds)
        self.device = device
        self._buf = np.zeros(self.capacity, dtype=np.float32)
        self._written = 0          # total samples ever written, not an index
        self._lock = threading.Lock()
        self._stream = None
        self.available = False
        self.last_error = None

    # -- the feed ---------------------------------------------------------

    def feed(self, samples: np.ndarray) -> None:
        """Append samples, overwriting the oldest. Separate from the stream
        callback so the ring behaviour is testable without a microphone."""
        block = np.asarray(samples, dtype=np.float32).reshape(-1)
        if block.size == 0:
            return
        # A block longer than the whole buffer can only leave its tail.
        if block.size >= self.capacity:
            block = block[-self.capacity:]
        with self._lock:
            start = self._written % self.capacity
            end = start + block.size
            if end <= self.capacity:
                self._buf[start:end] = block
            else:
                split = self.capacity - start
                self._buf[start:] = block[:split]
                self._buf[:end - self.capacity] = block[split:]
            self._written += block.size

    def _callback(self, indata, frames, time_info, status):
        if status:
            # Overflows say the consumer fell behind. The window is a ring, so
            # the only consequence is a gap, and raising here would kill the
            # capture thread over something recoverable.
            self.last_error = str(status)
        self.feed(indata[:, 0] if indata.ndim > 1 else indata)

    # -- lifecycle --------------------------------------------------------

    def start(self) -> bool:
        """Open the microphone. False, never an exception, when it cannot."""
        if self.available:
            return True
        try:
            import sounddevice as sd
            self._stream = sd.InputStream(
                samplerate=self.sample_rate, channels=CHANNELS, dtype="float32",
                device=self.device, callback=self._callback,
                # A tenth of a second per callback: short enough that a window
                # read is never waiting on the current block, long enough not
                # to wake the thread constantly.
                blocksize=int(self.sample_rate * 0.1),
            )
            self._stream.start()
            self.available = True
            return True
        except Exception as e:
            # No device, no permission, or PortAudio missing. Capture is an
            # addition to the pipeline, never a requirement of it.
            self.last_error = f"{type(e).__name__}: {e}"
            self._stream = None
            self.available = False
            return False

    def stop(self) -> None:
        stream, self._stream = self._stream, None
        self.available = False
        if stream is not None:
            try:
                stream.stop()
                stream.close()
            except Exception:
                pass

    # -- the read ---------------------------------------------------------

    def read_window(self, seconds: float) -> np.ndarray | None:
        """The most recent `seconds` of audio, oldest sample first.

        None when less than that much has been captured, so a caller never
        transcribes a window half full of the zeros it was initialised with.
        """
        want = int(self.sample_rate * seconds)
        if want <= 0:
            return None
        want = min(want, self.capacity)
        with self._lock:
            if self._written < want:
                return None
            end = self._written % self.capacity
            start = end - want
            if start >= 0:
                return self._buf[start:end].copy()
            # Wrapped: the tail of the buffer is older than its head.
            return np.concatenate((self._buf[start:], self._buf[:end]))

    @property
    def seconds_captured(self) -> float:
        with self._lock:
            return min(self._written, self.capacity) / self.sample_rate


def is_silent(samples: np.ndarray, threshold: float = SILENCE_RMS) -> bool:
    """Whether a window holds nothing worth transcribing."""
    if samples is None or samples.size == 0:
        return True
    return float(np.sqrt(np.mean(np.square(samples, dtype=np.float64)))) < threshold

"""Module A FE-3: speech to text over the captured audio.

Runs faster-whisper locally. Nothing is sent anywhere: the audio stays in the
ring buffer in memory, the model runs on this machine, and the only thing that
leaves this file is text. That was the point of choosing a local model over an
API for a system that listens inside someone's home.

It runs BEHIND the stream, not inside it. Measured on this machine, tiny/int8
transcribes at about 5x realtime and base at 2.4x, so a worker thread chewing
through 10 s windows keeps up comfortably while the capture loop never waits on
it. tiny is the default on measurement rather than habit: it was both twice as
fast as base AND more accurate on the words this system actually cares about
(base heard "pentadal" for Panadol, tiny heard "panadol").

Two things that would otherwise make the output worse than useless:

  - Silence. Asked to transcribe a quiet room Whisper invents text, reliably,
    because nothing in its training looked like nothing. The RMS gate in
    audio_capture drops those windows before the model sees them, and
    HALLUCINATIONS catches the handful of phrases that still get through.

  - Proper nouns. Both model sizes mangle exactly the words that matter:
    "Omair" became "O'Mare", "Panadol" became "pentadal". The user's OWN
    enrolled belongings, people and medicines are passed as initial_prompt,
    which is the same closed vocabulary the memory-search agent links against.
    That fixed Panadol outright and moved "O'Mare" to "Omer", so uncommon
    personal names stay APPROXIMATE: anything matching a transcript against a
    name must do it fuzzily, not exactly.
"""

from __future__ import annotations

import os
import threading
import time
from collections import deque
from datetime import datetime, timezone, timedelta

from .audio_capture import AudioCapture, is_silent

MODEL_SIZE = os.environ.get("WHISPER_MODEL", "tiny")
# int8 on CPU. float32 is slower for no accuracy gain at this size.
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE", "int8")

# How much audio each pass transcribes. Long enough for a whole sentence to sit
# inside one window, short enough that a transcript is attached to an event
# while the event is still recent.
WINDOW_SECONDS = float(os.environ.get("TRANSCRIBE_WINDOW_SECONDS", 10.0))

# Transcripts age out on the same clock as the images they sit beside. FE-8 puts
# that at 24-42 h and the keyframe default is 36, so a transcript never outlives
# the frame it describes.
TRANSCRIPT_TTL_HOURS = int(os.environ.get("KEYFRAME_TTL_HOURS", "36"))

# How many recent segments stay in memory for an event to pick up. 12 windows is
# two minutes of history, which is far more than any event needs to reach back.
RECENT_SEGMENTS = 12

# What Whisper says when it has been given nothing to hear. These are not
# transcription errors to be fixed downstream; they are the model's output for
# silence, and storing them would put sentences nobody said into a medical-ish
# record. Matched case-insensitively against the WHOLE segment.
HALLUCINATIONS = {
    "thank you.", "thank you", "thanks for watching!", "thanks for watching.",
    "subtitles by the amara.org community", "subtitles by the amara.org community.",
    "please subscribe.", "you", "you.", ".", "bye.", "bye", "okay.", "ok.",
    "transcription by castingwords", "[music]", "(music)", "[silence]",
}


def _looks_invented(text: str) -> bool:
    t = text.strip().lower()
    if not t:
        return True
    if t in HALLUCINATIONS:
        return True
    # A single repeated token, which is the other shape silence takes.
    words = t.replace(".", " ").replace(",", " ").split()
    return len(words) > 3 and len(set(words)) == 1


class Transcriber:
    """Turns the audio ring buffer into stored text, on its own thread."""

    def __init__(self, user_id: str, capture: AudioCapture | None = None,
                 model_size: str = MODEL_SIZE, window_seconds: float = WINDOW_SECONDS):
        self.user_id = str(user_id)
        self.capture = capture or AudioCapture()
        self.model_size = model_size
        self.window_seconds = float(window_seconds)
        self._model = None
        self._thread = None
        self._stop = threading.Event()
        self._recent = deque(maxlen=RECENT_SEGMENTS)
        self._lock = threading.Lock()
        self._vocab = None
        self.segments_stored = 0
        self.windows_skipped_silent = 0
        self.windows_skipped_invented = 0
        self.last_error = None

    # -- the model --------------------------------------------------------

    def _load_model(self):
        """Loaded on first use, not in __init__: it takes 20-40 s and downloads
        weights the first time, and a pipeline that never hears anything should
        never pay for it."""
        if self._model is None:
            from faster_whisper import WhisperModel
            self._model = WhisperModel(self.model_size, device="cpu", compute_type=COMPUTE_TYPE)
        return self._model

    def vocabulary(self) -> str | None:
        """This user's own belongings, people and medicines, as a prompt.

        Read once and cached: it changes when someone enrols something, which is
        rare, and a database round trip per 10 s window is not worth it.
        """
        if self._vocab is not None:
            return self._vocab or None
        names = []
        try:
            from db_config import get_client, get_db_name
            from bson import ObjectId
            db = get_client()[get_db_name()]
            ids = [self.user_id]
            try:
                ids.append(ObjectId(self.user_id))
            except Exception:
                pass
            q = {"user_id": {"$in": ids}}
            names += [d["item_name"] for d in db.useritems.find(q, {"item_name": 1})
                      if d.get("item_name")]
            names += [d["person_name"] for d in db.relationships.find(q, {"person_name": 1})
                      if d.get("person_name")]
            names += [d["name"] for d in db.medications.find(q, {"name": 1}) if d.get("name")]
        except Exception as e:
            self.last_error = f"vocabulary lookup failed: {e}"
        # Whisper treats initial_prompt as preceding context, so a plain comma
        # list in sentence shape biases without being echoed into the output.
        self._vocab = (", ".join(dict.fromkeys(names)) + ".") if names else ""
        return self._vocab or None

    # -- one pass ---------------------------------------------------------

    def transcribe_window(self, samples) -> str | None:
        """Text for one window, or None when there was nothing real in it."""
        if is_silent(samples):
            self.windows_skipped_silent += 1
            return None
        try:
            model = self._load_model()
            segs, _ = model.transcribe(samples, beam_size=1, language="en",
                                       initial_prompt=self.vocabulary())
            text = " ".join(s.text for s in segs).strip()
        except Exception as e:
            self.last_error = f"{type(e).__name__}: {e}"
            return None
        if _looks_invented(text):
            self.windows_skipped_invented += 1
            return None
        return text

    def store(self, text: str, heard_at: datetime | None = None) -> str | None:
        """Persist one segment and keep it in memory for events to pick up.

        Returns the transcript id, which is what EventContext.transcript_id has
        always been shaped to hold.
        """
        heard_at = heard_at or datetime.now(timezone.utc)
        doc = {
            "user_id": self.user_id,
            "text": text,
            "heard_at": heard_at,
            # Written explicitly rather than relying on a TTL index alone, so
            # the retention is visible in the record itself.
            "expires_at": heard_at + timedelta(hours=TRANSCRIPT_TTL_HOURS),
            "model": self.model_size,
        }
        # The id is appended after the insert below, but the entry goes in now so
        # a reader during a slow insert still sees the text.
        entry = {"text": text, "heard_at": heard_at, "id": None}
        with self._lock:
            self._recent.append(entry)
        try:
            from db_config import get_client, get_db_name
            from bson import ObjectId
            db = get_client()[get_db_name()]
            try:
                doc["user_id"] = ObjectId(self.user_id)
            except Exception:
                pass
            tid = db.transcripts.insert_one(doc).inserted_id
            entry["id"] = str(tid)
            self.segments_stored += 1
            return str(tid)
        except Exception as e:
            self.last_error = f"transcript store failed: {e}"
            return None

    def recent_text(self, window_seconds: float = 30.0) -> str | None:
        """What was heard in the last `window_seconds`, oldest first.

        This is what core/context_providers.AudioContext has always promised and
        returned None for.
        """
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=window_seconds)
        with self._lock:
            parts = [s["text"] for s in self._recent
                     if s["heard_at"].replace(tzinfo=timezone.utc) >= cutoff]
        return " ".join(parts).strip() or None

    def recent_id(self, window_seconds: float = 30.0) -> str | None:
        """The newest stored transcript covering the last `window_seconds`.

        This is what goes on an event: EventRecord has carried a transcript_id
        field since the contracts were written and has never had one to put in
        it. The text itself stays in the transcripts collection, which is also
        what ages it out.
        """
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=window_seconds)
        with self._lock:
            for seg in reversed(self._recent):
                if seg.get("id") and seg["heard_at"].replace(tzinfo=timezone.utc) >= cutoff:
                    return seg["id"]
        return None

    # -- the loop ---------------------------------------------------------

    def _run(self):
        # Staggered so the first pass has a full window behind it rather than
        # reading a buffer that is still mostly the zeros it started as.
        while not self._stop.wait(self.window_seconds):
            try:
                samples = self.capture.read_window(self.window_seconds)
                if samples is None:
                    continue
                text = self.transcribe_window(samples)
                if text:
                    self.store(text)
            except Exception as e:
                # A worker that dies takes transcription down for the session,
                # so every pass is contained.
                self.last_error = f"{type(e).__name__}: {e}"

    def start(self) -> bool:
        """Begin capturing and transcribing. False when there is no microphone,
        which is not an error: the pipeline carries on without audio."""
        if self._thread is not None:
            return True
        if not self.capture.start():
            self.last_error = self.capture.last_error or "no audio input device"
            return False
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name=f"transcriber-{self.user_id[:6]}",
                                        daemon=True)
        self._thread.start()
        return True

    def stop(self) -> None:
        self._stop.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=2.0)
        self.capture.stop()

    def ensure_ttl_index(self):
        """Transcripts expire on their own, the way keyframes do on disk."""
        try:
            from db_config import get_client, get_db_name
            db = get_client()[get_db_name()]
            db.transcripts.create_index("expires_at", expireAfterSeconds=0)
            db.transcripts.create_index([("user_id", 1), ("heard_at", -1)])
            return True
        except Exception as e:
            self.last_error = f"transcript index failed: {e}"
            return False

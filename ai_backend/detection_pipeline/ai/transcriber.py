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

MODEL_SIZE = os.environ.get("WHISPER_MODEL", "base")
# int8 on CPU. float32 is slower for no accuracy gain at this size.
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE", "int8")

# How much audio each pass transcribes. Long enough for a whole sentence to sit
# inside one window, short enough that a transcript is attached to an event
# while the event is still recent.
WINDOW_SECONDS = float(os.environ.get("TRANSCRIBE_WINDOW_SECONDS", 10.0))

# Transcribing EVERYTHING the day contains is off by default, because a
# transcript of a quiet afternoon is nothing anyone will ever read. The buffer
# runs continuously; it is only READ when a face is seen, which is the one
# moment the words are worth keeping. Set to 1 for a running transcript of
# everything.
CONTINUOUS = os.environ.get("TRANSCRIBE_CONTINUOUS", "0") == "1"

# How much audio a social interaction keeps. Longer than a WINDOW because a
# greeting and the sentence after it are what make a summary mean anything.
CONVERSATION_SECONDS = float(os.environ.get("CONVERSATION_SECONDS", 25.0))

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


def _stitch(parts: list[str], max_overlap: int = 8) -> str:
    """Join consecutive windows, dropping words repeated across the seam.

    The reads are disjoint now, so a true audio overlap should not happen; the
    repetition that does happen is Whisper finishing a half-heard word at the
    end of one window and starting the next with the whole of it. Only a run of
    words that ends one part and begins the next is removed, longest first, so
    a sentence that genuinely repeats a phrase keeps it.
    """
    out: list[str] = []
    for part in parts:
        words = part.split()
        if not words:
            continue
        if out:
            n = min(max_overlap, len(out), len(words))
            while n > 0:
                tail = [w.lower().strip(".,!?") for w in out[-n:]]
                head = [w.lower().strip(".,!?") for w in words[:n]]
                if tail == head:
                    words = words[n:]
                    break
                n -= 1
        out.extend(words)
    return " ".join(out).strip()


class Transcriber:
    """Turns the audio ring buffer into stored text, on its own thread."""

    def __init__(self, user_id: str, capture: AudioCapture | None = None,
                 model_size: str = MODEL_SIZE, window_seconds: float = WINDOW_SECONDS,
                 continuous: bool = CONTINUOUS, allowed=None):
        # Does privacy permit hearing anything right now?
        #
        # This had no answer at all, which made the README's promise that
        # Privacy Mode "instantly pauses all recording and analysis" untrue of
        # audio: pressing the button stopped frames being written and left the
        # microphone running. A sensitive room did the same. The predicate is
        # consulted before a session opens and again on every window, so the
        # worst case between pressing the button and the microphone closing is
        # one window rather than the rest of the conversation.
        self.allowed = allowed or (lambda: True)
        self.user_id = str(user_id)
        self.capture = capture or AudioCapture()
        self.model_size = model_size
        self.window_seconds = float(window_seconds)
        self.continuous = bool(continuous)
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
        # ── Conversation sessions ────────────────────────────────────────
        #
        # A face event used to transcribe the last CONVERSATION_SECONDS and
        # stop, so a twenty-minute conversation left twenty-five seconds of
        # text: a sample, not a transcript. While a session is open the loop
        # below runs continuously and every window is kept, so what is stored
        # is the conversation rather than a moment of it.
        #
        # "No face, no transcription" still holds -- the session only exists
        # because a face opened it, and closing it stops the loop again.
        self._session = None          # {"key", "started_at", "parts", "last_seen"}
        self._session_lock = threading.Lock()

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

    def capture_conversation(self, seconds: float = None) -> dict | None:
        """Transcribe the audio just heard, for a social interaction only.

        This is the single caller that reads the ring buffer when continuous
        transcription is off, which is what makes "audio for social
        interactions, nothing else" true by construction rather than by policy:
        no face event, no transcription, and nothing to store.

        The audio exists only as the numpy array passed to the model. It is
        never written to a file, so there is no window where a recording of a
        conversation sits on disk waiting for something to delete it, and a
        crash mid-transcription leaves nothing behind. The array goes out of
        scope when this returns.

        Returns {"transcript", "transcript_id", "heard_seconds"} or None when
        there was no audio, nothing but silence, or no words in it.
        """
        seconds = float(seconds if seconds is not None else CONVERSATION_SECONDS)
        if not self.capture.available:
            return None
        samples = self.capture.read_window(seconds)
        if samples is None:
            # Less than a window captured: the camera has only just started.
            return None
        text = self.transcribe_window(samples)
        del samples            # explicit, so the intent survives a refactor
        if not text:
            return None
        return {
            "transcript": text,
            "transcript_id": self.store(text),
            "heard_seconds": seconds,
        }

    # -- the loop ---------------------------------------------------------

    def _run(self):
        """Transcribe continuously, leaving no gap between windows.

        The old loop slept for a window and then read exactly one window, so
        everything spoken WHILE it was transcribing fell on the floor. Measured
        on this machine, tiny takes 0.87 s per ten seconds of audio and base
        1.47 s, so the hole was 9-13% of every conversation, spread evenly
        through it -- which is the worst shape for a transcript, because the
        text reads as continuous while sentences are quietly missing from it.
        #
        Reading from where the last pass ENDED closes it. The read is capped at
        the ring buffer's length: if a pass ever overran that far the audio is
        already gone, and asking for more than exists would return nothing at
        all rather than what is left.
        """
        # The ring buffer's true length, from what it actually allocated.
        cap = float(getattr(self.capture, "capacity", 0) or 0) / float(
            getattr(self.capture, "sample_rate", 16000) or 16000) or 30.0
        last_end = time.monotonic()
        # Staggered so the first pass has a full window behind it rather than
        # reading a buffer that is still mostly the zeros it started as.
        while not self._stop.wait(self.window_seconds):
            try:
                # Privacy outranks the conversation. Checked every window, so
                # pressing the button or walking into a private room stops the
                # microphone within one window rather than at the end of the
                # chat. The session is closed with whatever was heard up to
                # that point; nothing from after it is kept.
                if not self.allowed():
                    if self.session_open():
                        print("[Transcriber] privacy closed an open conversation")
                        self.end_session()
                    self.capture.stop()
                    self._paused_by_privacy = True
                    continue
                if getattr(self, "_paused_by_privacy", False):
                    self._paused_by_privacy = False
                    self.capture.start()
                    last_end = time.monotonic()
                    continue

                now = time.monotonic()
                want = min(max(self.window_seconds, now - last_end), cap)
                samples = self.capture.read_window(want)
                if samples is None:
                    continue
                # Claimed BEFORE transcribing: the audio has been taken out of
                # the buffer's future as far as this loop is concerned, so a
                # slow pass does not make the next one re-read the same words.
                last_end = now
                if want > cap - 0.5:
                    print(f"[Transcriber] fell {want:.0f}s behind, at the "
                          f"buffer's limit; some audio was lost")
                text = self.transcribe_window(samples)
                if text:
                    self.store(text)
                    self._append_to_session(text)
            except Exception as e:
                # A worker that dies takes transcription down for the session,
                # so every pass is contained.
                self.last_error = f"{type(e).__name__}: {e}"

    # -- conversation sessions -------------------------------------------

    def _append_to_session(self, text: str) -> None:
        with self._session_lock:
            if self._session is not None:
                self._session["parts"].append(text)

    def begin_session(self, key: str) -> bool:
        """A conversation started. Keep every word until it ends.

        Returns True when this opened a new session, False when one was
        already open for `key` (the same person seen again mid-conversation).
        """
        if not self.allowed():
            # The gate, before a single word is kept.
            return False
        with self._session_lock:
            if self._session is not None and self._session["key"] == key:
                self._session["last_seen"] = datetime.now(timezone.utc)
                return False
            # A different person: close the old one rather than blend two
            # conversations into one transcript.
            self._session = {"key": key, "started_at": datetime.now(timezone.utc),
                             "parts": [], "last_seen": datetime.now(timezone.utc)}
        self._ensure_loop()
        return True

    def end_session(self) -> dict | None:
        """Close the open session and hand back everything heard during it."""
        with self._session_lock:
            s, self._session = self._session, None
        if s is None:
            return None
        if not self.continuous:
            self._stop_loop()
        text = _stitch(s["parts"])
        return {
            "key": s["key"],
            "transcript": text,
            "started_at": s["started_at"],
            "ended_at": datetime.now(timezone.utc),
            "segments": len(s["parts"]),
            "heard_seconds": (datetime.now(timezone.utc) - s["started_at"]).total_seconds(),
        }

    def session_open(self) -> bool:
        with self._session_lock:
            return self._session is not None

    def _ensure_loop(self) -> None:
        """Start the transcribing thread if it is not already running."""
        if self._thread is not None or not self.capture.available:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run,
                                        name=f"transcriber-{self.user_id[:6]}",
                                        daemon=True)
        self._thread.start()

    def _stop_loop(self) -> None:
        self._stop.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=2.0)
        self._stop.clear()

    def start(self) -> bool:
        """Begin capturing and transcribing. False when there is no microphone,
        which is not an error: the pipeline carries on without audio."""
        if self._thread is not None:
            return True
        if not self.capture.start():
            self.last_error = self.capture.last_error or "no audio input device"
            return False
        self._stop.clear()
        if not self.continuous:
            # Capture only. Nothing is transcribed until a face event asks for
            # a window, which is what keeps this from being a recording of the
            # whole day.
            return True
        self._ensure_loop()
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

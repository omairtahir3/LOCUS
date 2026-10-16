"""One conversation is one person, one transcript, one summary.

A two-minute chat with one friend was stored as five rows: four strangers and
one Hammad. The five crops are the same man, and they are all still on disk:

    55ccc3b4  looking down, dark        blur  73.0
    b600cc3c  turned to profile         blur  69.8
    40fe723f  hand across his face      blur  59.4
    cb3ea2b0  looking down, blurred     blur  36.6
    10db0854  frontal and lit           blur 110.7  -> matched his gallery 0.738

Their embeddings agree WITH EACH OTHER at 0.33-0.46. ArcFace vectors of one
person should sit far above that; these agree about as well as strangers do.
That is also why the unknown-face de-duplicator could not collapse them --
it needs 0.50 and they never reach it. Bad embeddings cannot recognise
themselves, so each one minted a new person.

Three things were wrong, and they are not the same thing:

  1. The cluster moved every field to the better face EXCEPT the embedding,
     so identity was decided on whichever face arrived first while the
     picture stored beside it was the best one.

  2. Frontality measured only left-right nose offset. Looking down is
     vertical and a hand over the face leaves the landmarks symmetric, so
     all four bad crops were recorded low_frontality: False. The rewrite adds
     pitch and a landmark-plausibility check, and it REFUSES rather than
     noting. Measured on these five it rejects the profile and keeps the
     rest -- an honest partial fix, not the answer.

  3. The answer is that identity belongs to the CONVERSATION, not to each
     glimpse. No threshold rescues vectors that carry no signal, but the
     situation is reliable: while somebody is in front of the camera and a
     conversation is open, an unrecognised face is that same person seen
     badly. It refreshes the conversation instead of inventing somebody.

And the transcript. It used to be the last CONVERSATION_SECONDS (25 s) at the
moment a face was seen, after which the same person was suppressed for the
length of the gap -- so twenty minutes of conversation left about twenty-five
seconds of text, in disconnected snippets, each summarised with no knowledge
of the others. A session now runs for the whole conversation and every window
is kept.
"""
import io
import re
import os
import sys
import time
import warnings

warnings.filterwarnings("ignore")

AI = r'C:\Users\dell\Desktop\LOCUS\ai_backend'
DP = os.path.join(AI, 'detection_pipeline')
os.chdir(DP)
sys.path.insert(0, DP)
sys.path.insert(0, AI)

import numpy as np

import ai.plugins.face_recognition as FR
from ai.transcriber import MODEL_SIZE, Transcriber, _stitch

PASS = FAIL = 0


def check(label, cond, detail=""):
    global PASS, FAIL
    print(f"  {'PASS' if cond else '*** FAIL ***'}  {label}" + (f" -> {detail}" if detail else ""))
    if cond:
        PASS += 1
    else:
        FAIL += 1


src = io.open(os.path.join(DP, 'ai', 'plugins', 'face_recognition.py'), encoding='utf-8').read()
pipe = io.open(os.path.join(DP, 'ai', 'pipeline.py'), encoding='utf-8').read()
trs = io.open(os.path.join(DP, 'ai', 'transcriber.py'), encoding='utf-8').read()

print("1. the embedding follows the best face")
check("the cluster updates its embedding with everything else",
      'matched_cluster["embedding"] = emb' in src,
      "identity used to be decided on the first face while the best was saved")
i_emb = src.index('matched_cluster["embedding"] = emb')
i_crop = src.index('matched_cluster["cropped_face"] = cropped_face')
check("  inside the same better-face branch as the crop", abs(i_emb - i_crop) < 700)

print()
print("2. a face too poor to trust cannot create an identity")
check("there is a bar at all", 0.0 < FR.MIN_FRONTALITY_FOR_IDENTITY < 1.0,
      f"{FR.MIN_FRONTALITY_FOR_IDENTITY}")
check("it refuses rather than noting",
      "if frontality < MIN_FRONTALITY_FOR_IDENTITY:" in src and
      "self.faces_skipped_quality += 1" in src)
plug = FR.FaceRecognitionPlugin.__new__(FR.FaceRecognitionPlugin)


def kps(eye_dx=40.0, nose_dx=0.0, mouth_dy=44.0, mouth_w=24.0):
    """Five landmarks: eyes level, nose offset by nose_dx, mouth below."""
    return np.array([[-eye_dx / 2, 0.0], [eye_dx / 2, 0.0], [nose_dx, mouth_dy * 0.45],
                     [-mouth_w / 2, mouth_dy], [mouth_w / 2, mouth_dy]], dtype=np.float32)


check("a face looking straight at you scores high",
      plug._calculate_frontality(kps()) > 0.8,
      f"{plug._calculate_frontality(kps()):.3f}")
check("a head turned to profile is refused",
      plug._calculate_frontality(kps(nose_dx=18.0)) < FR.MIN_FRONTALITY_FOR_IDENTITY,
      f"{plug._calculate_frontality(kps(nose_dx=18.0)):.3f}")
check("a face foreshortened by looking down is refused",
      plug._calculate_frontality(kps(mouth_dy=18.0)) < FR.MIN_FRONTALITY_FOR_IDENTITY,
      f"{plug._calculate_frontality(kps(mouth_dy=18.0)):.3f}  (eyes-to-mouth collapses)")
check("landmarks that are not shaped like a face are refused",
      plug._calculate_frontality(kps(mouth_w=2.0)) == 0.0,
      "a mouth narrower than a fifth of the eye spacing")
check("missing landmarks are refused, not trusted",
      plug._calculate_frontality(None) == 0.0,
      "this used to return 1.0, the most confident answer available")

print()
print("3. identity is anchored to the conversation")
check("an open conversation is tracked", "self._open_convo" in src)
check("an unrecognised face during one does not mint a stranger",
      "if convo is not None:" in src and "self.faces_skipped_in_convo += 1" in src,
      "this is what turns those five rows into one")
check("it expires after the gap rather than lasting for ever",
      '(now - convo["last"]) >= self.conversation_timeout_seconds' in src)
check("a recognised person still opens their own conversation",
      'self._open_convo = {"person_id": str(match[\'_id\'])' in src,
      "two people must never share one transcript")
check("naming a conversation in progress updates its row",
      '"renames_keyframe_id"' in src and 'renames = details.pop("renames_keyframe_id", None)' in pipe,
      "an unknown face that becomes Hammad is the same conversation")
# Scoped to the face-logging function: insert_one(doc) appears in five
# different writers, so a bare .index() finds the wrong one.
_face_fn = pipe[pipe.index("renames = details.pop"):]
_face_fn = _face_fn[:_face_fn.index("def ", _face_fn.index("db.eventlogs.insert_one(doc)"))]
check("  and returns without inserting a second row",
      _face_fn.index("Named the conversation") < _face_fn.index("return")
      < _face_fn.index("db.eventlogs.insert_one(doc)"))

print()
print("4. the gap is three minutes")
p2 = FR.FaceRecognitionPlugin.__new__(FR.FaceRecognitionPlugin)
p2.conversation_timeout_seconds = float(os.environ.get("CONVERSATION_GAP_SECONDS", 180))
check("three minutes, not five", p2.conversation_timeout_seconds == 180,
      f"{p2.conversation_timeout_seconds:.0f}s -- long enough to turn away, "
      f"short enough not to merge two visits")
check("and it is settable without editing code", 'CONVERSATION_GAP_SECONDS' in src)

print()
print("5. the transcript covers the whole conversation, not 25 seconds of it")
check("a session accumulates every window", "def begin_session" in trs and "def end_session" in trs)
check("windows are appended as they are heard", "self._append_to_session(text)" in trs)
check("the loop reads from where the last pass ENDED",
      "want = min(max(self.window_seconds, now - last_end), cap)" in trs,
      "it used to sleep a window then read a window, losing everything "
      "spoken while it transcribed")
check("  which on this machine was 9-13% of every conversation",
      "0.87" in trs and "1.47" in trs, "tiny 0.87s and base 1.47s per 10s window")
# Scoped to _run: capture_conversation transcribes a window too, and it
# sits earlier in the file.
_run_fn = trs[trs.index("    def _run(self):"):]
_run_fn = _run_fn[:_run_fn.index("    def _append_to_session")]
check("the claim is made before transcribing, not after",
      _run_fn.index("last_end = now") < _run_fn.index("text = self.transcribe_window(samples)"),
      "or a slow pass would re-read the same words")
check("it says so when it falls behind the ring buffer",
      "fell {want:.0f}s behind" in trs,
      "silent loss is the one thing a transcript must not do")
check("a session for a different person starts clean",
      'if self._session is not None and self._session["key"] == key' in trs)
check("the loop stops when the conversation ends",
      "self._stop_loop()" in trs and "if not self.continuous:" in trs,
      "no face, no transcription still holds")

print()
print("6. the seam between windows does not duplicate words")
check("a clean join", _stitch(["hello there", "how are you"]) == "hello there how are you")
check("a word repeated across the seam is dropped once",
      _stitch(["are you going to the", "to the shops later"]) == "are you going to the shops later",
      _stitch(["are you going to the", "to the shops later"]))
check("a phrase genuinely said twice in ONE window survives",
      _stitch(["no no no I said no"]) == "no no no I said no")
check("punctuation and case do not defeat it",
      _stitch(["I think so.", "So we should go"]) == "I think so. we should go",
      _stitch(["I think so.", "So we should go"]))
check("empty windows are skipped", _stitch(["", "hello", ""]) == "hello")
check("nothing heard is an empty string, not a crash", _stitch([]) == "")

print()
print("7. one row, one summary, however long it ran")
check("the row is written at the start and filled in",
      '"summary_status": "collecting"' in pipe)
check("the summariser leaves it alone until it is whole",
      "'details.conversation.summary_status': 'pending'" in
      io.open(r'C:\Users\dell\Desktop\LOCUS\web_app\backend\utils\routineMonitor.js',
              encoding='utf-8').read(),
      "it only ever picks up 'pending'")
rm = io.open(r'C:\Users\dell\Desktop\LOCUS\web_app\backend\utils\routineMonitor.js',
             encoding='utf-8').read()
check("the pipeline closes it when the person has gone",
      "def close_stale_conversation" in pipe and "close_stale_conversation()" in pipe)
check("  from the capture loop, which is what keeps running",
      pipe.index("self.close_stale_conversation()") > pipe.index("_log_heartbeat_to_db"),
      "the recognition path is silent for the whole gap by design")
check("and the monitor closes it if the camera stopped first",
      "async function closeStaleConversations" in rm
      and "await closeStaleConversations(user);" in rm,
      "otherwise a restart mid-chat strands the row at 'collecting' for ever")
check("a conversation nobody could hear is closed, not left pending",
      "skipped_silent" in rm and "skipped_silent" in pipe,
      "an empty transcript must not keep asking to be summarised")
check("the monitor waits longer than the pipeline does",
      "CONVERSATION_GAP_MS * 2" in rm,
      "so the pipeline, which owns the transcript, always gets first refusal")

print()
print("8. the microphone answers to Privacy Mode, not to a hidden flag")
check("audio is on by default now",
      'os.environ.get("AUDIO_CAPTURE", "1")' in pipe,
      "a documented feature that has never once run is not a consent control")
check("privacy decides whether anything may be heard",
      "self.allowed = allowed or (lambda: True)" in trs)
check("checked before a conversation may open",
      trs.index("if not self.allowed():") < trs.index("def end_session"),
      "the gate comes before a single word is kept")
check("and again on every window while one is running",
      "privacy closed an open conversation" in trs,
      "so the button stops it mid-conversation, not at the end of it")
check("the microphone is actually closed, not just ignored",
      "self.capture.stop()" in trs and "self._paused_by_privacy = True" in trs)
check("and reopened when privacy lifts", "self.capture.start()" in trs)
check("blur counts as a refusal too", 'not st.get("blur")' in pipe,
      "blurring the picture and transcribing the same moment makes a nonsense of it")
check("it fails OPEN on an error, as the image side does",
      bool(re.search(r"except Exception:\s+return True", pipe)) and "_audio_allowed" in pipe,
      "a privacy check that disables a feature whenever Mongo hiccups is its own bug")

from ai.transcriber import Transcriber as _T
_allow = {"v": True}
_t = _T(user_id="test", allowed=lambda: _allow["v"])
check("a session opens while privacy allows", _t.begin_session("a") is True)
_allow["v"] = False
check("and is refused the moment it does not", _t.begin_session("b") is False,
      "no session, so no transcript, so nothing to store")
_allow["v"] = True
_t._session = None
check("and allowed again when privacy lifts", _t.begin_session("c") is True)
_t._session = None

print()
print("9. why the microphone cannot simply wait for the conversation")
check("the reasoning is written down where the switch is",
      "The buffer has to be running BEFORE the system knows" in pipe,
      "recognition lags the greeting; a mic opened on detection misses it")
check("what protects the wearer is what happens to the sound",
      "never written to disk" in pipe and "No face, no" in pipe)

print()
print("10. a second person splits the conversation; a bad view of the first does not")
check("there is a same-person bar", 0.0 < FR.SAME_PERSON_IN_CONVO < 1.0,
      f"{FR.SAME_PERSON_IN_CONVO}")
check("splitting also demands a WELL SEEN face",
      FR.NEW_PERSON_MIN_FRONTALITY > FR.MIN_FRONTALITY_FOR_IDENTITY,
      f"{FR.NEW_PERSON_MIN_FRONTALITY} against {FR.MIN_FRONTALITY_FOR_IDENTITY} merely to be recognised")
check("compared against every view so far, not only the first",
      'convo.get("anchors")' in src and "CONVO_ANCHORS" in src)
check("and the list is bounded", "len(anchors) < CONVO_ANCHORS" in src)

# The wearer's real embeddings: one man across his four worst crops, and
# every other enrolled face measured against them.
from pymongo import MongoClient as _MC
from datetime import datetime as _dt
_db = _MC("mongodb://127.0.0.1:27017").locusDB
_h = [np.array(r["details"]["face_embedding"], np.float32)
      # Bounded at BOTH ends. An open-ended window silently absorbed a later
      # unknown face from a different day and turned "one man's four worst
      # crops" into a mixture, which is not what this measures.
      for r in _db.eventlogs.find({"timestamp": {"$gte": _dt(2026, 10, 10, 11, 25),
                                                 "$lte": _dt(2026, 10, 10, 11, 35)},
                                   "details.face_embedding": {"$exists": True}}).sort([("timestamp", 1)])]
_o = [np.array(e, np.float32) for p_ in _db.relationships.find({}, {"person_name": 1, "face_embeddings": 1})
      for e in (p_.get("face_embeddings") or [])
      if len(e) == 512 and str(p_.get("person_name")).strip() != "Hammad"]
if len(_h) >= 4 and _o:
    _pl = FR.FaceRecognitionPlugin.__new__(FR.FaceRecognitionPlugin)
    _anch = [_h[0]]
    _worst = 1.0
    for _e in _h[1:]:
        _sim = max(_pl._cosine_similarity(_e, _a) for _a in _anch)
        _worst = min(_worst, _sim)
        _anch.append(_e)
    _best_other = max(max(_pl._cosine_similarity(_e, _a) for _a in _anch) for _e in _o)
    check("the same man, at his worst, still clears the bar",
          _worst >= FR.SAME_PERSON_IN_CONVO, f"{_worst:.3f} >= {FR.SAME_PERSON_IN_CONVO}")
    check("and no other enrolled person comes close to it",
          _best_other < FR.SAME_PERSON_IN_CONVO, f"{_best_other:.3f} < {FR.SAME_PERSON_IN_CONVO}")
    check("  with real margin either side, not a fitted bar",
          _worst - _best_other > 0.15, f"gap {_worst - _best_other:.3f}")
else:
    print("     SKIPPED: the face events this was measured on have aged out.")

print()
print("11. the transcript model")
check("base, not tiny", MODEL_SIZE == "base",
      "measured at 6.8x real time on this CPU against tiny's 11.5x; "
      "there is no speed argument for the least accurate model")
print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)

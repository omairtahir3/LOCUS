import os
import cv2
import uuid
import threading
from datetime import datetime, timezone
import numpy as np
from numpy.linalg import norm
import insightface
from insightface.app import FaceAnalysis
from pymongo import MongoClient
import traceback

from ..core.plugins import DetectorPlugin
from ..core.contracts import ActionType, DetectionResult, EventContext, ModelReference

# Minimum Laplacian variance — frames below this are too blurry to store
# RTMP phone streams typically score 10-40, so 15.0 only catches genuine motion blur
BLUR_THRESHOLD = 15.0
# Minimum face bounding box area in pixels — reject tiny/far-away faces
MIN_FACE_AREA = 3000

# ── The quality bar a face must clear to become an identity ────────────────
#
# Frontality used to be advisory: it weighted the ranking and set a flag on
# the stored event, and nothing was ever refused for it. One wearer's single
# two-minute conversation therefore produced four separate "unknown" people
# and one correct match, from five crops of the same friend:
#
#     looking down, dark          embedding agrees with the others 0.40-0.46
#     turned to profile                                            0.33-0.45
#     hand across the face                                         0.33-0.46
#     looking down, motion blur                                    0.33-0.44
#     frontal and lit             -> matched his gallery at 0.738
#
# ArcFace vectors of ONE person should sit far above that. These four agree
# with each other about as well as strangers do, which is also why the
# unknown-face de-duplicator could not collapse them: it needs 0.50 and they
# never reach it. Bad embeddings cannot even recognise themselves.
#
# A face the system cannot embed reliably must therefore not be allowed to
# create an identity. Rejecting below this bar is what turns those five events
# into one, and it costs nothing real: the frames keep coming at several per
# second, so a face worth recognising presents a good view within moments.
MIN_FRONTALITY_FOR_IDENTITY = float(os.environ.get("MIN_FRONTALITY", 0.45))

# ── Is this the person we are already talking to, or somebody else? ───────
#
# Absorbing every unrecognised face into the open conversation is what stopped
# one friend becoming four strangers. Taken literally it has a cost: a second
# person who has never been enrolled would be absorbed too, and two people
# would share one transcript -- the one mistake this must never make.
#
# The embeddings are poor, but not uniformly poor, and on this wearer's own
# data they separate cleanly in the direction that matters:
#
#     the SAME man, across his four worst crops     0.327 .. 0.460
#     those crops against every OTHER enrolled face 0.012 .. 0.138
#
# Bad crops of one person stay well above bad crops of different people,
# because ArcFace puts strangers near zero rather than merely lower. 0.25 sits
# between the two with margin either side, and the comparison is against EVERY
# face seen so far in this conversation, not just the first -- so a later bad
# view only has to resemble one earlier view to be recognised as the same
# person.
#
# Deliberately asymmetric: below the bar a face must ALSO be a good one before
# it is allowed to open a second conversation. A poor crop that matches
# nothing is far more likely to be a bad look at the same person than a new
# arrival, and that is exactly the case that produced the four strangers.
SAME_PERSON_IN_CONVO = float(os.environ.get("SAME_PERSON_IN_CONVO", 0.25))
# How sure we must be that a face is WELL SEEN before it may split a
# conversation in two. Higher than the bar for merely being recognised.
NEW_PERSON_MIN_FRONTALITY = float(os.environ.get("NEW_PERSON_MIN_FRONTALITY", 0.70))
# Views of the current speaker kept for that comparison. A conversation does
# not need a hundred; the first few cover the range of how they are being seen.
CONVO_ANCHORS = 8

class FaceRecognitionPlugin(DetectorPlugin):
    action_type = ActionType.SOCIAL_INTERACTION
    model_name = "insightface_buffalo_l"

    def __init__(self, mongo_uri: str = None, db_name: str = None, similarity_threshold: float = 0.65):
        from db_config import get_mongo_uri, get_db_name
        mongo_uri = mongo_uri or get_mongo_uri()
        db_name = db_name or get_db_name()
        import time
        t0 = time.time()
        print(f"[Profiling] FaceRecognitionPlugin init start at {t0}")
        print(f"[{self.model_name}] Initializing FaceRecognitionPlugin...")
        self.similarity_threshold = similarity_threshold
        self.recent_unknowns = []
        self._ru_lock = threading.Lock()  # Protects recent_unknowns from concurrent access
        # How long a person may be out of view before the conversation is
        # treated as over. Three minutes: long enough that turning away or
        # stepping out of frame does not split one chat in two, short enough
        # that two separate visits are not blended into a single transcript
        # and a single summary, which is the worse of the two mistakes.
        self.conversation_timeout_seconds = float(
            os.environ.get("CONVERSATION_GAP_SECONDS", 180))
        self.last_face_seen_time = 0.0
        self.faces_skipped_quality = 0
        self.faces_skipped_in_convo = 0
        # ── The conversation currently in progress ──────────────────────
        #
        # Identity is anchored to the CONVERSATION, not to each glimpse of a
        # face, and this is the fix that actually works. One wearer's
        # two-minute chat produced five rows: four strangers and one friend.
        # The four were the same man looking down, in profile, with a hand
        # across his face, and motion-blurred; their embeddings agreed with
        # each other at 0.33-0.46, below the 0.50 the unknown-face
        # de-duplicator needs, so bad vectors could not even recognise
        # themselves and each one minted a new person.
        #
        # No threshold fixes that, because the vectors carry no usable signal.
        # What is reliable is the situation: while someone is in front of the
        # camera and a conversation is already open, an unrecognised face is
        # overwhelmingly that same person seen badly. So it refreshes the
        # conversation instead of inventing somebody.
        #
        # A face recognised as a DIFFERENT known person still opens its own
        # conversation. Blending two people into one transcript is the worse
        # error, and the one thing this must never do.
        self._open_convo = None       # {"person_id", "keyframe_id", "last", "named"}
        self._social_storage = None   # see _storages(): one instance, one cleanup thread
        self._keyframe_storage = None
        
        # Load InsightFace Model (CPU for free-tier compatibility).
        #
        # allowed_modules is the whole point of this call. buffalo_l is a bundle
        # of five ONNX graphs and FaceAnalysis loads and RUNS all of them per
        # face unless told otherwise. This plugin reads exactly four attributes
        # -- bbox, det_score, kps, normed_embedding -- and all four come from
        # two of the five:
        #
        #   det_10g.onnx      16.1 MB  detection    -> bbox, det_score, kps
        #   w600k_r50.onnx   166.3 MB  recognition  -> normed_embedding
        #   1k3d68.onnx      137.0 MB  3D landmarks     never read
        #   2d106det.onnx      4.8 MB  2D landmarks     never read
        #   genderage.onnx     1.3 MB  gender/age       never read
        #
        # So 143 MB of graphs were resident and three extra inference passes ran
        # on every detected face to produce nothing anybody looked at. The
        # gender/age estimator is worth naming separately: inferring either from
        # a dementia camera is not something this system has any reason to do,
        # and not loading it is better than loading it and ignoring it.
        #
        # kps is the 5-point set that comes WITH detection, which is what
        # _calculate_frontality uses -- it does not need the 106- or 68-point
        # models.
        self.app = FaceAnalysis(name='buffalo_l',
                                allowed_modules=['detection', 'recognition'],
                                providers=['CPUExecutionProvider'])
        self.app.prepare(ctx_id=0, det_size=(640, 640))
        
        # Initialize sync MongoDB client for use in the background threads
        self.client = MongoClient(mongo_uri)
        self.db = self.client[db_name]
        
        print(f"[{self.model_name}] Initialization complete.")
        t1 = time.time()
        print(f"[Profiling] FaceRecognitionPlugin init end at {t1} (took {t1-t0:.2f}s)")

    def supports(self, context: EventContext) -> bool:
        # Run if we have a valid user_id
        return bool(context.user_id)

    def _cosine_similarity(self, embed1: np.ndarray, embed2: np.ndarray) -> float:
        return float(np.dot(embed1, embed2) / (norm(embed1) * norm(embed2)))

    def _match_face(self, embedding: np.ndarray, user_id: str) -> dict | None:
        """
        Compare the embedding against all known relationships for the user.
        Brute-force scan (O(N)) acceptable for FYP.
        """
        try:
            from bson.objectid import ObjectId
            
            # Use ObjectId for the query, because user_id is stored as an ObjectId in the DB
            query_id = ObjectId(user_id) if isinstance(user_id, str) else user_id
            cursor = self.db.relationships.find({"user_id": query_id})
            
            best_match = None
            highest_sim = -1.0
            
            candidates_count = 0
            for rel in cursor:
                embeddings_to_check = []
                if 'face_embeddings' in rel and rel['face_embeddings']:
                    embeddings_to_check.extend(rel['face_embeddings'])
                if 'face_embedding' in rel and rel['face_embedding']:
                    embeddings_to_check.append(rel['face_embedding'])
                
                if not embeddings_to_check:
                    continue
                    
                candidates_count += 1
                
                for known_emb_list in embeddings_to_check:
                    known_embed = np.array(known_emb_list, dtype=np.float32)
                    sim = self._cosine_similarity(embedding, known_embed)
                    print(f"[DEBUG-FACE] Compared against {rel.get('person_name')}: similarity = {sim:.4f}")
                    
                    if sim > highest_sim:
                        highest_sim = sim
                        best_match = rel
                    
            print(f"[DEBUG-FACE] _match_face: best similarity = {highest_sim:.4f} (threshold={self.similarity_threshold})")
            if highest_sim >= self.similarity_threshold:
                match = best_match
                match['match_confidence'] = highest_sim
                return match
        except Exception as e:
            print(f"[{self.model_name}] Error matching face: {e}")
            
        return None

    def _storages(self):
        """Lazily build one instance of each storage and reuse it.

        KeyframeStorage.__init__ starts a cleanup daemon thread, so
        constructing these per detection leaked a thread every event.
        """
        if self._social_storage is None:
            from keyframe_backend.keyframe import SocialInteractionStorage, KeyframeStorage
            self._social_storage = SocialInteractionStorage()
            self._keyframe_storage = KeyframeStorage()
        return self._social_storage, self._keyframe_storage

    def _calculate_frontality(self, kps: np.ndarray) -> float:
        """
        Calculate a frontality score from 5-point facial landmarks.
        kps: (5, 2) array [left_eye, right_eye, nose, left_mouth, right_mouth]
        Returns a score from 0.0 (profile) to 1.0 (perfectly frontal).

        This used to measure one thing: how far the nose sits to the LEFT or
        RIGHT of the midpoint between the eyes. That catches a head turned to
        profile and nothing else, which is how one wearer's conversation
        produced four separate strangers. The four crops were a man looking
        down, a man in profile, a man with his hand over his face, and a dark
        motion-blurred frame -- and every one of them was recorded
        `low_frontality: False`, because none of them was a sideways turn.

        So it now also measures the face looking DOWN, which is vertical and
        was invisible to the old test, and checks the landmarks are arranged
        like a face at all, which is what a hand across the mouth breaks.
        """
        if kps is None or len(kps) < 5:
            return 0.0 if kps is None or len(kps) < 3 else 0.5

        left_eye, right_eye, nose = kps[0], kps[1], kps[2]
        left_mouth, right_mouth = kps[3], kps[4]

        # Interocular distance
        eye_dist = np.linalg.norm(left_eye - right_eye)
        if eye_dist < 1e-6:
            return 0.0

        eye_midpoint = (left_eye + right_eye) / 2.0
        mouth_midpoint = (left_mouth + right_mouth) / 2.0

        # ── Turned left or right: the nose leaves the centre line ──
        yaw_ratio = abs(nose[0] - eye_midpoint[0]) / eye_dist
        yaw = max(0.0, 1.0 - (yaw_ratio * 2.0))

        # ── Looking down or up: the face foreshortens vertically ──
        #
        # Eyes to mouth is about 1.1x the interocular distance on a face
        # looking at you, and it collapses as the chin drops towards the
        # chest. Below about 0.6 the camera is seeing a forehead.
        vertical = float(np.linalg.norm(mouth_midpoint - eye_midpoint)) / eye_dist
        pitch = float(np.clip((vertical - 0.55) / 0.45, 0.0, 1.0))

        # ── Still shaped like a face? ──
        #
        # A hand over the mouth or across the chin leaves the detector
        # guessing at the lower landmarks, and they come back bunched or
        # crossed over. Neither a negative mouth width nor a mouth narrower
        # than a fifth of the eye spacing happens on a face in the open.
        mouth_width = float(np.linalg.norm(right_mouth - left_mouth)) / eye_dist
        plausible = 1.0 if 0.2 <= mouth_width <= 1.6 else 0.0
        # The nose should sit BETWEEN the eyes and the mouth, not outside them.
        if not (min(eye_midpoint[1], mouth_midpoint[1]) - 0.2 * eye_dist
                <= nose[1]
                <= max(eye_midpoint[1], mouth_midpoint[1]) + 0.2 * eye_dist):
            plausible = 0.0

        return float(min(yaw, pitch) * plausible)

    @staticmethod
    def _laplacian_variance(img: np.ndarray) -> float:
        """Compute Laplacian variance as a blur metric. Higher = sharper."""
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img
        return cv2.Laplacian(gray, cv2.CV_64F).var()

    def analyze(self, event_buffer: list[dict], context: EventContext) -> DetectionResult | None:
        """
        Extract faces from the event buffer keyframes, cluster them, pick the best posture,
        and compare against the DB or recent unknowns.
        """
        if not event_buffer:
            return None
            
        # Sample 5 keyframes
        step = max(1, len(event_buffer) // 5)
        sample_frames = event_buffer[::step][:5]
        
        clusters = [] # list of dicts
        
        for frame_meta in sample_frames:
            img = frame_meta.get("raw_frame")
            if img is None:
                continue

            # ── Blur gate: skip entire frame if it's too blurry ──
            blur_score = self._laplacian_variance(img)
            if blur_score < BLUR_THRESHOLD:
                continue

            try:
                faces = self.app.get(img)
                faces = [f for f in faces if f.det_score > 0.5]
                for f in faces:
                    emb = f.normed_embedding
                    bbox = f.bbox.astype(int)
                    area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])

                    # ── Skip tiny faces (too far away to be useful) ──
                    if area < MIN_FACE_AREA:
                        continue
                        
                    frontality = self._calculate_frontality(f.kps)
                    # Refused, not merely noted. An embedding taken from a
                    # face this poor does not reliably match the person it
                    # belongs to, nor even the next bad crop of the same
                    # person, so letting it through manufactures strangers.
                    # See MIN_FRONTALITY_FOR_IDENTITY.
                    if frontality < MIN_FRONTALITY_FOR_IDENTITY:
                        self.faces_skipped_quality += 1
                        continue
                    score = area * f.det_score * frontality
                    
                    # Crop face with 20% padding
                    h, w = img.shape[:2]
                    pad_x = int((bbox[2] - bbox[0]) * 0.2)
                    pad_y = int((bbox[3] - bbox[1]) * 0.2)
                    x1, y1 = max(0, bbox[0] - pad_x), max(0, bbox[1] - pad_y)
                    x2, y2 = min(w, bbox[2] + pad_x), min(h, bbox[3] + pad_y)
                    cropped_face = img[y1:y2, x1:x2]

                    # ── Blur gate on the cropped face itself ──
                    crop_blur = self._laplacian_variance(cropped_face)
                    if crop_blur < BLUR_THRESHOLD:
                        continue
                    
                    # Find matching cluster
                    matched_cluster = None
                    highest_sim = -1.0
                    for c in clusters:
                        sim = self._cosine_similarity(emb, c["embedding"])
                        if sim > highest_sim:
                            highest_sim = sim
                            if sim >= self.similarity_threshold:
                                matched_cluster = c
                                
                    if matched_cluster:
                        if score > matched_cluster["best_score"]:
                            matched_cluster["best_score"] = score
                            matched_cluster["best_face"] = f
                            matched_cluster["best_frame"] = frame_meta
                            matched_cluster["cropped_face"] = cropped_face
                            matched_cluster["frontality"] = frontality
                            # The EMBEDDING too. Every other field moved to the
                            # better face and this one did not, so identity was
                            # decided on whichever face happened to arrive
                            # first while the picture saved beside it was the
                            # best one -- a recognisable crop filed under a
                            # vector taken from a glance at the floor.
                            matched_cluster["embedding"] = emb
                    else:
                        clusters.append({
                            "embedding": emb,
                            "best_face": f,
                            "best_score": score,
                            "best_frame": frame_meta,
                            "cropped_face": cropped_face,
                            "frontality": frontality
                        })
            except Exception as e:
                print(f"[{self.model_name}] InsightFace inference error: {e}")
                traceback.print_exc()

        if clusters:
            import time
            self.last_face_seen_time = time.time()

        if not clusters:
            return None

        # Clean up recent_unknowns (thread-safe)
        now = datetime.now(timezone.utc).timestamp()
        with self._ru_lock:
            self.recent_unknowns = [u for u in self.recent_unknowns if now - u["timestamp"] < self.conversation_timeout_seconds]

        # Process clusters
        for cluster in clusters:
            embedding = cluster["embedding"]
            best_frame = cluster["best_frame"]
            cropped_face = cluster["cropped_face"]
            
            match = self._match_face(embedding, context.user_id)

            # ── Is a conversation already in progress? ──────────────────
            with self._ru_lock:
                convo = self._open_convo
                if convo and (now - convo["last"]) >= self.conversation_timeout_seconds:
                    convo = self._open_convo = None      # they left; it is over
                if convo:
                    convo["last"] = now

            if match:
                # Deduplicate known faces to prevent event spam
                person_id = str(match['_id'])
                with self._ru_lock:
                    if not hasattr(self, 'recent_knowns'):
                        self.recent_knowns = {}

                    last_seen = self.recent_knowns.get(person_id, 0)
                    is_recent = (now - last_seen) < self.conversation_timeout_seconds
                    self.recent_knowns[person_id] = now
                    # Putting a name to the conversation already running is
                    # news worth recording -- it is how an unknown face
                    # becomes "Hammad" partway through -- but it is the SAME
                    # conversation, so it updates that row rather than
                    # starting a second one beside it.
                    naming = bool(convo and not convo.get("named"))
                    if naming:
                        convo["named"] = True
                        convo["person_id"] = person_id
                    if convo is not None:
                        _a = convo.get("anchors") or []
                        if len(_a) < CONVO_ANCHORS:
                            _a.append(embedding)
                            convo["anchors"] = _a

                if is_recent and not naming:
                    # We've seen this person recently. Don't emit another SOCIAL_INTERACTION event.
                    continue
                
                # Emit SOCIAL_INTERACTION for known person
                face_keyframe_id = str(uuid.uuid4())
                try:
                    storage_soc, storage_gen = self._storages()

                    person_name = match.get('person_name', 'Unknown')
                    if isinstance(person_name, str):
                        person_name = person_name.strip()
                    
                    metadata = {
                        "user_id": str(context.user_id), 
                        "source_frame": best_frame.get("id"),
                        "type": "face_crop",
                        "person_name": person_name
                    }
                    if match.get('relationship_type'):
                        rel_type = match['relationship_type']
                        if isinstance(rel_type, str):
                            rel_type = rel_type.strip()
                        metadata["relationship_type"] = rel_type
                    
                    # Store in social_storage
                    storage_soc.save(face_keyframe_id, cropped_face, metadata)

                    # Store in keyframe_storage (Keyframe Audit)
                    storage_gen.save(face_keyframe_id, cropped_face, metadata)
                    
                except Exception as e:
                    import traceback
                    print(f"[{self.model_name}] Error saving face crop: {traceback.format_exc()}")
                    face_keyframe_id = best_frame.get("id", face_keyframe_id)

                attrs = {
                    "person_id": str(match['_id']),
                    "person_name": match.get('person_name', 'Unknown'),
                    "relationship_type": match.get('relationship_type', 'Unknown'),
                    "status": "social_interaction",
                    "low_frontality": cluster.get("frontality", 1.0) < 0.3,
                }
                with self._ru_lock:
                    if naming and self._open_convo:
                        # The same conversation, now with a name on it. The
                        # row it already has is the one to change.
                        attrs["renames_keyframe_id"] = self._open_convo["keyframe_id"]
                    else:
                        self._open_convo = {"person_id": str(match['_id']),
                                            "keyframe_id": face_keyframe_id,
                                            "last": now, "named": True,
                                            "anchors": [embedding]}

                return DetectionResult(
                    action_type=self.action_type,
                    confidence=match['match_confidence'],
                    evidence_keyframe_ids=[face_keyframe_id],
                    attributes=attrs,
                    model=ModelReference(self.model_name, "v1")
                )
            else:
                # A conversation is already running and this face is not
                # anybody we know. It is the person already in front of the
                # camera, seen badly -- see _open_convo. Refusing to mint a
                # stranger here is what turns five rows into one.
                if convo is not None:
                    anchors = convo.get("anchors") or []
                    seen_before = max((self._cosine_similarity(embedding, a)
                                       for a in anchors), default=0.0)
                    well_seen = cluster.get("frontality", 0.0) >= NEW_PERSON_MIN_FRONTALITY
                    if seen_before >= SAME_PERSON_IN_CONVO or not well_seen:
                        # The person already in front of the camera, seen
                        # again -- possibly badly. Keep the conversation
                        # whole instead of inventing somebody.
                        self.faces_skipped_in_convo += 1
                        with self._ru_lock:
                            if self._open_convo is convo and len(anchors) < CONVO_ANCHORS:
                                anchors.append(embedding)
                                convo["anchors"] = anchors
                        continue
                    # Clearly a different face, and clearly enough seen to
                    # say so. Somebody else has joined, and they get their
                    # own conversation rather than sharing this transcript.
                    print(f"[{self.model_name}] a second person has appeared "
                          f"(best match to the current conversation "
                          f"{seen_before:.2f}); starting a separate one")

                # Unknown face - Deduplicate (thread-safe)
                with self._ru_lock:
                    is_recent = False
                    for ru in self.recent_unknowns:
                        # Use a slightly looser threshold (0.50) for deduplication since the anchor is fixed 
                        # and the person might change their pose (profile to frontal) during the interaction.
                        if self._cosine_similarity(embedding, ru["embedding"]) >= 0.50:
                            is_recent = True
                            ru["timestamp"] = now  # Update last seen
                            
                            # Upgrade in-place if better
                            new_score = cluster["best_score"]
                            if new_score > ru.get("best_score", 0):
                                ev = self.db.eventlogs.find_one({"keyframe_id": ru.get("keyframe_id")})
                                if ev and ev.get("verification_status") not in ["confirmed", "rejected"]:
                                    try:
                                        _, storage = self._storages()
                                        storage.save(ru["keyframe_id"], cropped_face, {
                                            "user_id": str(context.user_id), 
                                            "source_frame": best_frame.get("id"),
                                            "type": "face_crop"
                                        })
                                        ru["best_score"] = new_score
                                        print(f"[{self.model_name}] Upgraded unknown face image for {ru['keyframe_id']}")
                                    except Exception as e:
                                        import traceback
                                        print(f"[{self.model_name}] Error upgrading face crop: {traceback.format_exc()}")
                            break
                    
                    if not is_recent:
                        # New unknown person — register in memory BEFORE releasing the lock
                        face_keyframe_id = str(uuid.uuid4())
                        self.recent_unknowns.append({
                            "embedding": embedding, 
                            "timestamp": now,
                            "best_score": cluster["best_score"],
                            "keyframe_id": face_keyframe_id,
                            "frontality": cluster.get("frontality", 1.0)
                        })
                
                if not is_recent:
                    # Save to disk and return result (outside the lock to avoid holding it during I/O)
                    try:
                        _, storage_gen = self._storages()

                        metadata = {
                            "user_id": str(context.user_id),
                            "source_frame": best_frame.get("id"),
                            "type": "face_crop"
                        }

                        # Store in keyframe_storage (Keyframe Audit)
                        storage_gen.save(face_keyframe_id, cropped_face, metadata)
                        
                    except Exception as e:
                        import traceback
                        print(f"[{self.model_name}] Error saving face crop: {traceback.format_exc()}")

                    with self._ru_lock:
                        self._open_convo = {"person_id": None,
                                            "keyframe_id": face_keyframe_id,
                                            "last": now, "named": False,
                                            "anchors": [embedding]}

                    return DetectionResult(
                        action_type=ActionType.UNKNOWN_FACE,
                        confidence=1.0,
                        evidence_keyframe_ids=[face_keyframe_id],
                        attributes={
                            "face_embedding": embedding.tolist(),
                            "status": "unknown_face",
                            "low_frontality": cluster.get("frontality", 1.0) < 0.3
                        },
                        model=ModelReference(self.model_name, "v1")
                    )
                    
        return None

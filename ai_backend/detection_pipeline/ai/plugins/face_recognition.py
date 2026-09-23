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
        self.conversation_timeout_seconds = 300
        self.last_face_seen_time = 0.0
        self._social_storage = None   # see _storages(): one instance, one cleanup thread
        self._keyframe_storage = None
        
        # Load InsightFace Model (CPU for free-tier compatibility)
        self.app = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'])
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
        """
        if kps is None or len(kps) < 3:
            return 1.0 # fallback if no kps
            
        left_eye, right_eye, nose = kps[0], kps[1], kps[2]
        
        # Interocular distance
        eye_dist = np.linalg.norm(left_eye - right_eye)
        if eye_dist < 1e-6:
            return 0.0
            
        eye_midpoint = (left_eye + right_eye) / 2.0
        nose_offset = abs(nose[0] - eye_midpoint[0])
        
        asymmetry_ratio = nose_offset / eye_dist
        # Score drops to 0 if asymmetry >= 0.5
        score = max(0.0, 1.0 - (asymmetry_ratio * 2.0))
        return float(score)

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
            if match:
                # Deduplicate known faces to prevent event spam
                person_id = str(match['_id'])
                with self._ru_lock:
                    if not hasattr(self, 'recent_knowns'):
                        self.recent_knowns = {}
                        
                    last_seen = self.recent_knowns.get(person_id, 0)
                    is_recent = (now - last_seen) < self.conversation_timeout_seconds
                    self.recent_knowns[person_id] = now
                    
                if is_recent:
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

                return DetectionResult(
                    action_type=self.action_type,
                    confidence=match['match_confidence'],
                    evidence_keyframe_ids=[face_keyframe_id],
                    attributes={
                        "person_id": str(match['_id']),
                        "person_name": match.get('person_name', 'Unknown'),
                        "relationship_type": match.get('relationship_type', 'Unknown'),
                        "status": "social_interaction",
                        "low_frontality": cluster.get("frontality", 1.0) < 0.3
                    },
                    model=ModelReference(self.model_name, "v1")
                )
            else:
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

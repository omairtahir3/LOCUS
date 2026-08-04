import os
import cv2
import uuid
from datetime import datetime, timezone
import numpy as np
from numpy.linalg import norm
import insightface
from insightface.app import FaceAnalysis
from pymongo import MongoClient
import traceback

from ..core.plugins import DetectorPlugin
from ..core.contracts import ActionType, DetectionResult, EventContext, ModelReference

class FaceRecognitionPlugin(DetectorPlugin):
    action_type = ActionType.SOCIAL_INTERACTION
    model_name = "insightface_buffalo_l"

    def __init__(self, mongo_uri: str = "mongodb://localhost:27017", db_name: str = "locusDB", similarity_threshold: float = 0.65):
        print(f"[{self.model_name}] Initializing FaceRecognitionPlugin...")
        self.similarity_threshold = similarity_threshold
        self.recent_unknowns = []
        self.conversation_timeout_seconds = 300
        
        # Load InsightFace Model (CPU for free-tier compatibility)
        self.app = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'])
        self.app.prepare(ctx_id=0, det_size=(640, 640))
        
        # Initialize sync MongoDB client for use in the background threads
        self.client = MongoClient(mongo_uri)
        self.db = self.client[db_name]
        
        print(f"[{self.model_name}] Initialization complete.")

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
            cursor = self.db.relationships.find({"user_id": user_id})
            best_match = None
            highest_sim = -1.0
            
            for rel in cursor:
                if 'face_embedding' not in rel:
                    continue
                known_embed = np.array(rel['face_embedding'], dtype=np.float32)
                sim = self._cosine_similarity(embedding, known_embed)
                
                if sim > highest_sim:
                    highest_sim = sim
                    best_match = rel
                    
            print(f"[DEBUG-FACE] _match_face: best similarity = {highest_sim:.4f} (threshold={self.similarity_threshold})")
            if highest_sim >= self.similarity_threshold and best_match:
                best_match['match_confidence'] = highest_sim
                return best_match
        except Exception as e:
            print(f"[{self.model_name}] Error matching face: {e}")
            
        return None

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
            try:
                faces = self.app.get(img)
                faces = [f for f in faces if f.det_score > 0.5]
                for f in faces:
                    emb = f.normed_embedding
                    bbox = f.bbox.astype(int)
                    area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
                    score = area * f.det_score
                    
                    # Crop face with 20% padding
                    h, w = img.shape[:2]
                    pad_x = int((bbox[2] - bbox[0]) * 0.2)
                    pad_y = int((bbox[3] - bbox[1]) * 0.2)
                    x1, y1 = max(0, bbox[0] - pad_x), max(0, bbox[1] - pad_y)
                    x2, y2 = min(w, bbox[2] + pad_x), min(h, bbox[3] + pad_y)
                    cropped_face = img[y1:y2, x1:x2]
                    
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
                    else:
                        clusters.append({
                            "embedding": emb,
                            "best_face": f,
                            "best_score": score,
                            "best_frame": frame_meta,
                            "cropped_face": cropped_face
                        })
            except Exception as e:
                print(f"[{self.model_name}] InsightFace inference error: {e}")
                traceback.print_exc()

        if not clusters:
            return None

        # Clean up recent_unknowns
        now = datetime.now(timezone.utc).timestamp()
        self.recent_unknowns = [u for u in self.recent_unknowns if now - u["timestamp"] < self.conversation_timeout_seconds]

        # Process clusters
        for cluster in clusters:
            embedding = cluster["embedding"]
            best_frame = cluster["best_frame"]
            cropped_face = cluster["cropped_face"]
            
            match = self._match_face(embedding, context.user_id)
            if match:
                # Recognized face - emit SOCIAL_INTERACTION
                face_keyframe_id = str(uuid.uuid4())
                try:
                    from keyframe_backend.keyframe import KeyframeStorage
                    storage = KeyframeStorage()
                    storage.save(face_keyframe_id, cropped_face, {
                        "user_id": str(context.user_id), 
                        "source_frame": best_frame.get("id"),
                        "type": "face_crop"
                    })
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
                        "status": "social_interaction"
                    },
                    model=ModelReference(self.model_name, "v1")
                )
            else:
                # Unknown face - Deduplicate
                is_recent = False
                for ru in self.recent_unknowns:
                    if self._cosine_similarity(embedding, ru["embedding"]) >= self.similarity_threshold:
                        is_recent = True
                        ru["timestamp"] = now  # Update last seen
                        
                        # Upgrade in-place if better
                        new_score = cluster["best_score"]
                        if new_score > ru.get("best_score", 0):
                            ev = self.db.eventlogs.find_one({"keyframe_id": ru.get("keyframe_id")})
                            if ev and ev.get("verification_status") not in ["confirmed", "rejected"]:
                                try:
                                    from keyframe_backend.keyframe import KeyframeStorage
                                    storage = KeyframeStorage()
                                    storage.save(ru["keyframe_id"], cropped_face, {
                                        "user_id": str(context.user_id), 
                                        "source_frame": best_frame.get("id"),
                                        "type": "face_crop"
                                    })
                                    ru["best_score"] = new_score
                                    ru["embedding"] = embedding
                                    print(f"[{self.model_name}] Upgraded unknown face image for {ru['keyframe_id']}")
                                except Exception as e:
                                    import traceback
                                    print(f"[{self.model_name}] Error upgrading face crop: {traceback.format_exc()}")
                        break
                
                if not is_recent:
                    # New unknown person
                    face_keyframe_id = str(uuid.uuid4())
                    self.recent_unknowns.append({
                        "embedding": embedding, 
                        "timestamp": now,
                        "best_score": cluster["best_score"],
                        "keyframe_id": face_keyframe_id
                    })
                    
                    try:
                        from keyframe_backend.keyframe import KeyframeStorage
                        storage = KeyframeStorage()
                        storage.save(face_keyframe_id, cropped_face, {
                            "user_id": str(context.user_id), 
                            "source_frame": best_frame.get("id"),
                            "type": "face_crop"
                        })
                    except Exception as e:
                        import traceback
                        print(f"[{self.model_name}] Error saving face crop: {traceback.format_exc()}")

                    return DetectionResult(
                        action_type=ActionType.UNKNOWN_FACE,
                        confidence=1.0,
                        evidence_keyframe_ids=[face_keyframe_id],
                        attributes={
                            "face_embedding": embedding.tolist(),
                            "status": "unknown_face"
                        },
                        model=ModelReference(self.model_name, "v1")
                    )
                    
        return None

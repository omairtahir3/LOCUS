import time
from typing import Optional, Dict, Any, List

from ..core.contracts import ActionType, DetectionResult, EventContext, ModelReference
from ..core.plugins import DetectorPlugin

# Effective threshold for real decisions. 0.25 is Ultralytics' predict-mode
# default, which is what this plugin got implicitly before conf= was passed —
# keeping it here preserves the previous detection behaviour exactly.
DETECT_CONF = 0.25

# Per-class confidence floors, applied on top of DETECT_CONF.
#
# 'cell phone': yolov8n reads a black car-key fob as a phone, which logged
# "Using a phone." repeatedly while the wearer was holding keys and no phone was
# in frame at all. Measured over every 'cell phone' box in 6 real frames, scored
# against hand-labelled keys and phone locations:
#     real phone : 0.66, 0.58
#     key fob    : 0.38, 0.28, 0.27, 0.16, 0.16, 0.12, 0.11, 0.10, 0.07, 0.05
# The two populations separate cleanly, so 0.45 sits in the gap: it drops all 3
# false hits that cleared DETECT_CONF while keeping both real-phone detections.
# Narrow evidence (6 frames, one fob, one phone) -- revisit if a genuine phone
# is ever missed, since a dim or partly-occluded phone could fall under 0.45.
CLASS_CONF_FLOORS = {
    'cell phone': 0.45,
}

# What we actually ask YOLO for. Inference runs once at this lower threshold so
# near-miss detections are visible in the logs; everything between DEBUG_CONF
# and DETECT_CONF is logged but excluded from all detection logic below.
DEBUG_CONF = 0.05

# A single environment object must clear this higher bar to name a room on its
# own. Below it, the room is only accepted when a second, different object maps
# to the same environment. Environment detection has no center-frame or
# interaction check to fall back on, so this is its only guard.
ENV_SINGLE_CONF = 0.70

# Corroborated evidence (2+ distinct classes) only outranks a confident single
# detection if its strongest class clears this floor, so a pair of weak false
# positives cannot displace a genuine lone detection.
ENV_CORROBORATION_FLOOR = 0.35

# A continuous activity re-fires on every batch, so an unbroken stretch of
# typing logged 147 near-identical events in ~10 minutes. Mirror the dedup
# face_recognition uses for recent_knowns: the same activity+environment is
# only logged again once this window has passed, so events mark genuine state
# changes. Longer than a social interaction's window because activities like
# typing or reading plausibly run for minutes.
ACTIVITY_DEDUP_SECONDS = 120


class _SkipFrameSave(Exception):
    """Internal control-flow signal: log the event, skip the disk write."""

class EgocentricActivityPlugin(DetectorPlugin):
    """
    Detects egocentric Hand-Object Interactions (HOI) and infers the environment
    using YOLOv8 (COCO 80 classes) to generate a combined activity sentence.

    Known detection limitation (live-tested 2026-09-08, chest-mounted camera):
    'bottle' detects reliably at close egocentric range — confirmed across
    multiple events at 0.28-0.87 confidence, driving correct "Drinking" events.
    'cup' did not produce a single above-threshold detection in the same
    testing; it appeared only below 0.25 (0.05-0.21). Drink detection therefore
    currently depends on bottles in practice. This is a yolov8n capability
    limit at this range/angle, not a threshold or disambiguation bug — lowering
    the threshold to catch cups also surfaces false 'bed'/'cat'/'tv' matches.
    """
    action_type = ActionType.ACTIVITY
    model_name = "yolov8n-egocentric"

    def __init__(self, model_path: str = "yolov8n.pt"):
        import time
        t0 = time.time()
        print(f"[{self.model_name}] Initializing...")
        self.model_path = model_path
        self._model = None
        self._storage = None          # lazily built; one instance, one cleanup thread
        self._last_event = None       # ((activity, environment), monotonic ts)
        
        # COCO class mapping for activities — object implies brief, active
        # interaction, so a match here fires as a real activity event via
        # the wearer/bystander disambiguation in _find_interacting_activity().
        self.ACTIVITY_MAP = {
            # Drinking
            'bottle': 'drinking', 'wine glass': 'drinking', 'cup': 'drinking',
            # Eating
            'fork': 'eating', 'knife': 'eating', 'spoon': 'eating',
            'banana': 'eating', 'apple': 'eating', 'sandwich': 'eating', 'orange': 'eating',
            'broccoli': 'eating', 'carrot': 'eating', 'hot dog': 'eating', 'pizza': 'eating',
            'donut': 'eating', 'cake': 'eating',
            # Working/Typing
            'laptop': 'typing', 'mouse': 'using a computer', 'keyboard': 'typing',
            # Phone
            'cell phone': 'using a phone',
            # Washing
            'toothbrush': 'brushing teeth',
            # Grooming — NOT yet live-tested: confirm it detects above
            # DETECT_CONF and that a hair drier resting on a shelf does not
            # fire via the center-frame path before trusting this.
            'hair drier': 'drying hair',
            # Getting dressed
            'tie': 'getting dressed',
        }

        # COCO class mapping for passive/contextual objects — presence alone
        # does NOT imply current action. Matches here are appended to
        # attrs["context_notes"] as supplementary info only: they never
        # generate an activity sentence, never affect confidence, and never
        # cause an event to fire on their own (see analyze()).
        self.CONTEXT_MAP = {
            # Leaving / going out
            'backpack': 'leaving/going out', 'umbrella': 'leaving/going out',
            'handbag': 'leaving/going out', 'suitcase': 'leaving/going out',
            # Pets
            'dog': 'spending time with pet', 'cat': 'spending time with pet',
            'bird': 'spending time with pet',
            # Plants / decor
            'potted plant': 'gardening/tending plants', 'vase': 'arranging flowers/decorating',
            # Comfort objects
            'teddy bear': 'resting/relaxing',
            # Tableware — moved out of ACTIVITY_MAP: 'bowl' fired "eating" on a
            # laptop desk in every frame (0.32-0.76), a persistent round-object
            # false positive. Its presence no more implies eating than a vase
            # implies arranging flowers.
            'bowl': 'tableware present',
            # Gray zone — not yet live-tested for false positives on passive
            # presence (e.g. a closed book on a shelf); moved here rather than
            # ACTIVITY_MAP until individually vetted.
            'book': 'reading', 'remote': 'watching tv', 'bicycle': 'cycling', 'scissors': 'crafts',
            # "sports equipment" — COCO has no single such class; mapping the
            # whole COCO sports-equipment group here. Prune individual
            # entries if this is broader than intended.
            'frisbee': 'exercising', 'skis': 'exercising', 'snowboard': 'exercising',
            'sports ball': 'exercising', 'kite': 'exercising', 'baseball bat': 'exercising',
            'baseball glove': 'exercising', 'skateboard': 'exercising',
            'surfboard': 'exercising', 'tennis racket': 'exercising',
        }

        # COCO class mapping for environments
        self.ENV_MAP = {
            # Kitchen
            'microwave': 'kitchen', 'oven': 'kitchen', 'toaster': 'kitchen',
            'sink': 'kitchen', 'refrigerator': 'kitchen',
            # Dining
            'dining table': 'dining area',
            # Living Room — 'remote' also stays in CONTEXT_MAP; it implies a TV,
            # a room-anchoring appliance, unlike generic furniture. Other
            # CONTEXT classes were rejected for this role because they appear
            # in every room (book, vase, potted plant) or travel with the
            # person (backpack, handbag, suitcase, umbrella).
            'couch': 'living room', 'tv': 'living room', 'remote': 'living room',
            # Bedroom
            'bed': 'bedroom',
            # Bathroom
            'toilet': 'bathroom',
            # Outdoors / Park
            # Outdoor recreation — NOT live-tested. These stay in CONTEXT_MAP
            # too; a class may serve CONTEXT+ENV (independent code paths), but
            # never ACTIVITY+ENV, which would hijack interaction_method and the
            # confidence tier. 'sports ball'/'frisbee' are deliberately excluded:
            # they false-positive on round objects (plates, bowls), and under the
            # corroboration rule two such FPs would confidently assert "outdoors".
            'kite': 'park/outdoor area', 'surfboard': 'park/outdoor area',
            'skis': 'park/outdoor area', 'snowboard': 'park/outdoor area',
            'bench': 'park/outdoor area', 'fire hydrant': 'street', 'stop sign': 'street',
            'car': 'street', 'bus': 'street', 'truck': 'street', 'traffic light': 'street',
            'parking meter': 'street', 'motorcycle': 'street', 'train': 'street'
        }
        
        print(f"[{self.model_name}] Initialization complete.")

    def _ensure_model_loaded(self):
        if self._model is None:
            from ultralytics import YOLO
            self._model = YOLO(self.model_path)

    @staticmethod
    def _bbox_iou(box_a, box_b):
        """Compute Intersection-over-Union between two [x1,y1,x2,y2] boxes."""
        x1 = max(box_a[0], box_b[0])
        y1 = max(box_a[1], box_b[1])
        x2 = min(box_a[2], box_b[2])
        y2 = min(box_a[3], box_b[3])
        inter = max(0, x2 - x1) * max(0, y2 - y1)
        if inter == 0:
            return 0.0
        area_a = (box_a[2] - box_a[0]) * (box_a[3] - box_a[1])
        area_b = (box_b[2] - box_b[0]) * (box_b[3] - box_b[1])
        return inter / (area_a + area_b - inter)

    @staticmethod
    def _is_center_frame(bbox, frame_w, frame_h, margin=0.20):
        """Check if the bbox center falls within the central region of the frame.
        margin=0.20 means the central 60% (20% cut from each side)."""
        cx = (bbox[0] + bbox[2]) / 2
        cy = (bbox[1] + bbox[3]) / 2
        return (frame_w * margin <= cx <= frame_w * (1 - margin) and
                frame_h * margin <= cy <= frame_h * (1 - margin))

    def supports(self, context: EventContext) -> bool:
        return True

    def _find_interacting_activity(self, boxes, names, frame_h, frame_w):
        """
        Egocentric-aware activity detection.

        Key insight: in first-person (chest/head-mounted) footage, any detected
        'person' bbox is a BYSTANDER, not the camera wearer.  The wearer's own
        activity is inferred from objects near the center of the frame (where
        their hands/gaze naturally fall).

        Decision table:
          - No person in frame  + object in center   → wearer activity   (0.75, "center_frame")
          - Person in frame     + object overlaps person → bystander      (0.55, "bystander_overlap")
          - Person in frame     + object in center, NOT overlapping person → wearer (0.65, "center_frame_with_bystander")
          - Object in periphery, no overlap           → rejected

        Returns (activity_label, confidence, method) or (None, 0.0, None).
        """
        person_bboxes = []
        activity_candidates = []  # (class_name, bbox)

        for i, cls_id in enumerate(boxes.cls):
            # Inference runs at DEBUG_CONF so near-misses are loggable; ignore
            # anything under the effective threshold here so detection
            # behaviour matches what it was before conf= was passed.
            conf = float(boxes.conf[i])
            if conf < DETECT_CONF:
                continue
            cls_name = names[int(cls_id)]
            if conf < CLASS_CONF_FLOORS.get(cls_name, 0.0):
                continue
            bbox = boxes.xyxy[i].cpu().numpy()  # [x1, y1, x2, y2]
            if cls_name == 'person':
                person_bboxes.append(bbox)
            elif cls_name in self.ACTIVITY_MAP:
                activity_candidates.append((cls_name, bbox))

        if not activity_candidates:
            return None, 0.0, None

        center_x, center_y = frame_w / 2, frame_h / 2

        def _center_dist(bbox):
            cx = (bbox[0] + bbox[2]) / 2
            cy = (bbox[1] + bbox[3]) / 2
            return ((cx - center_x) ** 2 + (cy - center_y) ** 2) ** 0.5

        def _max_person_iou(obj_bbox):
            """Return the highest IoU between obj_bbox and any person bbox."""
            if not person_bboxes:
                return 0.0
            return max(self._bbox_iou(obj_bbox, pb) for pb in person_bboxes)

        if not person_bboxes:
            # ── No bystander visible — pure center-frame (most common path) ──
            best_cls, best_dist = None, float('inf')
            for cls_name, obj_bbox in activity_candidates:
                if not self._is_center_frame(obj_bbox, frame_w, frame_h, margin=0.20):
                    continue
                d = _center_dist(obj_bbox)
                if d < best_dist:
                    best_dist = d
                    best_cls = cls_name
            if best_cls:
                return self.ACTIVITY_MAP[best_cls], 0.75, "center_frame"
            return None, 0.0, None

        # ── Bystander(s) present — split objects into wearer vs bystander ──
        wearer_candidates = []   # center-frame AND not overlapping person
        bystander_candidates = []  # overlapping a person bbox

        for cls_name, obj_bbox in activity_candidates:
            iou = _max_person_iou(obj_bbox)
            in_center = self._is_center_frame(obj_bbox, frame_w, frame_h, margin=0.20)
            if iou > 0.05:
                # Object is on/near the bystander's body
                bystander_candidates.append((cls_name, obj_bbox, iou))
            elif in_center:
                # Object is center-frame but NOT on the bystander → likely wearer's
                wearer_candidates.append((cls_name, obj_bbox))

        # Prefer wearer activity (center-frame, not overlapping bystander)
        if wearer_candidates:
            best_cls, best_dist = None, float('inf')
            for cls_name, obj_bbox in wearer_candidates:
                d = _center_dist(obj_bbox)
                if d < best_dist:
                    best_dist = d
                    best_cls = cls_name
            if best_cls:
                return self.ACTIVITY_MAP[best_cls], 0.65, "center_frame_with_bystander"

        # Fall back to bystander activity (lower confidence, explicitly tagged)
        if bystander_candidates:
            # Pick the bystander interaction with the highest IoU
            bystander_candidates.sort(key=lambda x: x[2], reverse=True)
            best_cls = bystander_candidates[0][0]
            return self.ACTIVITY_MAP[best_cls], 0.55, "bystander_overlap"

        return None, 0.0, None

    def analyze(self, event_buffer: list[dict], context: EventContext) -> Optional[DetectionResult]:
        print(f"[ACT-DEBUG] analyze() called, buffer len={len(event_buffer) if event_buffer else 0}")
        if not event_buffer or len(event_buffer) < 3:
            print(f"[ACT-DEBUG] EXIT: buffer too short ({len(event_buffer) if event_buffer else 0} < 3)")
            return None

        self._ensure_model_loaded()

        kf = event_buffer[-1]
        frame = kf.get("raw_frame")
        if frame is None:
            frame = kf.get("frame")
        if frame is None:
            print("[ACT-DEBUG] EXIT: no frame found in keyframe dict")
            return None
        print(f"[ACT-DEBUG] Frame acquired: shape={frame.shape}, keys in kf={list(kf.keys())}")

        try:
            # Run inference below the effective threshold so sub-threshold
            # near-misses show up in the log. Anything under DETECT_CONF is
            # logged only and filtered out before any detection logic runs.
            results = self._model(frame, verbose=False, conf=DEBUG_CONF)
            if not results:
                print("[ACT-DEBUG] EXIT: YOLO returned no results")
                return None

            result = results[0]
            boxes = result.boxes
            if boxes is None or len(boxes) == 0:
                print(f"[ACT-DEBUG] EXIT: YOLO found 0 boxes (even at conf>={DEBUG_CONF})")
                return None

            names = result.names
            frame_h, frame_w = frame.shape[:2]

            # ── Raw per-box confidences, above and below the threshold ──
            above, below = [], []
            for i, cls_id in enumerate(boxes.cls):
                cls_name = names[int(cls_id)]
                conf = float(boxes.conf[i])
                (above if conf >= DETECT_CONF else below).append((cls_name, conf))
            above.sort(key=lambda x: x[1], reverse=True)
            below.sort(key=lambda x: x[1], reverse=True)
            print(
                f"[ACT-DEBUG] RAW (>= {DETECT_CONF}): "
                + (" ".join(f"{n}={c:.3f}" for n, c in above) or "none")
                + f"  ||  BELOW {DETECT_CONF} (>= {DEBUG_CONF}): "
                + (" ".join(f"{n}={c:.3f}" for n, c in below) or "none")
            )

            # Only at/above the effective threshold feeds the logic below.
            detected_classes = [n for n, _ in above]
            print(f"[ACT-DEBUG] YOLO usable boxes: {detected_classes}")

            # 1. Detect Environment. A lone, weakly-confident match is not
            # trustworthy (a stray bed=0.37 seen from the living room would
            # otherwise assign the whole room as "bedroom"), so an environment
            # is only accepted when either one object is confident on its own,
            # or two different objects independently agree on the same room.
            env_evidence = {}  # env label -> {class_name: best confidence}
            for cls_name, conf in above:
                env_label = self.ENV_MAP.get(cls_name)
                if env_label is None:
                    continue
                seen = env_evidence.setdefault(env_label, {})
                if conf > seen.get(cls_name, 0.0):
                    seen[cls_name] = conf

            env_found = None
            env_best_key = (False, 0.0)
            for env_label, evidence in env_evidence.items():
                strongest = max(evidence.values())
                corroborated = len(evidence) >= 2
                if strongest >= ENV_SINGLE_CONF or corroborated:
                    # Two different objects agreeing outrank one confident
                    # guess (a hallucinated toilet=0.62 beat couch+remote in a
                    # living room). The floor stops the mirror failure: two
                    # weak false positives (car=0.26 + truck=0.27) must not
                    # outrank a genuine lone bed=0.85.
                    key = (corroborated and strongest >= ENV_CORROBORATION_FLOOR, strongest)
                    if key > env_best_key:
                        env_best_key = key
                        env_found = env_label
                else:
                    print(
                        f"[ACT-DEBUG] ENV rejected '{env_label}': single object "
                        f"{evidence} below {ENV_SINGLE_CONF} with no corroboration"
                    )

            # 2. Detect Activity with Hand-Object Interaction validation
            activity_found, activity_conf, interaction_method = self._find_interacting_activity(
                boxes, names, frame_h, frame_w
            )

            # 2b. Contextual objects — informational only. Never feeds into
            # the sentence or confidence score, and never fires an event on
            # its own: the early return below is unchanged and still gates
            # purely on activity_found/env_found.
            context_notes = sorted({
                self.CONTEXT_MAP[cls_name] for cls_name in detected_classes
                if cls_name in self.CONTEXT_MAP
            })

            print(f"[ACT-DEBUG] activity_found={activity_found}, env_found={env_found}, interaction_method={interaction_method}, context_notes={context_notes}")
            if not activity_found and not env_found:
                print("[ACT-DEBUG] EXIT: no activity AND no environment matched")
                return None

            # 2c. Dedup: only log a genuine state change, or a repeat once the
            # window has expired. Everything below (keyframe write included)
            # runs only for events that survive this gate.
            # Keyed on the activity, so environment is supplementary text that
            # cannot reset the timer on its own. Environment-only events fall
            # back to the room, since there the room IS the whole payload and
            # a genuine transition should log.
            import time as _t
            state = activity_found if activity_found else ('env', env_found)
            now_ts = _t.monotonic()
            if self._last_event and self._last_event[0] == state \
                    and (now_ts - self._last_event[1]) < ACTIVITY_DEDUP_SECONDS:
                print(f"[ACT-DEBUG] EXIT: duplicate {state!r} within {ACTIVITY_DEDUP_SECONDS}s window")
                return None
            # A window-expiry repeat of the SAME state is the same ongoing
            # activity, so it still logs an event but does not need another
            # near-identical frame on disk. Only a genuine state change is
            # worth storing evidence for — one frame per activity, not one
            # per window.
            is_state_change = (self._last_event is None) or (self._last_event[0] != state)
            self._last_event = (state, now_ts)

            # 3. Generate Sentence
            if activity_found and env_found:
                sentence = f"{activity_found.capitalize()} in the {env_found}."
            elif activity_found:
                sentence = f"{activity_found.capitalize()}."
            elif env_found:
                sentence = f"In the {env_found}."
                activity_conf = 0.80  # Environment-only detection

            attrs = {
                "sentence": sentence,
                "activity": activity_found,
                "environment": env_found,
                "detected_objects": list(set(detected_classes)),
                # Raw YOLO confidences behind this event. `confidence` on the
                # event itself is a fixed tier (0.80 for environment-only), so
                # without these the record can't be audited after the fact.
                "detection_confidences": {n: round(c, 3) for n, c in above},
                "env_evidence": {
                    env_label: {n: round(c, 3) for n, c in evidence.items()}
                    for env_label, evidence in env_evidence.items()
                },
            }
            if activity_found and interaction_method:
                attrs["interaction_method"] = interaction_method
            if context_notes:
                attrs["context_notes"] = context_notes

            # 4. Persist the evidence frame. The buffer keyframe's id was only
            # ever an in-memory handle — nothing wrote it to disk, so every
            # activity event carried a keyframe_id that 404'd.
            import uuid
            activity_keyframe_id = str(uuid.uuid4()) if is_state_change else None
            try:
                if not is_state_change:
                    print(f"[ACT-DEBUG] Ongoing {state!r} — event logged, no new frame stored")
                    raise _SkipFrameSave()
                if self._storage is None:
                    try:
                        from keyframe_backend.keyframe import ActivityStorage
                    except ImportError:
                        import sys
                        import os
                        ai_backend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
                        if ai_backend_dir not in sys.path:
                            sys.path.insert(0, ai_backend_dir)
                        from keyframe_backend.keyframe import ActivityStorage
                    self._storage = ActivityStorage()
                if self._storage:
                    self._storage.save(activity_keyframe_id, frame, {
                        "user_id": str(context.user_id),
                        "type": "activity",
                        "activity": activity_found,
                        "environment": env_found,
                        "sentence": sentence,
                    })
            except _SkipFrameSave:
                pass
            except Exception:
                import traceback
                print(f"[{self.model_name}] Error saving activity frame: {traceback.format_exc()}")
                activity_keyframe_id = None

            print(f"[ACT-DEBUG] SUCCESS: '{sentence}' conf={round(activity_conf, 2)} kf={activity_keyframe_id}")
            return DetectionResult(
                action_type=ActionType.ACTIVITY,
                confidence=round(activity_conf, 2),
                evidence_keyframe_ids=[activity_keyframe_id] if activity_keyframe_id else [],
                attributes=attrs,
                model=ModelReference(name=self.model_name)
            )

        except Exception as e:
            import traceback
            print(f"[ACT-DEBUG] EXCEPTION in analyze(): {e}")
            traceback.print_exc()
            return None

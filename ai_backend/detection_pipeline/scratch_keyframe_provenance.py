"""
Keyframe Provenance & Plate Detection Uniqueness Analysis.
Analyzes:
1. Exact dates, directories, user IDs, and timestamp spread across all 56 keyframes.
2. Exact count of DISTINCT keyframes containing 'Plate' detections (deduplicated per frame).
"""

import os
import sys
import glob
import cv2
from ultralytics import YOLO
from datetime import datetime

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
LOCUS_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", ".."))
sys.path.insert(0, BASE_DIR)

storage = os.path.join(LOCUS_DIR, "ai_backend", "keyframe_backend", "keyframe_storage")
all_kfs = sorted(glob.glob(os.path.join(storage, "**", "*.jpg"), recursive=True))

print("=" * 80)
print("1. KEYFRAME PROVENANCE & SESSION SPREAD ANALYSIS")
print("=" * 80)
print(f"Total keyframe image files found: {len(all_kfs)}")

# Analyze directory structure and timestamps
date_folders = {}
user_folders = {}
file_times = []

for f in all_kfs:
    parts = f.replace("\\", "/").split("/")
    # Structure: .../keyframe_storage/<user_id>/<date>/<filename>.jpg
    idx = parts.index("keyframe_storage")
    user_id = parts[idx + 1] if len(parts) > idx + 1 else "unknown"
    date_str = parts[idx + 2] if len(parts) > idx + 2 else "unknown"
    
    user_folders[user_id] = user_folders.get(user_id, 0) + 1
    date_folders[date_str] = date_folders.get(date_str, 0) + 1

    mtime = os.path.getmtime(f)
    dt = datetime.fromtimestamp(mtime)
    file_times.append((dt, f))

file_times.sort(key=lambda x: x[0])
min_time, max_time = file_times[0][0], file_times[-1][0]
time_span = max_time - min_time

print(f"\nUser Distribution:")
for u, count in user_folders.items():
    print(f"  - User ID '{u}': {count} keyframes")

print(f"\nDate Distribution:")
for d, count in date_folders.items():
    print(f"  - Date '{d}': {count} keyframes")

print(f"\nTimestamp Spread:")
print(f"  - Earliest File Timestamp: {min_time.strftime('%Y-%m-%d %H:%M:%S')}")
print(f"  - Latest File Timestamp:   {max_time.strftime('%Y-%m-%d %H:%M:%S')}")
print(f"  - Total Recorded Span:     {time_span}")

# Cluster timestamps into sessions (gap > 5 minutes indicates distinct session)
sessions = []
current_session = [file_times[0]]

for ft in file_times[1:]:
    gap_sec = (ft[0] - current_session[-1][0]).total_seconds()
    if gap_sec > 300: # 5 min gap
        sessions.append(current_session)
        current_session = [ft]
    else:
        current_session.append(ft)
sessions.append(current_session)

print(f"\nDistinct Capture Sessions (split by >5min recording gap): {len(sessions)}")
for i, sess in enumerate(sessions):
    s_start = sess[0][0].strftime("%H:%M:%S")
    s_end = sess[-1][0].strftime("%H:%M:%S")
    print(f"  Session {i+1}: {len(sess)} frames | {s_start} -> {s_end} (Duration: {sess[-1][0]-sess[0][0]})")

print("\n" + "=" * 80)
print("2. TIER-2 'PLATE' (EATING) DETECTION UNIQUENESS BREAKDOWN")
print("=" * 80)

model_o365 = YOLO(os.path.join(BASE_DIR, "ai", "models", "yolo11n_object365.pt"))

# Frame -> list of Plate boxes
plate_by_frame = {}

for kf in all_kfs:
    fname = os.path.basename(kf)
    img = cv2.imread(kf)
    if img is None: continue

    res = model_o365(img, conf=0.10, verbose=False)[0]
    if res.boxes is not None:
        for b in res.boxes:
            cid = int(b.cls[0].item())
            cname = model_o365.names.get(cid, str(cid))
            if cname.lower() == "plate":
                conf = float(b.conf[0].item())
                xyxy = [int(x) for x in b.xyxy[0].tolist()]
                if fname not in plate_by_frame:
                    plate_by_frame[fname] = []
                plate_by_frame[fname].append((conf, xyxy))

total_plate_boxes = sum(len(boxes) for boxes in plate_by_frame.values())
unique_plate_frames = len(plate_by_frame)

print(f"Total Raw 'Plate' Bounding Boxes Detected: {total_plate_boxes}")
print(f"Total DISTINCT Keyframes with 'Plate':      {unique_plate_frames} / {len(all_kfs)} frames ({unique_plate_frames/len(all_kfs)*100:.1f}%)")

print("\nDetailed Breakdown of Distinct Keyframes with 'Plate' detections:")
for fname, boxes in sorted(plate_by_frame.items(), key=lambda x: len(x[1]), reverse=True):
    confs = [round(b[0], 3) for b in boxes]
    max_conf = max(confs)
    print(f"  - Frame [{fname[:12]}]: {len(boxes)} plate box(es) detected (confs={confs}, max={max_conf})")

print("=" * 80)

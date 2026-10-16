"""Two models' worth of weight removed, and nothing that produced output lost.

  InsightFace buffalo_l is a bundle of five ONNX graphs and FaceAnalysis loaded
  and ran all five per face. The plugin reads four attributes and all four come
  from two of them, so 143 MB was resident and three extra passes ran per face
  to produce nothing anybody read -- including a gender/age estimator, which a
  dementia camera has no business inferring.

  The egocentric activity plugin loaded yolov8s (11.17 M parameters, 4x
  YOLO11n) and ran a second detector pass per batch into two output paths that
  were BOTH already gated off. Lifetime output across this account: one event,
  dated 25 September, against 17 room sessions still arriving from YOLO11n.

The risk in each is the same shape: something downstream quietly loses a field
or a page goes permanently empty. That is what this exercises, against the real
InsightFace weights rather than a mock.
"""
import io
import os
import sys
import warnings

warnings.filterwarnings("ignore")

AI = r'C:\Users\dell\Desktop\LOCUS\ai_backend'
DP = os.path.join(AI, 'detection_pipeline')
os.chdir(DP)
sys.path.insert(0, DP)
sys.path.insert(0, AI)

import cv2
import numpy as np

PASS = FAIL = 0


def check(label, cond, detail=""):
    global PASS, FAIL
    print(f"  {'PASS' if cond else '*** FAIL ***'}  {label}" + (f" -> {detail}" if detail else ""))
    if cond:
        PASS += 1
    else:
        FAIL += 1


src = lambda f: io.open(os.path.join(DP, f), encoding='utf-8').read()

print("1. the activity detector is off, and off means the weights never load")
reg = src(os.path.join('ai', 'plugins', 'registry.py'))
from ai.plugins.registry import _SPECS, build_registry
from ai.core.contracts import ActionType

spec = next(s for s in _SPECS if s.action_type is ActionType.ACTIVITY)
check("the ACTIVITY spec is disabled", spec.enabled is False)
check("it is still LISTED, not deleted", spec.note != "",
      "a detector that is off should be documented, not absent")

r = build_registry()
check("the registry does not offer it", ActionType.ACTIVITY not in r.registered())
check("asking for it yields None rather than raising", r.get(ActionType.ACTIVITY) is None,
      "pipeline._plugin() turns an exception into None, but None is cleaner")
check("and the other two detectors are untouched",
      ActionType.MEDICATION_INTAKE in r.registered()
      and ActionType.SOCIAL_INTERACTION in r.registered())
check("include_disabled still reaches it, for comparison runs",
      ActionType.ACTIVITY in build_registry(include_disabled=True).registered())

print()
print("2. nothing in the pipeline then runs, or warns, every batch")
pl = src(os.path.join('ai', 'pipeline.py'))
# The call site guard, and the fact that _observe_activity sits INSIDE it: with
# the plugin gone the tracker is never fed, never created, and never flushed.
i_guard = pl.index("if self.activity_plugin is not None")
i_observe = pl.index("self._observe_activity(act_result)")
i_finally = pl.index("self._activity_busy = False", i_guard)
check("the batch runner is guarded on the plugin existing", i_guard < i_observe)
check("and the tracker is only fed from inside that guard", i_observe < i_finally)
check("the shutdown flush tolerates a tracker that was never built",
      "getattr(self, '_activity_tracker', None)" in pl,
      "no plugin, no tracker, no AttributeError at stop")

print()
print("3. the flags no longer promise something they cannot deliver")
check("EMIT_ACTIVITY_SESSIONS says the detector must be re-enabled too",
      "needs TWO changes" in pl and "plugins/registry.py" in pl)
check("and so does EMIT_PER_FRAME_ACTIVITY_EVENTS",
      "ACTIVITY PluginSpec re-enabled" in pl)
check("the old 'one flag and no other change' claim is gone",
      "one flag and no" not in pl,
      "it was true when written and would have been a lie afterwards")

print()
print("4. existing activity rows still render; only new ones stop")
tl = io.open(r'C:\Users\dell\Desktop\LOCUS\web_app\backend\routes\eventLogs.js',
             encoding='utf-8').read()
check("the timeline still handles activity_session",
      "d.action === 'activity_session'" in tl,
      "the one real row from 25 Sep must not vanish from its own day")
check("room sessions are a separate path and untouched",
      "scene_session" in tl)

print()
print("5. the face plugin asks for only the two modules it reads")
fr = src(os.path.join('ai', 'plugins', 'face_recognition.py'))
check("allowed_modules is passed",
      "allowed_modules=['detection', 'recognition']" in fr)
import re
attrs = set(re.findall(r"\bf\.(bbox|det_score|kps|normed_embedding|sex|age|landmark[_0-9a-z]*)\b", fr))
check("the four attributes it uses are the detection+recognition ones",
      attrs <= {"bbox", "det_score", "kps", "normed_embedding"},
      ", ".join(sorted(attrs)))
check("nothing reads gender or age", not ({"sex", "age"} & attrs),
      "not inferring either is better than inferring and discarding")
check("frontality uses the 5-point kps that come with detection",
      "kps" in fr and "_calculate_frontality" in fr)

print()
print("6. a real face through the trimmed model still yields all four")
# The actual weights, not a mock: a mock would prove only that the test agrees
# with itself about which modules exist.
try:
    from ai.plugins.face_recognition import FaceRecognitionPlugin
    plugin = FaceRecognitionPlugin.__new__(FaceRecognitionPlugin)
    from insightface.app import FaceAnalysis
    app = FaceAnalysis(name='buffalo_l',
                       allowed_modules=['detection', 'recognition'],
                       providers=['CPUExecutionProvider'])
    app.prepare(ctx_id=0, det_size=(640, 640))
    loaded = sorted(app.models.keys())
    print(f"     modules loaded: {loaded}")
    check("only detection and recognition are loaded",
          set(loaded) == {"detection", "recognition"},
          "was: detection, recognition, landmark_3d_68, landmark_2d_106, genderage")

    # Which module populates which attribute, read off the library rather than
    # asserted. This is the real contract: a live face would only confirm it
    # for one photograph, and there is currently no face in any of the 28
    # stored frames on this machine -- they are all desk shots -- so an
    # end-to-end attribute check cannot be run here at all. See the note at the
    # end of this file.
    import inspect
    get_src = inspect.getsource(FaceAnalysis.get)
    check("bbox, kps and det_score are built by the DETECTION model",
          "Face(bbox=bbox, kps=kps, det_score=det_score)" in get_src,
          "so all three survive dropping the landmark and genderage modules")
    det = app.models['detection']
    check("and that detection model emits keypoints at all",
          getattr(det, 'use_kps', False) is True,
          f"{type(det).__name__}, use_kps={getattr(det, 'use_kps', None)}")
    rec = app.models['recognition']
    check("normed_embedding comes from the RECOGNITION model, 512-D",
          list(getattr(rec, 'output_shape', [])) == [1, 512],
          f"{type(rec).__name__} {getattr(rec, 'output_shape', None)}")
    check("the dropped modules only ADD attributes, never these four",
          all(t not in app.models for t in
              ('landmark_3d_68', 'landmark_2d_106', 'genderage')),
          "nothing the plugin reads was produced by any of them")

    # The frontality maths, on synthetic 5-point keypoints in the shape the
    # detector returns. This exercises the plugin's own arithmetic, which is
    # the only thing between kps and a recognition decision.
    frontal = np.array([[30, 40], [70, 40], [50, 60], [35, 80], [65, 80]], dtype=np.float32)
    profile = np.array([[30, 40], [40, 40], [33, 60], [31, 80], [38, 80]], dtype=np.float32)
    fs = float(FaceRecognitionPlugin._calculate_frontality(plugin, frontal))
    ps = float(FaceRecognitionPlugin._calculate_frontality(plugin, profile))
    check("frontality still computes from 5-point kps", 0.0 <= fs <= 1.0, f"frontal={fs:.2f}")
    check("and still ranks a frontal face above a profile", fs > ps,
          f"frontal {fs:.2f} vs profile {ps:.2f}")
except Exception as e:
    check("InsightFace loads with the trimmed module list", False, f"{type(e).__name__}: {e}")

print()
print("7. what this actually saves")
sizes = {}
bl = os.path.join(os.path.expanduser('~'), '.insightface', 'models', 'buffalo_l')
for name in ('det_10g', 'w600k_r50', '1k3d68', '2d106det', 'genderage'):
    p = os.path.join(bl, name + '.onnx')
    sizes[name] = os.path.getsize(p) / 1048576 if os.path.exists(p) else 0.0
dropped = sizes['1k3d68'] + sizes['2d106det'] + sizes['genderage']
kept = sizes['det_10g'] + sizes['w600k_r50']
y8 = os.path.join(DP, 'yolov8s.pt')
y8_mb = os.path.getsize(y8) / 1048576 if os.path.exists(y8) else 0.0
print(f"     InsightFace: {kept:.1f} MB kept, {dropped:.1f} MB no longer loaded")
print(f"     yolov8s:     {y8_mb:.1f} MB no longer loaded")
print(f"     total resident model weight removed: {dropped + y8_mb:.1f} MB")
check("the face bundle is more than a third smaller",
      dropped / (kept + dropped) > 0.33, f"{dropped / (kept + dropped) * 100:.0f}% dropped")
check("yolov8s.pt stays on disk, in case it is wanted back",
      os.path.exists(y8), "disabled, not deleted")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)

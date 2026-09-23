"""The list of detectors the pipeline runs (Core FE-5).

FE-5 asks for "a plugin-based model architecture so new detection types can be
added without rebuilding the pipeline". The DetectorPlugin interface and
PluginRegistry already existed, but nothing used them: pipeline.py constructed
MedicationIntakePlugin, FaceRecognitionPlugin and EgocentricActivityPlugin into
three named fields and called each one by hand, so a fourth detector meant
editing the capture loop.

This module is now the only file that has to change. To add a detector:

    1. Write a class implementing DetectorPlugin (see plugins/medication.py):
       an `action_type`, a `model_name`, `supports(context)` and
       `analyze(event_buffer, context)` returning a DetectionResult or None.
    2. Add it to _SPECS below.

Nothing in pipeline.py changes. Registration is lazy -- a plugin is only
constructed when it is first needed -- because FaceRecognitionPlugin loads
InsightFace weights in its constructor and paying that cost for a detector
that is switched off would slow every pipeline start.

`enabled` is what plugins/catalog.py described but could not enforce: a
detector listed here with enabled=False is documented and skipped rather than
silently absent.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from ..core.contracts import ActionType, EventContext
from ..core.plugins import DetectorPlugin, PluginRegistry


@dataclass(frozen=True)
class PluginSpec:
    action_type: ActionType
    factory: Callable[[], DetectorPlugin]
    enabled: bool = True
    note: str = ""


def _medication() -> DetectorPlugin:
    from .medication import MedicationIntakePlugin
    return MedicationIntakePlugin()


def _face() -> DetectorPlugin:
    from .face_recognition import FaceRecognitionPlugin
    return FaceRecognitionPlugin(similarity_threshold=0.65)


def _activity() -> DetectorPlugin:
    from .egocentric_activity import EgocentricActivityPlugin
    return EgocentricActivityPlugin()


_SPECS: tuple[PluginSpec, ...] = (
    PluginSpec(ActionType.MEDICATION_INTAKE, _medication,
               note="pill detector + hand pose, three-phase temporal scoring"),
    PluginSpec(ActionType.SOCIAL_INTERACTION, _face,
               note="insightface embedding match; also raises unknown_face"),
    PluginSpec(ActionType.ACTIVITY, _activity,
               note="egocentric object context; per-frame events are retired, "
                    "its output feeds Tier-2 environment sessions"),
)


class LazyPluginRegistry(PluginRegistry):
    """A PluginRegistry that builds each plugin on first use."""

    def __init__(self) -> None:
        super().__init__()
        self._factories: dict[ActionType, Callable[[], DetectorPlugin]] = {}
        self._notes: dict[ActionType, str] = {}
        self._failed: dict[ActionType, str] = {}

    def register_lazy(self, spec: PluginSpec) -> None:
        if spec.action_type in self._factories or spec.action_type in self._plugins:
            raise ValueError(f"Plugin already registered for {spec.action_type}")
        self._factories[spec.action_type] = spec.factory
        self._notes[spec.action_type] = spec.note

    def get(self, action_type: ActionType) -> DetectorPlugin | None:
        plugin = self._plugins.get(action_type)
        if plugin is not None:
            return plugin
        factory = self._factories.get(action_type)
        if factory is None:
            return None
        plugin = factory()
        self._plugins[action_type] = plugin
        return plugin

    def registered(self) -> tuple[ActionType, ...]:
        """Every action type available, built or not."""
        return tuple(self._plugins.keys() | self._factories.keys())

    def applicable(self, context: EventContext):
        """Plugins that want this event, constructing them as needed.

        A detector that cannot be built -- a missing model file, an optional
        dependency such as insightface not installed -- is logged once and
        skipped. Iterating the registry must not be all-or-nothing: one broken
        plugin taking medication detection down with it is exactly the coupling
        FE-5 exists to remove.
        """
        for action_type in self.registered():
            try:
                plugin = self.get(action_type)
            except Exception as exc:
                if action_type not in self._failed:
                    self._failed[action_type] = str(exc)
                    print(f"[PluginRegistry] {action_type.value} unavailable, skipping: "
                          f"{type(exc).__name__}: {exc}")
                continue
            if plugin is not None and plugin.supports(context):
                yield plugin

    def failures(self) -> dict:
        """Detectors that were registered but could not be constructed."""
        return dict(self._failed)

    def describe(self) -> list[dict]:
        return [
            {
                "action_type": a.value,
                "loaded": a in self._plugins,
                "model": getattr(self._plugins.get(a), "model_name", None),
                "note": self._notes.get(a, ""),
            }
            for a in sorted(self.registered(), key=lambda x: x.value)
        ]


def build_registry(include_disabled: bool = False) -> LazyPluginRegistry:
    registry = LazyPluginRegistry()
    for spec in _SPECS:
        if spec.enabled or include_disabled:
            registry.register_lazy(spec)
    return registry

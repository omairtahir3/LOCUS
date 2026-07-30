"""Model requirements for the four supported analysis domains.

Only medication inference is wired today because it is the sole model available
in this repository.  The catalog makes the remaining integrations explicit
without running placeholder inference or changing the medication workflow.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..core.contracts import ActionType


@dataclass(frozen=True)
class PluginModelSpec:
    action_type: ActionType
    model_role: str
    temporal: bool
    enabled: bool


MODEL_PLUGIN_CATALOG = (
    PluginModelSpec(ActionType.MEDICATION_INTAKE, "pill detector + hand pose", True, True),
    PluginModelSpec(ActionType.ITEM_EXIT, "fine-tuned object detector + tracker", True, False),
    PluginModelSpec(ActionType.FACE_INTERACTION, "face detector + embedding matcher", True, False),
    PluginModelSpec(ActionType.ACTIVITY, "fine-tuned temporal activity classifier", True, False),
)

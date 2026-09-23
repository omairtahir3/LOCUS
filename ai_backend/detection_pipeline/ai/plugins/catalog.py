"""Model requirements for the analysis domains, and what is actually wired.

This file used to say "only medication inference is wired today". That has not
been true since the face and activity plugins landed, and nothing checked it,
so it quietly drifted. The live answer now comes from registry.py -- the one
place detectors are listed -- and this module only records the model each
domain needs and whether it is built yet.

    from .catalog import describe_catalog
    for row in describe_catalog():
        print(row)
"""

from __future__ import annotations

from dataclasses import dataclass

from ..core.contracts import ActionType


@dataclass(frozen=True)
class PluginModelSpec:
    action_type: ActionType
    model_role: str
    temporal: bool


MODEL_PLUGIN_CATALOG = (
    PluginModelSpec(ActionType.MEDICATION_INTAKE, "pill detector + hand pose", True),
    PluginModelSpec(ActionType.ITEM_EXIT, "fine-tuned object detector + tracker", True),
    PluginModelSpec(ActionType.FACE_INTERACTION, "face detector + embedding matcher", True),
    PluginModelSpec(ActionType.SOCIAL_INTERACTION, "insightface matching", True),
    PluginModelSpec(ActionType.UNKNOWN_FACE, "insightface fallback", True),
    PluginModelSpec(ActionType.ACTIVITY, "egocentric object-context classifier", True),
)


def describe_catalog() -> list[dict]:
    """Each domain, the model it needs, and whether a plugin is registered.

    `registered` is read from registry.py rather than stored here, so this
    cannot go stale again.
    """
    from .registry import build_registry

    registered = set(build_registry(include_disabled=True).registered())
    return [
        {
            "action_type": spec.action_type.value,
            "model_role": spec.model_role,
            "temporal": spec.temporal,
            "registered": spec.action_type in registered,
        }
        for spec in MODEL_PLUGIN_CATALOG
    ]

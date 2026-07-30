"""Detector plugin implementations and integration points."""

from .medication import MedicationIntakePlugin
from .catalog import MODEL_PLUGIN_CATALOG, PluginModelSpec

__all__ = ["MedicationIntakePlugin", "MODEL_PLUGIN_CATALOG", "PluginModelSpec"]

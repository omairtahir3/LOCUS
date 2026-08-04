"""Plugin protocol and registry for detector modules."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Iterable

from .contracts import ActionType, DetectionResult, EventContext


class DetectorPlugin(ABC):
    """A detector that analyzes an already-captured event buffer."""

    action_type: ActionType
    model_name: str

    @abstractmethod
    def supports(self, context: EventContext) -> bool:
        """Return whether the plugin should run for this event context."""

    @abstractmethod
    def analyze(self, event_buffer: list[dict], context: EventContext) -> DetectionResult | None:
        """Return normalized evidence, or None when the event is not detected."""


class PluginRegistry:
    """Explicit registry that prevents detector modules from being coupled to capture."""

    def __init__(self) -> None:
        self._plugins: dict[ActionType, DetectorPlugin] = {}

    def register(self, plugin: DetectorPlugin) -> None:
        if plugin.action_type in self._plugins:
            raise ValueError(f"Plugin already registered for {plugin.action_type}")
        self._plugins[plugin.action_type] = plugin

    def get(self, action_type: ActionType) -> DetectorPlugin | None:
        return self._plugins.get(action_type)

    def applicable(self, context: EventContext) -> Iterable[DetectorPlugin]:
        return (plugin for plugin in self._plugins.values() if plugin.supports(context))

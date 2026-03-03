from __future__ import annotations

from copy import deepcopy
from typing import Any, Callable, Dict, Iterable, List, Sequence

SCHEMA_VERSION = "REGART.Art.RawEvent.v1"

UpgradeHandler = Callable[[Dict[str, Any]], Dict[str, Any]]

UPGRADE_HANDLERS: Dict[str, UpgradeHandler] = {}
DOWNGRADE_HANDLERS: Dict[str, UpgradeHandler] = {}


def _clone_event(event: Dict[str, Any]) -> Dict[str, Any]:
    return deepcopy(event or {})


def _merge_version_history(existing: Sequence[Any] | None, additions: Iterable[Any]) -> List[str]:
    seen: List[str] = []
    for value in list(existing or []) + list(additions):
        if value is None:
            continue
        text = str(value).strip()
        if not text:
            continue
        if text in seen:
            continue
        seen.append(text)
    return seen


def upgrade_raw_event(event: Dict[str, Any], target_version: str = SCHEMA_VERSION) -> Dict[str, Any]:
    base = _clone_event(event)
    current_version = str(base.get("schema_version") or SCHEMA_VERSION)
    handler = UPGRADE_HANDLERS.get(current_version, lambda payload: payload)
    upgraded = handler(base)
    upgraded["schema_version"] = target_version
    upgraded["version_history"] = _merge_version_history(
        upgraded.get("version_history"),
        [current_version, target_version],
    )
    return upgraded


def downgrade_raw_event(event: Dict[str, Any], target_version: str) -> Dict[str, Any]:
    base = _clone_event(event)
    if not target_version:
        target_version = SCHEMA_VERSION
    if target_version == SCHEMA_VERSION:
        return {**base, "schema_version": target_version}
    handler = DOWNGRADE_HANDLERS.get(target_version, lambda payload: payload)
    downgraded = handler(base)
    downgraded["schema_version"] = target_version
    downgraded["version_history"] = _merge_version_history(
        downgraded.get("version_history"),
        [target_version],
    )
    return downgraded

"""High-performance regex matching for vessel-to-operator resolution."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Optional


class FleetMatcher:
    """Maps a free-form vessel name to its corporate operator via precompiled regex."""

    def __init__(self, mappings_path: Optional[Path] = None) -> None:
        if mappings_path is None:
            # backend/services/fleet_matcher.py → parent.parent.parent is repo root.
            mappings_path = Path(__file__).resolve().parent.parent.parent / "data" / "mappings.json"
        self._compiled: list[tuple[re.Pattern[str], str, str]] = []
        self.cargo_types: dict[str, str] = {}
        self._load(mappings_path)

    def _load(self, path: Path) -> None:
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, json.JSONDecodeError) as exc:
            print(f"[fleet_matcher] failed to load {path}: {exc}")
            return

        self.cargo_types = {str(k): v for k, v in data.get("cargo_types", {}).items()}
        for pattern, operator in data.get("shipping_lines", {}).items():
            try:
                compiled = re.compile(rf"\b({pattern})\b", re.IGNORECASE)
                self._compiled.append((compiled, operator, pattern))
            except re.error as exc:
                print(f"[fleet_matcher] bad regex {pattern!r}: {exc}")

    def match(self, vessel_name: str) -> tuple[str, str]:
        """Return (operator, signature). Falls back to ("Unknown Operator", "")."""
        if not vessel_name:
            return ("Unknown Operator", "")
        for pattern, operator, sig in self._compiled:
            if pattern.search(vessel_name):
                return (operator, sig)
        return ("Unknown Operator", "")

    def cargo_label(self, ship_type: int) -> str:
        return self.cargo_types.get(str(ship_type), f"Type {ship_type}")

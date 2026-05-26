"""IATA airline-code → carrier name resolution.

Mirrors fleet_matcher.py for the plane side. Reads data/airlines.json, which
groups carriers into buckets ("cargo", "passenger_north_america", ...) purely
for human readability — at load time we flatten everything into one dict for
O(1) lookups.

Keys are IATA 2-letter codes (e.g. "FX" → "FedEx Express"). The lookup is
case-insensitive. Unknown codes return ("Unknown Operator", "") to match the
FleetMatcher fallback shape so callers can treat both the same way.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional


class AirlineMatcher:
    """Maps an IATA airline code to its carrier name via a static JSON table."""

    def __init__(self, mappings_path: Optional[Path] = None) -> None:
        if mappings_path is None:
            # backend/services/airline_matcher.py → parent.parent.parent is repo root.
            mappings_path = Path(__file__).resolve().parent.parent.parent / "data" / "airlines.json"
        self._codes: dict[str, str] = {}
        # Separate set tracking codes that come from the "cargo" bucket of
        # airlines.json — used by planes.py to filter Aviation Edge results
        # down to shipping/freight carriers only (FedEx, UPS, DHL, Atlas,
        # Cargolux, etc.). Mirrors the cargo/tanker filter on the ship side.
        self._cargo_codes: set[str] = set()
        self._load(mappings_path)

    def _load(self, path: Path) -> None:
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, json.JSONDecodeError) as exc:
            print(f"[airline_matcher] failed to load {path}: {exc}")
            return

        # Flatten the bucketed structure. Skip the _comment field and any keys
        # that contain whitespace (those are notation slips like "TK Cargo"
        # rather than real IATA codes — keep them out of the lookup table).
        for bucket, entries in data.items():
            if bucket.startswith("_") or not isinstance(entries, dict):
                continue
            for code, name in entries.items():
                if not isinstance(code, str) or not isinstance(name, str):
                    continue
                key = code.strip().upper()
                if not key or " " in key:
                    continue
                # First-write wins so the "cargo" bucket (declared first in
                # the JSON) takes precedence if a code appears twice.
                self._codes.setdefault(key, name)
                # Track cargo-bucket codes separately so planes.py can filter
                # the live Aviation Edge feed to shipping carriers only.
                if bucket == "cargo":
                    self._cargo_codes.add(key)

    def match(self, iata_code: Optional[str]) -> tuple[str, str]:
        """Return (carrier_name, iata_code). Falls back to ("Unknown Operator", "")."""
        if not iata_code:
            return ("Unknown Operator", "")
        key = iata_code.strip().upper()
        name = self._codes.get(key)
        if not name:
            return ("Unknown Operator", "")
        return (name, key)

    def is_cargo(self, iata_code: Optional[str]) -> bool:
        """True if the IATA code maps to a freight/cargo carrier.

        Used by planes.py to filter the Aviation Edge live feed down to
        shipping airlines only — the air-traffic equivalent of the
        commercial-ship-type filter on the AIS side.
        """
        if not iata_code:
            return False
        return iata_code.strip().upper() in self._cargo_codes

    def from_callsign(self, callsign: Optional[str]) -> tuple[str, str]:
        """Resolve from a full callsign by taking its first two letters.

        Most Aviation Edge callsigns come through as IATA-style ('UA123', 'FX55'),
        so the first two chars are the IATA airline code. If the callsign is
        ICAO-style (3-letter prefix) this will give a wrong answer for that
        flight, but the caller will see "Unknown Operator" and the UI degrades
        gracefully to showing just the callsign.
        """
        if not callsign or len(callsign) < 2:
            return ("Unknown Operator", "")
        return self.match(callsign[:2])

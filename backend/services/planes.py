"""Aviation Edge → Plane[] proxy.

Port of the old frontend planeLiveDataService.ts + Next.js AviationEdge route
into Python. Same shape comes out the other end so the React store can swallow
it without touching its Plane TypeScript type.

Airline names are resolved via /airlineDatabase and cached in-memory per
process (enough for a hackathon demo — the upstream TTL is the same 24h the
old Next.js route used).
"""
from __future__ import annotations

import os
import random
from datetime import datetime, timezone
from typing import Optional

import httpx

AVIATION_EDGE = "https://aviation-edge.com/v2/public"
MAX_PLANES = 25      # what the frontend used to emit
PROBE_LIMIT = 200    # how many airborne flights we sample from before slicing


# Process-lifetime airline-name cache. Keyed by IATA code.
# None means "we tried and it failed" so we don't hammer the API on retries.
_airline_names: dict[str, Optional[str]] = {}


def _key() -> str:
    return os.environ.get("AVIATION_EDGE_API_KEY", "")


async def _fetch_airline_name(client: httpx.AsyncClient, iata: str) -> Optional[str]:
    if iata in _airline_names:
        return _airline_names[iata]
    if not iata:
        return None
    try:
        r = await client.get(
            f"{AVIATION_EDGE}/airlineDatabase",
            params={"key": _key(), "codeIataAirline": iata},
            timeout=10.0,
        )
        r.raise_for_status()
        data = r.json()
        name = data[0].get("nameAirline") if isinstance(data, list) and data else None
    except (httpx.HTTPError, ValueError, KeyError, IndexError):
        name = None
    _airline_names[iata] = name
    return name


def _flight_id(callsign: Optional[str]) -> str:
    return f"plane-live-{callsign or random.randbytes(4).hex()}"


async def fetch_live_planes() -> list[dict]:
    key = _key()
    if not key:
        print("[planes] AVIATION_EDGE_API_KEY not set")
        return []

    async with httpx.AsyncClient(headers={"User-Agent": "supply-chain-brain/1.0"}) as client:
        try:
            r = await client.get(
                f"{AVIATION_EDGE}/flights",
                params={"key": key},
                timeout=15.0,
            )
            r.raise_for_status()
            raw = r.json()
        except (httpx.HTTPError, ValueError) as exc:
            print(f"[planes] fetch failed: {exc}")
            return []

        if not isinstance(raw, list):
            print(f"[planes] unexpected shape: {type(raw).__name__}")
            return []

        airborne = []
        for f in raw:
            if not isinstance(f, dict):
                continue
            g = f.get("geography") or {}
            s = f.get("speed") or {}
            if g.get("latitude") is None or g.get("longitude") is None:
                continue
            if s.get("isGround") != 0:
                continue
            if (s.get("horizontal") or 0) <= 100:
                continue
            airborne.append(f)

        random.shuffle(airborne)
        batch = airborne[:PROBE_LIMIT]

        # Resolve airline names for everyone in batch (cached after first hit).
        iata_codes = {
            (f.get("airline") or {}).get("iataCode") or ""
            for f in batch
            if (f.get("airline") or {}).get("iataCode")
        }
        for code in iata_codes:
            await _fetch_airline_name(client, code)

        planes: list[dict] = []
        for f in batch[:MAX_PLANES]:
            g = f["geography"]
            speed = f["speed"]
            flight = f.get("flight") or {}
            airline = f.get("airline") or {}
            departure = f.get("departure") or {}
            arrival = f.get("arrival") or {}
            system = f.get("system") or {}

            # Mirror the TS logic: prefer IATA flight number unless it starts
            # with XX (placeholder), then fall back to ICAO.
            iata_num = flight.get("iataNumber")
            if isinstance(iata_num, str) and iata_num.startswith("XX"):
                iata_num = None
            callsign = iata_num or flight.get("icaoNumber") or None
            iata_air = airline.get("iataCode") or ""
            airline_name = _airline_names.get(iata_air) or iata_air or None

            updated = system.get("updated")
            try:
                ts = (
                    datetime.fromtimestamp(int(updated), tz=timezone.utc).isoformat()
                    if updated else datetime.now(timezone.utc).isoformat()
                )
            except (TypeError, ValueError, OSError):
                ts = datetime.now(timezone.utc).isoformat()

            try:
                altitude_m = round(float(g.get("altitude") or 0) * 0.3048)
            except (TypeError, ValueError):
                altitude_m = 0

            planes.append({
                "id":            _flight_id(callsign),
                "name":          callsign or airline_name or "Unknown",
                "type":          "plane",
                "latitude":      float(g["latitude"]),
                "longitude":     float(g["longitude"]),
                "heading":       float(g.get("direction") or 0),
                "status":        "moving",
                "cargo":         "Air Freight",
                "lastUpdated":   ts,
                "route":         [],
                "destination":   [float(g["longitude"]), float(g["latitude"])],
                "currentSpeed":  float(speed.get("horizontal") or 0),
                "altitude":      altitude_m,
                "dataSource":    "live",
                "flightNumber":  callsign,
                "airline":       airline_name,
                "departureAirport": departure.get("iataCode") or None,
                "arrivalAirport":   arrival.get("iataCode") or None,
            })

        print(f"[planes] returning {len(planes)} airborne flights")
        return planes

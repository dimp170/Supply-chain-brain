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

from services._geo import grid_bucket as _grid_bucket
from services.airline_matcher import AirlineMatcher

AVIATION_EDGE = "https://aviation-edge.com/v2/public"
MAX_PLANES = 100     # what the frontend used to emit
PROBE_LIMIT = 200    # how many airborne flights we sample from before slicing

# Geographic distribution grid lives in services/_geo.py (shared with the ship
# pipeline in app.py). Same 6×3 cells so live planes and ships spread across
# the same regions of the globe.

# Minimum angular separation between selected planes — currently unused on
# the plane side (the cargo-only carrier filter already thins corridors
# enough). Kept for parity with the ship pipeline in case we re-enable it.
MIN_PLANE_DEG_APART = 4.0


# Process-lifetime airline-name cache. Keyed by IATA code.
# None means "we tried and it failed" so we don't hammer the API on retries.
_airline_names: dict[str, Optional[str]] = {}

# Static IATA → carrier name lookup loaded once per process. This is the
# primary source for airline names — the Aviation Edge /airlineDatabase call
# is now only a fallback for IATA codes the JSON doesn't know about. Removes
# the per-boot wait while the frontend is gathering enough planes to display.
_matcher = AirlineMatcher()


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

        # Process the full airborne list through the tiered selection. The
        # previous random sample of PROBE_LIMIT (200) caused cargo flights
        # (~3% of global air traffic) to be heavily undercounted — most
        # cargo planes never made it past the sample. Now we bucket ALL
        # airborne candidates and let the grid round-robin + tier sort
        # handle distribution. Output is still capped at MAX_PLANES below.
        batch = airborne

        # Geographic round-robin selection across grid buckets — same pattern
        # the ships endpoint uses. Within each bucket, matched-operator
        # flights pop first so we still bias toward recognizable airlines
        # while guaranteeing spread. Without this, raw Aviation Edge data
        # piles 80% of the cap into Europe + transatlantic corridors.
        # Tiered priority for plane selection. Strict cargo-only filtering
        # made the sky look empty (only ~30 cargo flights airborne globally
        # at any moment). Now we ACCEPT all airborne planes but RANK them so
        # cargo carriers fill the cap first, then other matched commercial
        # airlines, then unmatched flights as last-resort filler.
        #   Tier 1: cargo carrier from airlines.json "cargo" bucket
        #   Tier 2: any matched airline (passenger or otherwise)
        #   Tier 3: unmatched / unknown carrier
        # Within each bucket the tiers are sorted ascending, so round-robin
        # pops tier 1 entries first across all buckets, then tier 2, etc.
        plane_buckets: dict[int, list[tuple[int, dict]]] = {}
        for f in batch:
            g = f["geography"]
            try:
                lng = float(g["longitude"]); lat = float(g["latitude"])
            except (TypeError, ValueError, KeyError):
                continue
            iata_air = (f.get("airline") or {}).get("iataCode") or ""
            if _matcher.is_cargo(iata_air):
                tier = 1
            elif iata_air and _matcher.match(iata_air)[0] != "Unknown Operator":
                tier = 2
            else:
                tier = 3
            bidx = _grid_bucket(lng, lat)
            plane_buckets.setdefault(bidx, []).append((tier, f))

        # Sort each cell by tier ascending. Round-robin below pops the front
        # of each cell, so tier 1 entries always go first.
        for cell in plane_buckets.values():
            cell.sort(key=lambda pair: pair[0])

        # Diagnostic — how many planes per tier across all buckets. Helps
        # debug the "where are all the cargo planes" question. Remove once
        # tier distribution is understood.
        tier_counts = {1: 0, 2: 0, 3: 0}
        for cell in plane_buckets.values():
            for tier, _ in cell:
                tier_counts[tier] += 1
        print(f"[planes] tier candidates  cargo={tier_counts[1]}  matched={tier_counts[2]}  unmatched={tier_counts[3]}")

        # Round-robin pull across buckets only — no minimum-distance filter
        # on planes. The plane feed is already thinned by the cargo-only
        # carrier filter (see is_cargo() above), so corridor-stacking isn't
        # the problem it is for ships. Ships still use the distance filter.
        selected: list[dict] = []
        while len(selected) < MAX_PLANES:
            progressed = False
            for cell in plane_buckets.values():
                if not cell:
                    continue
                _, f = cell.pop(0)
                selected.append(f)
                progressed = True
                if len(selected) >= MAX_PLANES:
                    break
            if not progressed:
                break

        # Resolve airline names for the SELECTED set only. JSON lookup first;
        # fall back to Aviation Edge for unknown IATA codes.
        iata_codes = {
            (f.get("airline") or {}).get("iataCode") or ""
            for f in selected
            if (f.get("airline") or {}).get("iataCode")
        }
        unknown_codes = [c for c in iata_codes if _matcher.match(c)[0] == "Unknown Operator"]
        for code in unknown_codes:
            await _fetch_airline_name(client, code)

        planes: list[dict] = []
        for f in selected:
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
            # JSON lookup wins; Aviation Edge cache is the fallback; raw IATA
            # code is the last resort so the UI shows *something*.
            matched_name, _ = _matcher.match(iata_air)
            if matched_name == "Unknown Operator":
                airline_name = _airline_names.get(iata_air) or iata_air or None
            else:
                airline_name = matched_name

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
                "company":       airline_name,  # mirrors `airline` so sidebar header subtitle shows the carrier
                "flightNumber":  callsign,
                "airline":       airline_name,
                "departureAirport": departure.get("iataCode") or None,
                "arrivalAirport":   arrival.get("iataCode") or None,
            })

        print(f"[planes] returning {len(planes)} airborne flights")
        return planes

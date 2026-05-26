"""HERE Routing proxy + flexpolyline decode + RoutePoint enrichment.

Port of the old frontend routingService.ts + polylineDecoder.ts + the
enrichment that lived in app/page.tsx. Returns the same RoutePoint[] shape
the frontend uses: `{lat, lng, speedLimit (km/h), trafficSpeed?, cumulativeDistance (km)}`.

Self-contained polyline decoder — no `@here/flexpolyline` dep needed on the
Python side; the format is small enough to implement directly.
"""
from __future__ import annotations

import math
import os

import httpx

HERE_ROUTES = "https://router.hereapi.com/v8/routes"

# ─── HERE flexpolyline decoder ────────────────────────────────────────────────
#
# Reference: https://github.com/heremaps/flexible-polyline (Python implementation).
# Encoding is variable-length base-64-ish with this character → 6-bit mapping:
#   A-Z, a-z, 0-9, '-', '_'  →  0..63   (negative entries in the table are invalid).
# Each integer is little-endian 5-bit groups, high bit (0x20) set on
# continuation. Signed integers are zigzag-encoded.

DECODING_TABLE = [
    62, -1, -1, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, -1, -1, -1, -1, -1, -1, -1,
     0,  1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    20, 21, 22, 23, 24, 25, -1, -1, -1, -1, 63, -1, 26, 27, 28, 29, 30, 31, 32, 33,
    34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51,
]
FORMAT_VERSION = 1


def _decode_char(ch: str) -> int:
    val = DECODING_TABLE[ord(ch) - 45]
    if val < 0:
        raise ValueError(f"invalid flexpolyline character {ch!r}")
    return val


def _decode_unsigned(it) -> int:
    """Read a varint of unbounded length from the iterator."""
    result = 0
    shift = 0
    for ch in it:
        value = _decode_char(ch)
        result |= (value & 0x1F) << shift
        if (value & 0x20) == 0:
            return result
        shift += 5
    raise ValueError("invalid flexpolyline: truncated varint")


def _decode_header(it):
    version = _decode_unsigned(it)
    if version != FORMAT_VERSION:
        raise ValueError(f"unsupported flexpolyline version {version}")
    raw = _decode_unsigned(it)
    precision = raw & 0x0F
    raw >>= 4
    third_dim = raw & 0x07
    raw >>= 3
    third_dim_precision = raw & 0x0F
    return precision, third_dim, third_dim_precision


def _to_signed(raw: int) -> int:
    return (raw >> 1) ^ -(raw & 1)


def decode_flexpolyline(encoded: str) -> list[tuple[float, float]]:
    """Decode a HERE flexpolyline string into a list of (lat, lng) tuples."""
    if not encoded:
        return []
    it = iter(encoded)
    precision, third_dim, _third_dim_precision = _decode_header(it)
    factor = 10 ** precision
    lat = 0
    lng = 0
    out: list[tuple[float, float]] = []
    while True:
        try:
            raw_lat = _decode_unsigned(it)
        except StopIteration:
            break
        except ValueError:
            break
        try:
            raw_lng = _decode_unsigned(it)
        except (StopIteration, ValueError):
            break
        lat += _to_signed(raw_lat)
        lng += _to_signed(raw_lng)
        if third_dim:
            try:
                _decode_unsigned(it)  # consume but ignore 3rd dimension
            except (StopIteration, ValueError):
                pass
        out.append((lat / factor, lng / factor))
    return out


# ─── Haversine for cumulative distance ────────────────────────────────────────

_EARTH_KM = 6371.0


def _haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lng1 = map(math.radians, a)
    lat2, lng2 = map(math.radians, b)
    dlat = lat2 - lat1
    dlng = lng2 - lng1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return 2 * _EARTH_KM * math.asin(min(1.0, math.sqrt(h)))


# ─── HERE Routes call + enrichment ────────────────────────────────────────────

def _key() -> str:
    return os.environ.get("HERE_API_KEY") or os.environ.get("NEXT_PUBLIC_HERE_API_KEY", "")


async def fetch_truck_route(
    origin_lng_lat: tuple[float, float],
    dest_lng_lat: tuple[float, float],
) -> list[dict]:
    """Fetch + decode + enrich. Returns a list of RoutePoint dicts."""
    key = _key()
    if not key:
        raise RuntimeError("HERE_API_KEY not set")

    o_lng, o_lat = origin_lng_lat
    d_lng, d_lat = dest_lng_lat
    params = {
        "transportMode": "truck",
        "origin":      f"{o_lat},{o_lng}",
        "destination": f"{d_lat},{d_lng}",
        "return":      "polyline,summary,travelSummary",
        "spans":       "streetAttributes,speedLimit,dynamicSpeedInfo",
        "apiKey":      key,
    }
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.get(HERE_ROUTES, params=params)
        r.raise_for_status()
        data = r.json()

    routes = data.get("routes") or []
    if not routes:
        raise RuntimeError("no routes returned from HERE")
    section = (routes[0].get("sections") or [{}])[0]
    polyline = section.get("polyline") or ""
    spans = section.get("spans") or []

    decoded = decode_flexpolyline(polyline)
    if not decoded:
        return []

    # For each decoded point, find the latest span whose offset <= index.
    # (HERE emits spans as { offset, speedLimit?, dynamicSpeedInfo?, ... }.)
    cumulative_distance = 0.0
    cumulative_time = 0.0
    span_idx = 0
    out: list[dict] = []
    for idx, (lat, lng) in enumerate(decoded):
        while span_idx + 1 < len(spans) and spans[span_idx + 1].get("offset", 10**9) <= idx:
            span_idx += 1
        span = spans[span_idx] if spans else None
        if idx > 0:
            distance = _haversine_km(decoded[idx - 1], (lat, lng))
            time = (span or {}).get("travelTime", 0)
            cumulative_distance += distance
            cumulative_time += time
            
        speed_limit_mps = (span or {}).get("speedLimit")
        # HERE returns speedLimit in m/s; the TS code multiplied by 3.6 to get km/h.
        speed_limit_kmh = (speed_limit_mps * 3.6) if isinstance(speed_limit_mps, (int, float)) else 30.0
        out.append({
            "lat":                lat,
            "lng":                lng,
            "speedLimit":         speed_limit_kmh,
            "trafficSpeed":       None,
            "cumulativeDistance": cumulative_distance,
            "distance":       distance if idx > 0 else 0.0,
            "cumulativeTime":     cumulative_time,
        })
    return out

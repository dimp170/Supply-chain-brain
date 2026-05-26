"""Shared geographic helpers for backend services.

These functions used to live duplicated in `app.py` and `services/planes.py`.
Both modules need the same grid bucketing and minimum-distance filter to spread
ships and planes across the globe instead of letting dense regions (Med, North
Sea, transatlantic corridor) dominate the cap. Single source of truth now lives
here.

Conventions match the original implementations exactly:
  * GRID_COLS × GRID_ROWS = 6 × 3 = 18 cells (~60° on a side).
  * `_too_close` uses squared lat/lng distance (cheap, good enough for spread
    filtering at globe zoom). Handles longitude wraparound across the
    antimeridian.

Keep these in sync with the comments in the call sites — they explain why the
constants are tuned the way they are.
"""
from __future__ import annotations

GRID_COLS = 6
GRID_ROWS = 3


def grid_bucket(lng: float, lat: float) -> int:
    """Map a coordinate to a flat grid bucket index in [0, GRID_COLS*GRID_ROWS)."""
    col = min(GRID_COLS - 1, max(0, int((lng + 180) / (360 / GRID_COLS))))
    row = min(GRID_ROWS - 1, max(0, int((lat + 90)  / (180 / GRID_ROWS))))
    return col + row * GRID_COLS


def too_close(
    lat: float,
    lng: float,
    accepted: list[tuple[float, float]],
    min_deg: float,
) -> bool:
    """True if (lat, lng) is within min_deg of any already-accepted coordinate.

    Squared lat/lng distance — cheaper than great-circle and good enough for
    spread filtering. Handles longitude wraparound across the antimeridian.
    """
    threshold_sq = min_deg * min_deg
    for alat, alng in accepted:
        dlat = lat - alat
        dlng = lng - alng
        if dlng > 180:
            dlng -= 360
        elif dlng < -180:
            dlng += 360
        if dlat * dlat + dlng * dlng < threshold_sq:
            return True
    return False

"""Great-circle air routing for the Petros mock plane fleet.

The aviation analogue of `sea_routing.py`. Planes don't snake through
straits — they take great-circle paths, which on a map look curved
(because we project a sphere to a flat surface). We sample N points along
the great-circle path from departure airport to arrival airport, give
each one a `speedLimit` based on flight phase (climb / cruise / descent),
and the frontend simulator's `moveVehicle` ticks the plane forward along
that polyline exactly like it does for ships.

Why not just draw a straight line? Trans-Pacific and polar flights look
wildly off — JFK -> NRT actually goes over the Arctic, not the Pacific.
A great-circle interpolation matches what real flight tracking sites show
and keeps the visualization honest.

Antimeridian: the formula returns longitudes in (-180, 180], so a
trans-Pacific path would jump from +179 to -179 mid-route and Mapbox
would render it the long way around the globe. We unwrap consecutive
longitudes so they stay continuous, mirroring what searoute does for
trans-Pacific ship routes.
"""

from __future__ import annotations

import math
from typing import Optional

EARTH_R_KM = 6371.0


# Flight phase boundaries (as fraction of total route distance) and the
# speed limit applied within each phase. Real climb/descent take ~25 min
# each on long-haul, which works out to ~5-8% of total trip distance on a
# typical international flight. We round to 10% for clean speed bands.
_CLIMB_FRACTION   = 0.10  # first 10% of route
_DESCENT_FRACTION = 0.90  # last 10% of route starts here

_CLIMB_KMH   = 700.0   # ~380 kn — climb-out groundspeed
_CRUISE_KMH  = 900.0   # ~485 kn — typical wide-body cruise (B777F, B747-8F)
_DESCENT_KMH = 750.0   # ~405 kn — descent + initial approach


def _gc_distance_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle distance in km. Args are (lng, lat) in degrees."""
    lng1, lat1 = math.radians(a[0]), math.radians(a[1])
    lng2, lat2 = math.radians(b[0]), math.radians(b[1])
    h = (
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    )
    return 2 * EARTH_R_KM * math.asin(math.sqrt(h))


def _gc_interpolate(
    start: tuple[float, float], end: tuple[float, float], f: float
) -> tuple[float, float]:
    """Great-circle interpolation at fraction f in [0, 1].

    start/end are (lng, lat) in degrees. Returns (lng, lat) for the point
    at fractional distance f along the great-circle arc from start to end.
    Standard spherical slerp — same formula used by aviation flight planners.
    """
    lng1, lat1 = math.radians(start[0]), math.radians(start[1])
    lng2, lat2 = math.radians(end[0]), math.radians(end[1])

    # Angular distance between endpoints (radians)
    d = 2 * math.asin(math.sqrt(
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    ))

    if d < 1e-9:
        return start  # coincident endpoints

    A = math.sin((1 - f) * d) / math.sin(d)
    B = math.sin(f * d) / math.sin(d)

    x = A * math.cos(lat1) * math.cos(lng1) + B * math.cos(lat2) * math.cos(lng2)
    y = A * math.cos(lat1) * math.sin(lng1) + B * math.cos(lat2) * math.sin(lng2)
    z = A * math.sin(lat1) + B * math.sin(lat2)

    lat = math.atan2(z, math.sqrt(x * x + y * y))
    lng = math.atan2(y, x)

    return (math.degrees(lng), math.degrees(lat))


def _unwrap_longitudes(
    points: list[tuple[float, float]],
) -> list[tuple[float, float]]:
    """Walk points in order, adjusting each longitude by +-360 so consecutive
    deltas are never > 180. Lets Mapbox render trans-Pacific great-circles
    continuously instead of going the long way around the globe.

    Mirrors the antimeridian handling that searoute does natively for
    ship routes.
    """
    if not points:
        return points
    out = [points[0]]
    for i in range(1, len(points)):
        prev_lng, _ = out[i - 1]
        lng, lat = points[i]
        while lng - prev_lng > 180:
            lng -= 360
        while lng - prev_lng < -180:
            lng += 360
        out.append((lng, lat))
    return out


def _speed_for_fraction(f: float, cruise_kmh: float = _CRUISE_KMH) -> float:
    """Speed limit (km/h) at fraction f of the route. Climb -> cruise -> descent."""
    if f < _CLIMB_FRACTION:
        return _CLIMB_KMH
    if f >= _DESCENT_FRACTION:
        return _DESCENT_KMH
    return cruise_kmh


# Process-lifetime cache keyed by (origin_lng, origin_lat, dest_lng, dest_lat).
# Petros plane origins/destinations are static so we never need to invalidate.
_route_cache: dict[tuple[float, float, float, float], list[dict]] = {}


def _cache_key(
    origin: tuple[float, float], destination: tuple[float, float]
) -> tuple[float, float, float, float]:
    return (
        round(origin[0], 4),
        round(origin[1], 4),
        round(destination[0], 4),
        round(destination[1], 4),
    )


def build_air_route(
    origin: tuple[float, float],
    destination: tuple[float, float],
    *,
    n_points: int = 60,
    cruise_kmh: float = _CRUISE_KMH,
) -> list[dict]:
    """Build a great-circle air route with N+1 interpolated waypoints.

    Args are (lng, lat) tuples. Returns a list of RoutePoint dicts:
        {lng, lat, speedLimit, cumulativeDistance, cumulativeTime}

    speedLimit varies by flight phase (climb/cruise/descent). cumulativeTime
    uses the slower endpoint of each leg for honest ETA.

    Empty list if origin/destination are coincident or invalid.
    """
    key = _cache_key(origin, destination)
    if key in _route_cache:
        return _route_cache[key]

    total_km = _gc_distance_km(origin, destination)
    if total_km < 1.0:
        return []

    # Sample N+1 points along the great-circle path
    raw_points: list[tuple[float, float]] = []
    for i in range(n_points + 1):
        f = i / n_points
        raw_points.append(_gc_interpolate(origin, destination, f))

    # Unwrap longitudes so antimeridian-crossing routes render continuously
    raw_points = _unwrap_longitudes(raw_points)

    # Build RoutePoint list with cumulative distance/time and phase-aware speed
    out: list[dict] = []
    cum_km = 0.0
    cum_min = 0.0
    prev_speed = _speed_for_fraction(0.0, cruise_kmh)
    for i, (lng, lat) in enumerate(raw_points):
        f = i / n_points
        speed_limit = _speed_for_fraction(f, cruise_kmh)
        if i > 0:
            # Haversine needs both lngs in (-180, 180] — unwrapped points
            # can exceed that range, but the distance math wraps around.
            prev_lng, prev_lat = raw_points[i - 1]
            prev_norm = ((prev_lng + 180) % 360 - 180, prev_lat)
            curr_norm = ((lng + 180) % 360 - 180, lat)
            leg_km = _gc_distance_km(prev_norm, curr_norm)
            cum_km += leg_km
            # Slower endpoint sets the leg time — keeps ETA honest for
            # legs straddling a phase boundary.
            leg_speed = min(prev_speed, speed_limit)
            cum_min += (leg_km / leg_speed) * 60.0
        out.append({
            "lng": lng,
            "lat": lat,
            "speedLimit": speed_limit,
            "cumulativeDistance": cum_km,
            "cumulativeTime": cum_min,
        })
        prev_speed = speed_limit

    _route_cache[key] = out
    return out


def heading_for_route(
    origin: tuple[float, float],
    route: list[dict],
    *,
    min_leg_km: float = 5.0,
) -> Optional[float]:
    """Bearing from origin (plane's current position) toward the next forward
    route point. Mirrors the ship version in sea_routing.py — finds the route
    point closest to origin, then bearing to the first subsequent point that's
    at least `min_leg_km` away for stability.
    """
    if not route or len(route) < 2:
        return None

    # Closest route point to current position
    closest_idx = 0
    min_d = float("inf")
    for i, pt in enumerate(route):
        d = _gc_distance_km(origin, (pt["lng"], pt["lat"]))
        if d < min_d:
            min_d = d
            closest_idx = i

    # First subsequent point >= min_leg_km from origin
    for i in range(closest_idx + 1, len(route)):
        pt = route[i]
        d = _gc_distance_km(origin, (pt["lng"], pt["lat"]))
        if d >= min_leg_km:
            return _bearing_deg(origin, (pt["lng"], pt["lat"]))

    # Fallback: route ends very close to origin
    last = route[-1]
    return _bearing_deg(origin, (last["lng"], last["lat"]))


def _bearing_deg(
    origin: tuple[float, float], next_pt: tuple[float, float]
) -> float:
    """Compass bearing (0 = N, 90 = E) from origin to next_pt."""
    lat1, lat2 = math.radians(origin[1]), math.radians(next_pt[1])
    dlng = math.radians(next_pt[0] - origin[0])
    y = math.sin(dlng) * math.cos(lat2)
    x = (
        math.cos(lat1) * math.sin(lat2)
        - math.sin(lat1) * math.cos(lat2) * math.cos(dlng)
    )
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def distance_travelled_for_position(
    position: tuple[float, float],
    route: list[dict],
) -> float:
    """Cumulative-distance value at the route point closest to `position`.

    Same purpose as the ship version: lets `moveVehicle` start the plane at
    the right spot along its route. Without this, distanceTravelled defaults
    to 0 and the simulator snaps every plane to route[0] (departure airport)
    on every tick — same bug class that hit ships.
    """
    if not route:
        return 0.0

    cos_lat = math.cos(math.radians(position[1]))
    best_d2 = float("inf")
    best_cum = 0.0
    for pt in route:
        dlng = pt["lng"] - position[0]
        while dlng > 180:
            dlng -= 360
        while dlng < -180:
            dlng += 360
        dlat = pt["lat"] - position[1]
        d2 = dlat * dlat + (dlng * cos_lat) ** 2
        if d2 < best_d2:
            best_d2 = d2
            best_cum = float(pt.get("cumulativeDistance", 0.0))
    return best_cum

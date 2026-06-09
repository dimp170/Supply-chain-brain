"""Maritime routing via the `searoute` library (Python port of eurostat/searoute).

The searoute library computes the shortest maritime route between two
coordinates over the Oak Ridge National Labs Global Shipping Lane Network
(2000) enriched with AIS-derived European coast detail. The same algorithm
(Dijkstra on a maritime line network) and the same data source as the
canonical Java tool at https://github.com/eurostat/searoute. Apache 2.0.

Why this and not hand-curated polylines:
  * Real shipping-network data — not waypoint approximations
  * Correctly handles all canonical chokepoints (Suez, Panama, Malacca,
    Gibraltar, Dover, Bering, Magellan, Bab-el-Mandeb, Kiel, Corinth,
    NW/NE Passages)
  * Returns longitudes in continuous form across the antimeridian, so
    Mapbox renders trans-Pacific arcs as short westward/eastward paths
    instead of going the long way around the globe
  * One library replaces ~50 hand-curated route definitions and the older
    waypoint-chain algorithm

Cache: Petros ship origin/destination pairs are static (the fleet doesn't
relocate), so a process-lifetime dict cache makes repeat `/api/fleet/petros`
hits free. Cache key is rounded to 4 decimal places (~11 m), so tiny float
jitter doesn't break cache locality.
"""
from __future__ import annotations

import math
from typing import Optional

try:
    import searoute as _sr
    _SR_AVAILABLE = True
except ImportError:
    _sr = None
    _SR_AVAILABLE = False


EARTH_R_KM = 6371.0


# ── Chokepoint speed modulation ──────────────────────────────────────────────
# Coordinates mirror data/chokepoints.ts on the frontend (keep in sync if you
# add new ones). Realistic ship speeds drop sharply near canals (Suez/Panama
# mandate ~8 kn) and traffic separation schemes (Malacca/Hormuz). The bands
# below are baked into each route point's `speedLimit` by `_convert_to_route_points`,
# and `moveVehicle` on the frontend reads that field per-tick — so a ship
# visibly decelerates as it enters Suez and accelerates out the other side
# without any extra runtime logic on the client.

_PRIMARY_CHOKEPOINTS: list[tuple[float, float]] = [
    (32.3,   30.7),  # Suez Canal
    (56.4,   26.5),  # Strait of Hormuz
    (43.4,   12.6),  # Bab el-Mandeb
    (103.5,   1.3),  # Strait of Malacca
    (-79.9,   9.3),  # Panama Canal
    (-5.4,   36.1),  # Gibraltar
    (29.0,   41.0),  # Bosphorus
    (18.5,  -34.4),  # Cape of Good Hope (rounding chokepoint, not a strait)
]

_SECONDARY_CHOKEPOINTS: list[tuple[float, float]] = [
    (12.6,   55.9),  # Øresund
    (1.4,    51.1),  # Dover Strait
    (115.7,  -8.5),  # Lombok Strait
    (121.0,  20.5),  # Luzon Strait
]

# Distance bands (km) — concentric rings around each chokepoint. Primary
# zones are wider because Suez/Panama are channels: 80 km radius covers
# roughly half the Suez Canal's length from its midpoint, enough that ships
# hit the slow band before crossing the actual canal.
_PRIMARY_TRANSIT_KM   = 80.0
_PRIMARY_APPROACH_KM  = 200.0
_SECONDARY_TRANSIT_KM = 60.0
_SECONDARY_APPROACH_KM = 150.0

# Speed limits (km/h). moveVehicle applies a `-5` buffer (so a 20 km/h
# speed limit translates to a ~15 km/h actual speed, matching Suez's 8 kn
# mandate). Open-ocean default is 40 km/h ≈ 22 kn container cruise.
_OPEN_OCEAN_KMH       = 40.0
_PRIMARY_APPROACH_KMH = 30.0
_PRIMARY_TRANSIT_KMH  = 20.0
_SECONDARY_APPROACH_KMH = 35.0
_SECONDARY_TRANSIT_KMH  = 28.0


def _speed_limit_for_position(
    lng: float, lat: float, cruise_kmh: float = _OPEN_OCEAN_KMH
) -> float:
    """Return the ship speed limit (km/h) for a point at (lng, lat).

    Walks the chokepoint list, finds the closest primary and secondary, and
    picks the tightest band that applies. Primary always wins over secondary
    at the same band — Suez Canal trumps a nearby strait if both are in range.

    Falls back to `cruise_kmh` (open-ocean cruise) when the point is far from
    every chokepoint, which is the common case for most of a route.
    """
    pos = (lng, lat)

    min_primary = float("inf")
    for cp in _PRIMARY_CHOKEPOINTS:
        d = _haversine_km(pos, cp)
        if d < min_primary:
            min_primary = d

    min_secondary = float("inf")
    for cp in _SECONDARY_CHOKEPOINTS:
        d = _haversine_km(pos, cp)
        if d < min_secondary:
            min_secondary = d

    # Primary wins ties — a ship near both Bab-el-Mandeb (primary) and
    # something secondary gets the primary slowdown.
    if min_primary <= _PRIMARY_TRANSIT_KM:
        return _PRIMARY_TRANSIT_KMH
    if min_primary <= _PRIMARY_APPROACH_KM:
        return _PRIMARY_APPROACH_KMH
    if min_secondary <= _SECONDARY_TRANSIT_KM:
        return _SECONDARY_TRANSIT_KMH
    if min_secondary <= _SECONDARY_APPROACH_KM:
        return _SECONDARY_APPROACH_KMH
    return cruise_kmh


def _haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle distance in km. Args are (lng, lat) tuples."""
    lat1, lat2 = math.radians(a[1]), math.radians(b[1])
    dlat = math.radians(b[1] - a[1])
    dlng = math.radians(b[0] - a[0])
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return 2 * EARTH_R_KM * math.asin(math.sqrt(h))


def initial_bearing_deg(origin: tuple[float, float], next_pt: tuple[float, float]) -> float:
    """Compass bearing in degrees (0 = N, 90 = E, etc.) from origin to next_pt.

    Use this to point the ship marker in the direction it'll actually start
    moving along the computed route. Without this, hand-set JSON headings
    can disagree with the route's first leg, making ships visually look
    like they're doing a U-turn the moment the route is rendered.
    """
    lat1, lat2 = math.radians(origin[1]), math.radians(next_pt[1])
    dlng = math.radians(next_pt[0] - origin[0])
    y = math.sin(dlng) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlng)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def heading_for_route(
    origin: tuple[float, float],
    route: list[dict],
    *,
    min_leg_km: float = 5.0,
) -> Optional[float]:
    """Compute the heading from `origin` toward where the route goes NEXT.

    `origin` is typically the ship's CURRENT position, which sits partway
    along the route. We:
      1. Find the route point closest to origin (where the ship is "now")
      2. Walk forward to the first subsequent point that's at least
         `min_leg_km` away — far enough that the bearing is stable
      3. Return the bearing from origin to that forward point

    Steps 1+2 matter because the route now runs full-length from the
    origin PORT to the destination PORT, with the ship somewhere along it.
    Without step 1 we would compute the bearing to the route's start
    (the origin port, behind the ship) and point ships backward. Without
    step 2 we'd pick a sub-km waypoint hop and get a noisy bearing that
    disagrees with the long-haul direction.

    Returns None if the route is too short to derive a stable bearing —
    caller should fall back to whatever heading was already set.
    """
    if not route or len(route) < 2:
        return None

    # 1. Closest route point to current position
    closest_idx = 0
    min_dist = float("inf")
    for i, pt in enumerate(route):
        d = _haversine_km(origin, (pt["lng"], pt["lat"]))
        if d < min_dist:
            min_dist = d
            closest_idx = i

    # 2. First subsequent point >= min_leg_km from origin
    for i in range(closest_idx + 1, len(route)):
        pt = route[i]
        d = _haversine_km(origin, (pt["lng"], pt["lat"]))
        if d >= min_leg_km:
            return initial_bearing_deg(origin, (pt["lng"], pt["lat"]))

    # Fallback: route ends very close to origin — use the route's terminus
    last = route[-1]
    return initial_bearing_deg(origin, (last["lng"], last["lat"]))


def distance_travelled_for_position(
    position: tuple[float, float],
    route: list[dict],
) -> float:
    """Return the cumulative-distance value at the route point closest to `position`.

    The frontend simulator's `moveVehicle` uses `distanceTravelled` as the
    ship's progress along the route — `turf.along(line, distanceTravelled)`
    places the marker exactly that many km from the route's start. If
    `distanceTravelled` is 0 (or missing), the simulator parks the ship at
    route[0] every tick, which is now the origin PORT. That's why every
    ship visually snapped to its starting port even though the JSON had it
    mid-route.

    By computing distance_travelled from the ship's persisted position, we
    let the simulator start each ship at the correct spot AND keep ticking
    forward from there — preserving the slow drift the simulator gives the
    demo without resetting positions every frame.

    `position` is (lng, lat). Returns 0.0 if the route is empty.
    """
    if not route:
        return 0.0

    # Wrap-aware squared distance — Pacific routes carry coords like 241°E,
    # so a naive lng subtraction against a ship at -119°W would pick the
    # wrong nearest point.
    cos_lat = math.cos(math.radians(position[1]))
    best_d2 = float("inf")
    best_cum = 0.0
    for pt in route:
        dlng = pt["lng"] - position[0]
        # Normalize to (-180, 180]
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


# Process-lifetime cache keyed by (origin_lng, origin_lat, dest_lng, dest_lat),
# rounded to 4dp (~11 m). Petros ship origins/destinations are static so we
# never need to invalidate. If we ever wire this for live AIS ships, the
# origin moves every poll — the cache would still pay for itself within the
# same poll cycle but routes would naturally refresh as ships move enough
# to land in a new cache bucket.
_route_cache: dict[tuple[float, float, float, float], list[dict]] = {}


def _cache_key(origin: tuple[float, float], destination: tuple[float, float]) -> tuple[float, float, float, float]:
    return (
        round(origin[0], 4),
        round(origin[1], 4),
        round(destination[0], 4),
        round(destination[1], 4),
    )


def _convert_to_route_points(
    coordinates: list[list[float]],
    cruise_kmh: float = 40.0,
) -> list[dict]:
    """Convert searoute's GeoJSON LineString coordinates into the
    RoutePoint shape the frontend expects.

    The GeoJSON coords are `[lng, lat]` pairs. The frontend RoutePoint type
    needs `{lng, lat, speedLimit, cumulativeDistance, cumulativeTime}`. We
    derive cumulative distance from haversine between consecutive points
    and cumulative time from a fixed cruise speed (40 km/h ~ 22 knots,
    typical container-ship cruise).
    """
    points: list[dict] = []
    cum_km = 0.0
    cum_min = 0.0
    prev: Optional[tuple[float, float]] = None
    prev_speed = cruise_kmh
    for coord in coordinates:
        if len(coord) < 2:
            continue
        lng, lat = float(coord[0]), float(coord[1])
        # Speed limit at this waypoint — drops near chokepoints, defaults to
        # cruise speed in open ocean. moveVehicle on the frontend reads this
        # field per-tick, so a ship visibly decelerates as it enters Suez or
        # Malacca and accelerates out the other side.
        speed_limit = _speed_limit_for_position(lng, lat, cruise_kmh)
        if prev is not None:
            # Normalize longitudes to ±180 for haversine so the continuous
            # representation searoute returns for antimeridian crossings
            # (e.g., 241°E) doesn't blow up the distance math. We KEEP the
            # raw lng in the output point so Mapbox still renders the path
            # correctly across the dateline.
            prev_norm = ((prev[0] + 180) % 360 - 180, prev[1])
            curr_norm = ((lng + 180) % 360 - 180, lat)
            leg_km = _haversine_km(prev_norm, curr_norm)
            cum_km += leg_km
            # Use the slower of the two endpoints for leg time — keeps ETA
            # honest when a leg transits a chokepoint at one end. Avoids
            # the optimism of crediting the leg with cruise speed when half
            # of it is spent crawling through Suez.
            leg_speed = min(prev_speed, speed_limit)
            cum_min += (leg_km / leg_speed) * 60.0
        points.append({
            "lng": lng,
            "lat": lat,
            "speedLimit": speed_limit,
            "cumulativeDistance": cum_km,
            "cumulativeTime": cum_min,
        })
        prev = (lng, lat)
        prev_speed = speed_limit
    return points


# Max distance (km) we'll bridge with a straight line between the actual
# origin/destination and the nearest searoute network node. If the gap is
# bigger than this — e.g. the input is deep inland or in a sea the network
# doesn't cover well — we leave the raw network output alone so we don't
# accidentally draw a straight line across a continent.
_ENDPOINT_BRIDGE_MAX_KM = 300.0


def _bridge_endpoints(
    coordinates: list[list[float]],
    origin: tuple[float, float],
    destination: tuple[float, float],
) -> list[list[float]]:
    """Prepend the real origin and append the real destination if they fall
    within ENDPOINT_BRIDGE_MAX_KM of the searoute network's nearest node.

    searoute snaps both endpoints to the nearest node on its shipping-lane
    network (5-50 km away in most ocean cases). Without bridging, the
    rendered line has a visible gap between the ship marker and where the
    route actually starts — same at the destination port. Adding the real
    endpoints as bracketing points closes the gap on the map.
    """
    if not coordinates:
        return coordinates

    out = list(coordinates)

    # Prepend origin if reasonably close to first network point
    first = out[0]
    if len(first) >= 2:
        gap_km = _haversine_km(origin, (float(first[0]), float(first[1])))
        if 0.001 < gap_km < _ENDPOINT_BRIDGE_MAX_KM:
            out.insert(0, [origin[0], origin[1]])

    # Append destination if reasonably close to last network point
    last = out[-1]
    if len(last) >= 2:
        gap_km = _haversine_km(destination, (float(last[0]), float(last[1])))
        if 0.001 < gap_km < _ENDPOINT_BRIDGE_MAX_KM:
            out.append([destination[0], destination[1]])

    return out


def build_ship_route(
    origin: tuple[float, float],
    destination: tuple[float, float],
    *,
    cruise_kmh: float = 40.0,
) -> list[dict]:
    """Compute a maritime route from origin to destination.

    Args are (lng, lat) tuples. Returns a list of RoutePoint dicts:
        {lng, lat, speedLimit, cumulativeDistance, cumulativeTime}

    The first and last points are bridged to the actual origin/destination
    so the rendered line touches the ship marker visibly. See
    `_bridge_endpoints` for the distance gating.

    Empty list on failure or when searoute is unavailable — callers can
    treat that as "no route to render" without crashing.
    """
    if not _SR_AVAILABLE:
        print(
            "[sea_routing] searoute library not available — run "
            "`pip install searoute` in the backend env.",
            flush=True,
        )
        return []

    key = _cache_key(origin, destination)
    if key in _route_cache:
        return _route_cache[key]

    try:
        # searoute expects [lng, lat] lists. Origin/destination tuples in
        # our codebase are already (lng, lat) ordered.
        feature = _sr.searoute(list(origin), list(destination))
        geometry = feature.get("geometry") or {}
        coordinates = geometry.get("coordinates") or []
        coordinates = _bridge_endpoints(coordinates, origin, destination)
        points = _convert_to_route_points(coordinates, cruise_kmh=cruise_kmh)
    except Exception as exc:
        print(
            f"[sea_routing] searoute failed for {origin} -> {destination}: "
            f"{type(exc).__name__}: {exc}",
            flush=True,
        )
        return []

    _route_cache[key] = points
    return points

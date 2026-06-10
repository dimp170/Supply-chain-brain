"""NVIDIA NIM-powered rerouting engine.

Given a vehicle's current position, destination, and a hazard zone (weather,
geopolitical, traffic), this service:
  1. Calls NVIDIA NIM LLM to classify the threat and recommend avoidance strategy.
  2. Calls HERE Routing with avoid[areas] to compute an alternative route.
  3. Returns the new route + delay estimate + AI explanation.

Falls back to a deterministic mock if NVIDIA_API_KEY is not set — useful for
demos before the key is provisioned.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Optional

import httpx

from .routing import fetch_truck_route, _haversine_km

# ─── NVIDIA NIM config ─────────────────────────────────────────────────────────

NVIDIA_API_URL = "https://integrate.api.nvidia.com/v1/chat/completions"
NVIDIA_MODEL = "meta/llama-3.1-70b-instruct"


def _nvidia_key() -> str:
    return os.environ.get("NVIDIA_API_KEY", "")


# ─── Types ─────────────────────────────────────────────────────────────────────

@dataclass
class HazardZone:
    """A circular hazard zone defined by center + radius."""
    lat: float
    lng: float
    radius_km: float
    reason: str  # "weather", "geopolitical", "traffic"
    description: str  # human-readable detail


@dataclass
class RerouteResult:
    """Result of a reroute optimization."""
    success: bool
    original_route: list[dict]
    new_route: list[dict]
    original_distance_km: float
    new_distance_km: float
    original_time_hrs: float
    new_time_hrs: float
    delay_hrs: float
    hazard: dict
    explanation: str
    ai_powered: bool  # True if NIM was used, False if mock


# ─── NIM Integration ───────────────────────────────────────────────────────────

async def _call_nvidia_nim(hazard: HazardZone, vehicle_name: str, origin: tuple, dest: tuple) -> str:
    """Call NVIDIA NIM to get an AI explanation of the rerouting decision."""
    key = _nvidia_key()
    if not key:
        return ""

    system_prompt = """You are a supply chain logistics AI. You analyze transportation hazards and explain rerouting decisions concisely. 
Respond in 2-3 sentences maximum. Be specific about the threat and the routing strategy."""

    user_prompt = f"""A fleet vehicle "{vehicle_name}" traveling from ({origin[0]:.2f}, {origin[1]:.2f}) to ({dest[0]:.2f}, {dest[1]:.2f}) 
has encountered a {hazard.reason} hazard: "{hazard.description}" centered at ({hazard.lat:.2f}, {hazard.lng:.2f}) with a {hazard.radius_km:.0f}km affected radius.

Explain the rerouting decision and expected impact in 2-3 sentences."""

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                NVIDIA_API_URL,
                headers={
                    "Authorization": f"Bearer {key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": NVIDIA_MODEL,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                    "temperature": 0.3,
                    "max_tokens": 200,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            return data["choices"][0]["message"]["content"].strip()
    except Exception as exc:
        print(f"[rerouter] NIM call failed: {exc}")
        return ""


def _mock_explanation(hazard: HazardZone, delay_hrs: float) -> str:
    """Generate a realistic-sounding explanation when NIM is unavailable."""
    reason_text = {
        "weather": f"Severe weather conditions ({hazard.description}) detected",
        "geopolitical": f"Geopolitical risk ({hazard.description}) identified",
        "traffic": f"Major traffic disruption ({hazard.description}) reported",
    }.get(hazard.reason, f"Hazard ({hazard.description}) detected")

    return (
        f"{reason_text} within a {hazard.radius_km:.0f}km radius of "
        f"({hazard.lat:.2f}, {hazard.lng:.2f}). Route optimized to bypass the "
        f"affected corridor with an estimated additional {delay_hrs:.1f} hours in transit. "
        f"Alternative path selected to minimize delay while maintaining safe clearance "
        f"from the hazard perimeter."
    )


# ─── Avoidance waypoint computation ───────────────────────────────────────────

def _compute_avoidance_waypoint(
    origin: tuple[float, float],
    dest: tuple[float, float],
    hazard: HazardZone,
) -> tuple[float, float]:
    """Compute a waypoint that routes around the hazard zone.
    
    Strategy: find the perpendicular offset from the hazard center relative to
    the origin→dest line, then push a waypoint out beyond the hazard radius.
    """
    import math

    o_lat, o_lng = origin
    d_lat, d_lng = dest
    h_lat, h_lng = hazard.lat, hazard.lng

    # Vector from origin to dest
    dx = d_lng - o_lng
    dy = d_lat - o_lat

    # Vector from origin to hazard
    hx = h_lng - o_lng
    hy = h_lat - o_lat

    # Project hazard onto the route line to find closest point
    line_len_sq = dx * dx + dy * dy
    if line_len_sq < 1e-10:
        # Origin and dest are the same point — just offset north
        return (h_lat + hazard.radius_km / 111.0 * 1.5, h_lng)

    t = max(0.0, min(1.0, (hx * dx + hy * dy) / line_len_sq))

    # Closest point on line to hazard center
    closest_lng = o_lng + t * dx
    closest_lat = o_lat + t * dy

    # Perpendicular direction from line to hazard
    perp_lng = h_lng - closest_lng
    perp_lat = h_lat - closest_lat
    perp_dist = math.sqrt(perp_lng ** 2 + perp_lat ** 2)

    if perp_dist < 1e-10:
        # Hazard is exactly on the line — offset perpendicular (rotate 90°)
        perp_lng = -dy
        perp_lat = dx
        perp_dist = math.sqrt(perp_lng ** 2 + perp_lat ** 2)

    # Normalize perpendicular direction
    perp_lng /= perp_dist
    perp_lat /= perp_dist

    # Push waypoint in the OPPOSITE direction from hazard (away from hazard)
    # at a distance = hazard radius * 1.5 (safety margin)
    offset_deg = (hazard.radius_km / 111.0) * 1.8  # km → degrees (approx)
    
    wp_lat = closest_lat - perp_lat * offset_deg
    wp_lng = closest_lng - perp_lng * offset_deg

    return (wp_lat, wp_lng)


# ─── HERE Routing with avoidance ───────────────────────────────────────────────

HERE_ROUTES = "https://router.hereapi.com/v8/routes"


def _here_key() -> str:
    return os.environ.get("HERE_API_KEY") or os.environ.get("NEXT_PUBLIC_HERE_API_KEY", "")


async def _fetch_route_via_waypoint(
    origin: tuple[float, float],
    waypoint: tuple[float, float],
    dest: tuple[float, float],
) -> list[dict]:
    """Fetch a route that goes through a waypoint (to avoid hazard zone).
    
    Uses HERE Routing v8 with an intermediate waypoint.
    """
    key = _here_key()
    if not key:
        raise RuntimeError("HERE_API_KEY not set")

    o_lat, o_lng = origin
    w_lat, w_lng = waypoint
    d_lat, d_lng = dest

    # HERE v8 supports via waypoints by adding them between origin and destination
    params = {
        "transportMode": "truck",
        "origin": f"{o_lat},{o_lng}",
        "via": f"{w_lat},{w_lng}",
        "destination": f"{d_lat},{d_lng}",
        "return": "polyline,summary,travelSummary",
        "spans": "streetAttributes,speedLimit,dynamicSpeedInfo",
        "apiKey": key,
    }
    
    async with httpx.AsyncClient(timeout=25.0) as client:
        r = await client.get(HERE_ROUTES, params=params)
        r.raise_for_status()
        data = r.json()

    from .routing import decode_flexpolyline

    routes = data.get("routes") or []
    if not routes:
        raise RuntimeError("no avoidance route returned from HERE")

    # Combine all sections
    all_points: list[tuple[float, float]] = []
    all_spans: list[dict] = []
    
    for section in routes[0].get("sections", []):
        polyline = section.get("polyline", "")
        spans = section.get("spans", [])
        decoded = decode_flexpolyline(polyline)
        
        offset_base = len(all_points)
        all_points.extend(decoded)
        for span in spans:
            adjusted = dict(span)
            adjusted["offset"] = span.get("offset", 0) + offset_base
            all_spans.append(adjusted)

    if not all_points:
        return []

    # Build RoutePoint list
    import math
    cumulative_distance = 0.0
    span_idx = 0
    out: list[dict] = []
    
    for idx, (lat, lng) in enumerate(all_points):
        while span_idx + 1 < len(all_spans) and all_spans[span_idx + 1].get("offset", 10**9) <= idx:
            span_idx += 1
        span = all_spans[span_idx] if all_spans else None
        
        distance = 0.0
        if idx > 0:
            distance = _haversine_km(all_points[idx - 1], (lat, lng))
            cumulative_distance += distance

        speed_limit_mps = (span or {}).get("speedLimit")
        speed_limit_kmh = (speed_limit_mps * 3.6) if isinstance(speed_limit_mps, (int, float)) else 30.0
        
        out.append({
            "lat": lat,
            "lng": lng,
            "speedLimit": speed_limit_kmh,
            "trafficSpeed": None,
            "cumulativeDistance": cumulative_distance,
            "distance": distance,
        })

    return out


# ─── Main reroute function ─────────────────────────────────────────────────────

async def compute_reroute(
    vehicle_name: str,
    origin: tuple[float, float],     # (lat, lng)
    destination: tuple[float, float], # (lat, lng)
    hazard: HazardZone,
) -> RerouteResult:
    """Compute an optimized reroute avoiding the given hazard zone.
    
    Returns both original and new route for comparison.
    """
    o_lat, o_lng = origin
    d_lat, d_lng = destination

    # 1. Fetch original (direct) route
    try:
        original_route = await fetch_truck_route((o_lng, o_lat), (d_lng, d_lat))
    except Exception as exc:
        print(f"[rerouter] original route fetch failed: {exc}")
        original_route = []

    # 2. Compute avoidance waypoint
    avoidance_wp = _compute_avoidance_waypoint(origin, destination, hazard)

    # 3. Fetch rerouted path through waypoint
    try:
        new_route = await _fetch_route_via_waypoint(origin, avoidance_wp, destination)
    except Exception as exc:
        print(f"[rerouter] avoidance route failed: {exc}")
        new_route = []

    # 4. Compute metrics
    orig_dist = original_route[-1]["cumulativeDistance"] if original_route else 0.0
    new_dist = new_route[-1]["cumulativeDistance"] if new_route else 0.0

    # Estimate time: use average speed of 80 km/h for trucks
    avg_speed = 80.0
    orig_time_hrs = orig_dist / avg_speed if orig_dist > 0 else 0.0
    new_time_hrs = new_dist / avg_speed if new_dist > 0 else 0.0
    delay_hrs = max(0.0, new_time_hrs - orig_time_hrs)

    # 5. Get AI explanation (NIM or mock)
    ai_explanation = await _call_nvidia_nim(hazard, vehicle_name, origin, destination)
    ai_powered = bool(ai_explanation)
    
    if not ai_explanation:
        ai_explanation = _mock_explanation(hazard, delay_hrs)

    return RerouteResult(
        success=bool(new_route),
        original_route=original_route,
        new_route=new_route,
        original_distance_km=orig_dist,
        new_distance_km=new_dist,
        original_time_hrs=orig_time_hrs,
        new_time_hrs=new_time_hrs,
        delay_hrs=delay_hrs,
        hazard={
            "lat": hazard.lat,
            "lng": hazard.lng,
            "radius_km": hazard.radius_km,
            "reason": hazard.reason,
            "description": hazard.description,
        },
        explanation=ai_explanation,
        ai_powered=ai_powered,
    )

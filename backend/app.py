"""FastAPI coordination gateway.

This is the backend half of Supply Chain Brain. It owns:
  * the AISStream WebSocket worker (services.ingestor)   → vessel_cache
  * the RSS scraper (services.risk_engine)               → port_alerts
  * regex matching of vessel names → operator (services.fleet_matcher)
  * the HERE Routing proxy (services.routing)            used by truck overlay
  * the Aviation Edge proxy (services.planes)            used by plane overlay

The Next.js frontend talks to this app via the endpoints below; it never
hits AIS/HERE/Aviation Edge directly. All endpoints return JSON shaped to
match the TypeScript types in types/vehicle.ts so the React store can
swallow them with no transformation.

Run from the backend/ directory:
    uvicorn app:app --reload --port 8000

(npm run dev does this for you.)
"""
from __future__ import annotations

import asyncio
import json
import re

import httpx
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# Load .env.local from the repo root (one level above backend/) BEFORE importing
# any service that reads env vars at module-import time. Next.js loads
# .env.local automatically; uvicorn does not, so we do it explicitly here.
from dotenv import load_dotenv
_ENV_FILE = Path(__file__).resolve().parent.parent / ".env.local"
load_dotenv(_ENV_FILE, override=False)

from fastapi import FastAPI, HTTPException, Query, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from services._geo import grid_bucket as _grid_bucket, too_close as _too_close
from services.database import fetch_all_alerts, fetch_all_vessels, get_pool
from services.fleet_matcher import FleetMatcher
from services.ingestor import AISIngestor
from services.planes import fetch_live_planes
from services.rerouter import compute_reroute, HazardZone
from services.risk_engine import PortRiskEngine
from services.routing import fetch_truck_route
from services.route_cache import (
    get as cached_route_get,
    put as cached_route_put,
)
from services.nim_chat import chat as nim_chat
from services.port_coords import coords_for_port
from services.airport_coords import coords_for_airport
from services.sea_routing import build_ship_route, heading_for_route, distance_travelled_for_position
from services.manifest_generator import (
    build_manifest_for_ship,
    build_truck_manifest_for_truck,
    build_plane_manifest_for_plane,
)
from services.manifest_xlsx import build_manifest_xlsx_for_vehicle
from services.air_routing import (
    build_air_route,
    heading_for_route as heading_for_air_route,
    distance_travelled_for_position as distance_travelled_for_air_position,
)
from services.weather import fetch_weather_for_locations

# Paths. ROOT is the backend/ directory; the shared data/ folder sits one
# level up at the repo root so the frontend can read its JSON seeds too.
ROOT = Path(__file__).resolve().parent
TEMPLATES = ROOT / "templates"
DATA = ROOT.parent / "data"

# Quality criteria the frontend used to enforce client-side. Source of truth
# lives here now so the cap fills with usable ships.
MIN_UNDERWAY_KMH = 5.0
KNOTS_TO_KMH = 1.852
MAX_EMITTED = 100
PORT_NAV_STATUSES = {1, 5, 6}  # anchored, moored, aground

# Restrict /api/vessels to commercial cargo + tanker traffic only. AIS feeds
# pick up enormous amounts of coastal noise (fishing boats, pleasure craft,
# port tugs, sailing vessels, harbor ferries) which clutter the globe without
# being interesting for a supply-chain demo. 70-79 = cargo classes,
# 80-89 = tanker classes. Anything else gets filtered out at /api/vessels
# regardless of speed / destination quality.
COMMERCIAL_SHIP_TYPES = frozenset(range(70, 90))

# Geographic distribution grid lives in services/_geo.py (shared with planes).
# 6 lng × 3 lat = 18 cells, ~60° on a side. Round-robin pulls across buckets
# spread the emitted set across the globe instead of piling up in whatever
# region has the densest AIS coverage at the moment.

# Minimum angular separation between selected ships. Adds a second-layer
# spread guarantee on top of the grid round-robin — even within a single
# bucket, ships closer than this are dropped. Prevents multiple vessels in
# the same corridor (e.g., the South China Sea, the English Channel) from
# rendering as overlapping markers at globe zoom. Lat/lng degrees (~4°
# ≈ 440 km at the equator), not great-circle distance, since we don't need
# precision for spread filtering.
MIN_SHIP_DEG_APART = 4.0


# UN/LOCODE → friendly port name lookup. Loaded once at module import from
# data/ports.json. Used to resolve raw AIS destination codes (e.g. "GIGIB"
# → "Gibraltar", "CNSHA" → "Shanghai") to readable city names before the
# value reaches the frontend.
def _load_port_names() -> dict[str, str]:
    try:
        raw = json.loads((DATA / "ports.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    table: dict[str, str] = {}
    for code, info in raw.items():
        if code.startswith("_") or not isinstance(info, dict):
            continue  # skip _comment / metadata fields
        name = info.get("name")
        if isinstance(name, str) and name:
            table[code.strip().upper()] = name
    return table


PORT_NAMES: dict[str, str] = _load_port_names()


# Regex to split AIS destinations on common separators. Captures the separators
# so we can re-emit them normalized. Handles ">", "→", "/", "-", ",", and the
# AIS-common pipe "|". Real captain-typed values are dirty: "FRLEH=", "Le Havre
# → → → SGSIN PWBGA", "DEHAM>NLRTM", "X / Y", "ROTTERDAM,ANTWERP" etc.
_PORT_SEPARATOR = re.compile(r"(\s*[>→/,\-|]\s*)")
# Junk characters captains stick after a code (=, ., :, !, ?) — we strip
# anything that isn't alphanumeric or whitespace from each token's tail before
# the UN/LOCODE lookup.
_TRAILING_JUNK = re.compile(r"[^A-Za-z0-9\s]+$")
_LEADING_JUNK  = re.compile(r"^[^A-Za-z0-9\s]+")


def _resolve_token(token: str) -> str:
    """Resolve a single destination token to a friendly name where possible.

    Strips trailing/leading junk, then tries the whole token as a UN/LOCODE.
    If that fails AND the token contains whitespace, splits on whitespace and
    resolves each sub-token independently — handles forms like "SGSIN PWBGA"
    where the captain ran two codes together without a separator. Unknown
    tokens pass through with their original case preserved.
    """
    cleaned = _LEADING_JUNK.sub("", _TRAILING_JUNK.sub("", token)).strip()
    if not cleaned:
        return ""

    # Whole-token UN/LOCODE lookup (most common case)
    resolved = PORT_NAMES.get(cleaned.upper())
    if resolved:
        return resolved

    # Multi-word fallback: split on whitespace, try each sub-token. If at
    # least one resolves, emit a "Name → Name" string. Otherwise return the
    # cleaned original — better to show "SGSIN PWBGA" than blank.
    if " " in cleaned:
        sub_resolved: list[str] = []
        any_hit = False
        for sub in cleaned.split():
            sub_clean = _TRAILING_JUNK.sub("", sub).strip()
            if not sub_clean:
                continue
            sub_hit = PORT_NAMES.get(sub_clean.upper())
            if sub_hit:
                sub_resolved.append(sub_hit)
                any_hit = True
            else:
                sub_resolved.append(sub_clean)
        if any_hit:
            return " → ".join(sub_resolved)

    return cleaned


def _resolve_destination(raw: str) -> str:
    """Resolve UN/LOCODE codes in an AIS destination string to friendly names.

    Single codes: "GIGIB" → "Gibraltar".
    Compound: "GIGIB > ESALG" → "Gibraltar → Algeciras".
    Dirty real-world inputs are normalized:
      "FRLEH= → Antwerp"             → "Le Havre → Antwerp"
      "Le Havre → → → SGSIN PWBGA"   → "Le Havre → Singapore → Palau Bagan"  (best effort)
      "DEHAM,NLRTM"                  → "Hamburg → Rotterdam"
    Unknown codes pass through cleaned so we don't drop information.
    Consecutive arrows collapse — empty parts between separators are skipped.
    """
    if not raw:
        return raw
    parts = _PORT_SEPARATOR.split(raw)
    resolved_parts: list[str] = []
    last_was_separator = False
    for part in parts:
        if _PORT_SEPARATOR.match(part):
            # Skip if we'd be emitting consecutive separators OR if the
            # separator comes at the very start (nothing to separate yet).
            if last_was_separator or not resolved_parts:
                continue
            resolved_parts.append(" → ")
            last_was_separator = True
            continue
        token = _resolve_token(part)
        if not token:
            continue
        # Drop trailing separator if this token is empty after resolving
        if resolved_parts and resolved_parts[-1] == " → " and not token:
            resolved_parts.pop()
            last_was_separator = False
            continue
        resolved_parts.append(token)
        last_was_separator = False

    # Strip trailing separator (e.g. "FRLEH > " with empty second token)
    if resolved_parts and resolved_parts[-1] == " → ":
        resolved_parts.pop()
    return "".join(resolved_parts).strip()


state: dict = {}


def _ship_type_to_cargo(t: int) -> str:
    """Mirror of frontend services/shipsClient.ts:shipTypeToCargoLabel."""
    if 70 <= t <= 79: return "Cargo"
    if 80 <= t <= 89: return "Tanker"
    if 60 <= t <= 69: return "Passenger"
    if 40 <= t <= 49: return "High Speed Craft"
    if t == 30: return "Fishing"
    if t in (31, 32): return "Towing"
    if t == 33: return "Dredging"
    if t == 35: return "Military"
    if t == 36: return "Sailing"
    if t == 37: return "Pleasure Craft"
    if t == 50: return "Pilot Vessel"
    if t == 51: return "Search & Rescue"
    if t == 52: return "Tug"
    if t == 55: return "Law Enforcement"
    if 90 <= t <= 99: return "Other"
    return "Unknown"


def _ais_status(navstatus: Optional[int]) -> str:
    if navstatus in (1, 5, 6):
        return "stopped"
    return "moving"


def _qualified_count() -> int:
    """How many vessel rows pass the same quality filter /api/vessels uses.

    Mirrors the /api/vessels pipeline including the commercial-type filter so
    the boot-overlay "vessels" count reflects what will actually be rendered.
    """
    try:
        rows = fetch_all_vessels()
    except Exception:
        return 0
    count = 0
    for row in rows:
        try:
            lat = float(row["lat"]); lng = float(row["lng"])
        except (TypeError, ValueError):
            continue
        if abs(lat) > 90 or abs(lng) > 180 or (lat == 0 and lng == 0):
            continue
        ns = row.get("nav_status")
        if isinstance(ns, int) and ns in PORT_NAV_STATUSES:
            continue
        sog = row.get("sog") or 0.0
        if sog * KNOTS_TO_KMH < MIN_UNDERWAY_KMH:
            continue
        if not (row.get("destination") or "").strip():
            continue
        if not (row.get("call_sign") or "").strip():
            continue
        ship_type = int(row.get("ship_type") or 0)
        if ship_type not in COMMERCIAL_SHIP_TYPES:
            continue
        count += 1
        if count >= MAX_EMITTED:
            break
    return count


@asynccontextmanager
async def lifespan(_: FastAPI):
    get_pool()
    state["matcher"] = FleetMatcher()
    state["risk"] = PortRiskEngine()
    state["ingestor"] = AISIngestor()

    tasks = [
        asyncio.create_task(state["ingestor"].run_forever(), name="ingestor"),
        asyncio.create_task(state["risk"].run_forever(600), name="risk"),
    ]
    state["tasks"] = tasks
    try:
        yield
    finally:
        state["ingestor"].stop()
        for t in tasks:
            t.cancel()
        for t in tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass


app = FastAPI(title="Supply Chain Brain", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Root + health ────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def index() -> HTMLResponse:
    """Serve the standalone Mapbox demo at /. The cinematic Next.js UI lives
    on the Next dev server (port 3000) — this page is just a fallback for
    checking the FastAPI side is alive without spinning up the React app."""
    path = TEMPLATES / "index.html"
    try:
        return HTMLResponse(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"template read failed: {exc}")


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}


@app.get("/api/ports")
async def ports() -> JSONResponse:
    try:
        data = json.loads((DATA / "ports.json").read_text(encoding="utf-8"))
        return JSONResponse(data)
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ─── Vessels ──────────────────────────────────────────────────────────────────

@app.get("/api/vessels")
async def vessels() -> JSONResponse:
    """Return live ships shaped exactly like the frontend Ship type.

    Quality + selection pipeline:
      1. Coordinate sanity, not-at-port, underway speed, destination + call
         sign present (matches what the old TS service used to do client-side).
      2. Ship type must be cargo (70-79) or tanker (80-89). Excludes fishing,
         pleasure craft, sailing, ferries, etc. — the coastal clutter that
         dominates raw AIS feeds.
      3. Geographic round-robin: each qualifying ship is filed into a 6×3 grid
         bucket. We pull ships bucket-by-bucket in round-robin passes, always
         taking matched-operator vessels before unmatched ones within a given
         bucket. This forces global spread instead of letting one dense
         region (Mediterranean, North Sea) fill the entire cap.

    Result: ~MAX_EMITTED commercial vessels biased toward known operators
    AND geographically distributed across the globe.
    """
    matcher: FleetMatcher = state.get("matcher") or FleetMatcher()
    try:
        rows = fetch_all_vessels()
        alerts = fetch_all_alerts()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"data fetch failed: {exc}")

    name_to_alert = {a["port_name"].upper(): a for a in alerts.values()}

    # buckets[bucket_idx] = list[(is_matched: bool, ship_dict)] — sorted so
    # matched ships sit at the head and the round-robin below pops them first.
    buckets: dict[int, list[tuple[bool, dict]]] = {}

    for row in rows:
        try:
            lat = float(row["lat"]); lng = float(row["lng"])
        except (TypeError, ValueError):
            continue
        if abs(lat) > 90 or abs(lng) > 180 or (lat == 0 and lng == 0):
            continue

        nav_status = row.get("nav_status")
        if isinstance(nav_status, int) and nav_status in PORT_NAV_STATUSES:
            continue

        sog_knots = row.get("sog") or 0.0
        speed_kmh = sog_knots * KNOTS_TO_KMH
        if speed_kmh < MIN_UNDERWAY_KMH:
            continue

        destination = (row.get("destination") or "").strip()
        call_sign   = (row.get("call_sign")   or "").strip()
        if not destination or not call_sign:
            continue

        # Commercial-only filter. Drops fishing (30), sailing (36), pleasure
        # craft (37), passenger (60-69), and everything else outside the
        # cargo/tanker range. This is what makes coastal clusters disappear.
        ship_type = int(row.get("ship_type") or 0)
        if ship_type not in COMMERCIAL_SHIP_TYPES:
            continue

        mmsi = row["mmsi"]
        vessel_name = (row.get("vessel_name") or "").strip() or f"Vessel {mmsi}"
        operator, _signature = matcher.match(vessel_name)

        true_heading = row.get("heading")
        cog = row.get("cog")
        heading = true_heading if (true_heading is not None and true_heading != 511) else (cog or 0.0)

        # Cross-reference destination text against port_alerts for risk.
        up = destination.upper()
        risk = "NONE"; incident = ""
        for code, alert in alerts.items():
            if code in up:
                risk = alert["risk_level"]
                incident = alert["incident"]
                break
        else:
            hit = name_to_alert.get(up)
            if hit:
                risk = hit["risk_level"]
                incident = hit["incident"]

        # Resolve UN/LOCODE codes in the destination string to readable names
        # for display. Risk matching above used the raw form so port codes
        # still flag against the alerts table.
        destination_display = _resolve_destination(destination)

        ship = {
            "id":             f"ship-live-{mmsi}",
            "name":           vessel_name,
            "type":           "ship",
            "latitude":       lat,
            "longitude":      lng,
            "heading":        heading,
            "status":         _ais_status(nav_status),
            "cargo":          _ship_type_to_cargo(ship_type),
            "lastUpdated":    row.get("last_updated") or datetime.now(timezone.utc).isoformat(),
            "route":          [],
            "destination":    [lng, lat],
            "currentSpeed":   speed_kmh,
            "dataSource":     "live",
            "company":        operator if operator != "Unknown Operator" else None,
            "destinationPort": destination_display,
            "callSign":       call_sign,
            "imoNumber":      row.get("imo"),
            "draught":        row.get("draught"),
            "vesselLength":   row.get("length"),
            "destinationRisk":     risk,
            "destinationIncident": incident,
        }

        is_matched = operator != "Unknown Operator"
        bucket_idx = _grid_bucket(lng, lat)
        buckets.setdefault(bucket_idx, []).append((is_matched, ship))

    # Within each bucket, sort matched ships to the front so they're popped
    # first during the round-robin below. Stable sort preserves AIS-arrival
    # order among ships of the same matched/unmatched class.
    for cell in buckets.values():
        cell.sort(key=lambda pair: not pair[0])

    # Round-robin pull across buckets, with a minimum-distance filter layered
    # on top. On each pass we try to take ONE ship from every non-empty bucket
    # — but if the candidate is too close to any already-accepted ship, we
    # drop it and try the next one in the same bucket. Empties drop out.
    # Repeats until MAX_EMITTED is reached or all buckets are exhausted.
    #
    # The grid round-robin guarantees regional spread (Mediterranean / Pacific
    # / etc. each get representation). The min-distance filter then prevents
    # multiple ships in the same corridor from overlapping at globe zoom.
    ships: list[dict] = []
    accepted_coords: list[tuple[float, float]] = []
    while len(ships) < MAX_EMITTED:
        progressed = False
        for cell in buckets.values():
            # Within a cell, pop candidates until one passes the distance
            # check (or the cell is empty). Rejected candidates are discarded
            # — they're too crowded to land.
            while cell:
                _, candidate = cell.pop(0)
                lat = candidate["latitude"]
                lng = candidate["longitude"]
                if _too_close(lat, lng, accepted_coords, MIN_SHIP_DEG_APART):
                    continue
                ships.append(candidate)
                accepted_coords.append((lat, lng))
                progressed = True
                break
            if len(ships) >= MAX_EMITTED:
                break
        if not progressed:
            break

    return JSONResponse(ships)


@app.get("/api/vessels.geojson")
async def vessels_geojson() -> JSONResponse:
    """GeoJSON projection of /api/vessels for the standalone templates/index.html demo."""
    body = await vessels()
    raw = json.loads(body.body)
    feats = [
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [s["longitude"], s["latitude"]]},
            "properties": {
                "mmsi": s["id"].replace("ship-live-", ""),
                "vessel_name": s["name"],
                "operator": s.get("company") or "Unknown Operator",
                "cargo_label": s["cargo"],
                "destination": s["destinationPort"],
                "destination_risk": s["destinationRisk"],
                "destination_incident": s["destinationIncident"],
                "last_updated": s["lastUpdated"],
            },
        }
        for s in raw
    ]
    return JSONResponse({"type": "FeatureCollection", "features": feats})


@app.get("/api/ingestor/status")
async def ingestor_status() -> dict:
    """Lightweight status payload the frontend SystemStrip + BootOverlay read."""
    ing: Optional[AISIngestor] = state.get("ingestor")
    if ing is None:
        return {"state": "connecting", "msgCount": 0, "vesselCount": 0}
    return {
        "state":       ing.state,
        "msgCount":    ing.msg_count,
        "vesselCount": _qualified_count(),
        "lastMessage": ing.last_message,
    }


# ─── Planes ───────────────────────────────────────────────────────────────────

@app.get("/api/planes")
async def planes() -> JSONResponse:
    """Aviation Edge → Plane[] shaped to match the frontend Plane type."""
    try:
        result = await fetch_live_planes()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"aviation edge failed: {exc}")
    return JSONResponse(result)


# ─── Routing ──────────────────────────────────────────────────────────────────

@app.get("/api/route")
async def route(
    o: str = Query(..., description="origin as 'lng,lat'"),
    d: str = Query(..., description="destination as 'lng,lat'"),
) -> JSONResponse:
    """HERE routing proxy with on-disk cache.

    Cache flow (see services/route_cache.py):
      1. Cache hit -> return immediately, no HERE call. Free + offline-safe.
      2. Cache miss -> fetch HERE, store result, return it.
      3. HERE failure with no cached fallback -> 502 to caller.
      4. HERE failure WITH a previously-cached entry: handled implicitly by (1).

    The cache is keyed by 4dp-rounded coords so the 50 Petros truck pairs
    (which are static between runs) cache exactly once each then serve
    instantly forever.
    """
    try:
        o_lng, o_lat = (float(x) for x in o.split(","))
        d_lng, d_lat = (float(x) for x in d.split(","))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="o and d must be 'lng,lat'")

    origin = (o_lng, o_lat)
    destination = (d_lng, d_lat)

    # 1. Cache hit?
    cached = cached_route_get(origin, destination)
    if cached is not None:
        return JSONResponse({"route": cached, "source": "cache"})

    # 2. Fetch from HERE
    try:
        points = await fetch_truck_route(origin, destination)
    except Exception as exc:
        # HERE failed AND we have nothing cached — surface the failure so the
        # frontend's retry logic can kick in. Once HERE recovers and one
        # successful response lands, all subsequent reloads serve from cache.
        raise HTTPException(status_code=502, detail=f"routing failed: {exc}")

    # 3. Persist for next time (async, returns once written)
    await cached_route_put(origin, destination, points)
    return JSONResponse({"route": points, "source": "here"})


# ─── Reroute Optimization (NVIDIA NIM) ────────────────────────────────────────

@app.post("/api/reroute")
async def reroute(body: dict = Body(...)) -> JSONResponse:
    """Compute an optimized reroute around a hazard zone.
    
    Request body:
    {
        "vehicleName": "PT Freighter 03",
        "origin": [lat, lng],
        "destination": [lat, lng],
        "hazard": {
            "lat": 35.0,
            "lng": -100.0,
            "radiusKm": 150,
            "reason": "weather" | "geopolitical" | "traffic",
            "description": "Severe thunderstorm with tornado warning"
        }
    }
    
    Returns:
    {
        "success": true,
        "originalRoute": [...],
        "newRoute": [...],
        "originalDistanceKm": 1520.3,
        "newDistanceKm": 1680.1,
        "originalTimeHrs": 19.0,
        "newTimeHrs": 21.0,
        "delayHrs": 2.0,
        "hazard": {...},
        "explanation": "AI-generated explanation...",
        "aiPowered": true
    }
    """
    try:
        vehicle_name = body.get("vehicleName", "Unknown Vehicle")
        origin = body["origin"]  # [lat, lng]
        destination = body["destination"]  # [lat, lng]
        hazard_data = body["hazard"]
    except (KeyError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=f"missing required field: {exc}")

    hazard = HazardZone(
        lat=float(hazard_data["lat"]),
        lng=float(hazard_data["lng"]),
        radius_km=float(hazard_data.get("radiusKm", 100)),
        reason=hazard_data.get("reason", "weather"),
        description=hazard_data.get("description", "Hazard detected"),
    )

    try:
        result = await compute_reroute(
            vehicle_name=vehicle_name,
            origin=(float(origin[0]), float(origin[1])),
            destination=(float(destination[0]), float(destination[1])),
            hazard=hazard,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"reroute computation failed: {exc}")

    return JSONResponse({
        "success": result.success,
        "originalRoute": result.original_route,
        "newRoute": result.new_route,
        "originalDistanceKm": round(result.original_distance_km, 1),
        "newDistanceKm": round(result.new_distance_km, 1),
        "originalTimeHrs": round(result.original_time_hrs, 2),
        "newTimeHrs": round(result.new_time_hrs, 2),
        "delayHrs": round(result.delay_hrs, 2),
        "hazard": result.hazard,
        "explanation": result.explanation,
        "aiPowered": result.ai_powered,
    })


# ─── Weather ──────────────────────────────────────────────────────────────────

class WeatherRequest(BaseModel):
    locations: list[list[float]]


@app.post("/api/weather")
async def weather(request_body: WeatherRequest) -> JSONResponse:
    """Fetch current weather for multiple locations from Open-Meteo.

    Request body should contain:
    {
        "locations": [[lat, lon], [lat, lon], ...]
    }

    Returns weather conditions and risk zones for each location.
    """
    print(f"[weather] received request: {request_body}", flush=True)
    print(f"[weather] request_body.locations: {request_body.locations}", flush=True)

    try:
        locations = request_body.locations
        print(f"[weather] locations extracted: {locations}", flush=True)

        if not locations:
            print(f"[weather] ERROR: locations array is empty or missing", flush=True)
            raise ValueError("locations array is required")

        # Validate location format
        for i, loc in enumerate(locations):
            print(f"[weather] location {i}: {loc} (type: {type(loc)}, len: {len(loc) if isinstance(loc, (list, tuple)) else 'N/A'})", flush=True)
            if not isinstance(loc, (list, tuple)) or len(loc) < 2:
                raise ValueError(f"location {i} must be [lat, lon], got {loc}")

        # Convert to list of tuples (lat, lon)
        location_tuples = [(loc[0], loc[1]) for loc in locations]
        print(f"[weather] location_tuples: {location_tuples}", flush=True)

        result = await fetch_weather_for_locations(location_tuples)
        print(f"[weather] fetch_weather_for_locations returned successfully", flush=True)
    except ValueError as exc:
        print(f"[weather] ValueError: {exc}", flush=True)
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        print(f"[weather] Exception: {type(exc).__name__}: {exc}", flush=True)
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=502, detail=f"weather fetch failed: {exc}")

    return JSONResponse(result)


# ─── Fleet seed data (Petros Transport) ───────────────────────────────────────

@app.get("/api/fleet/petros")
async def fleet_petros() -> JSONResponse:
    """Static Petros Transport fleet (the demo dataset). Loaded from JSON so
    it can be hand-edited Python-side without touching TypeScript.

    Side effect on the way out: every ship gets its `route` field populated
    with a maritime polyline routed through the correct chokepoints (Suez,
    Hormuz, Malacca, Panama, Bosphorus, Cape, etc.). Truck routes still come
    from the HERE Routing proxy elsewhere; planes are point-to-point for now.
    """
    path = DATA / "petros_fleet.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail=f"fleet read failed: {exc}")

    # Attach ship routes via the searoute library (Python port of the
    # eurostat tool — real shipping-lane network, Dijkstra'd routes, correct
    # antimeridian handling, all canonical chokepoints). Results are cached
    # per (origin, dest) so this only does real work on the first request.
    # Failures isolate per ship so one bad coordinate doesn't kill the
    # whole endpoint.
    #
    # After a route lands we also OVERRIDE the JSON heading using the
    # bearing to the first non-trivial point along the route. Hand-set
    # JSON headings frequently disagreed with the route direction —
    # visually ships looked like they were starting their journey with a
    # U-turn. Deriving from route geometry is the source of truth.
    for ship in data.get("ships", []):
        ship_id = ship.get("id", "")
        try:
            # Route runs from ORIGIN PORT to DESTINATION PORT — not from the
            # ship's current position. The ship sits somewhere along that
            # route, so the frontend can split the line into a darker
            # already-travelled segment (origin -> current pos) and a
            # brighter remaining segment (current pos -> destination).
            #
            # If originPort isn't a known port name we fall back to the
            # ship's current position; the route will still render, just
            # without a meaningful travelled segment.
            origin_pt = coords_for_port(ship.get("originPort"))
            current_pos = (float(ship["longitude"]), float(ship["latitude"]))
            origin = origin_pt or current_pos
            destination = (float(ship["destination"][0]), float(ship["destination"][1]))
            ship["route"] = build_ship_route(origin, destination)

            # Heading is derived from the ship's CURRENT position along the
            # route, not the route origin — otherwise a ship sitting in the
            # middle of the Pacific would be pointed back at the origin port.
            derived = heading_for_route(current_pos, ship["route"])
            if derived is not None:
                ship["heading"] = derived

            # Anchor distanceTravelled so the frontend simulator's moveVehicle
            # starts each ship at its persisted position along the route. Without
            # this, distanceTravelled is 0 and moveVehicle snaps every ship to
            # route[0] (the origin PORT) on every 50ms tick — that's why every
            # ship visually appeared parked at its starting port even though the
            # JSON snapshot had it mid-route.
            ship["distanceTravelled"] = distance_travelled_for_position(current_pos, ship["route"])

            # Generate the cargo manifest based on the ship's vesselSubType.
            # Deterministic per ship id so it stays stable across reloads.
            # Container/reefer ships get many B/Ls of mixed commodities;
            # tankers/bulkers get 1-2 large single-commodity shipments; RoRo
            # gets vehicle counts; breakbulk gets heterogeneous palletized.
            manifest = build_manifest_for_ship(ship)
            if manifest:
                ship["manifest"] = manifest
        except (KeyError, TypeError, ValueError, IndexError) as exc:
            print(f"[fleet] sea-route failed for {ship_id}: {exc}", flush=True)
            ship["route"] = []

    # Attach plane routes via great-circle interpolation from departure
    # airport (IATA code -> coords) to arrival airport. Same pattern as ships:
    # full route polyline + heading derived from current position + anchored
    # distanceTravelled so the frontend simulator picks up partway through
    # the flight instead of resetting to the departure airport every tick.
    #
    # Variable speedLimit baked into each route point models the climb/cruise/
    # descent flight phases — so a plane near takeoff or landing visibly
    # decelerates instead of cruising at 900 km/h all the way to touchdown.
    for plane in data.get("planes", []):
        plane_id = plane.get("id", "")
        try:
            origin_pt = coords_for_airport(plane.get("departureAirport"))
            current_pos = (float(plane["longitude"]), float(plane["latitude"]))
            origin = origin_pt or current_pos
            destination = (float(plane["destination"][0]), float(plane["destination"][1]))
            plane["route"] = build_air_route(origin, destination)

            derived = heading_for_air_route(current_pos, plane["route"])
            if derived is not None:
                plane["heading"] = derived

            plane["distanceTravelled"] = distance_travelled_for_air_position(
                current_pos, plane["route"]
            )

            # Air Waybill manifest — IATA shape (Master + House AWBs, pieces,
            # chargeable weight, ULDs, IATA DGR + SHC). Deterministic per id.
            air_manifest = build_plane_manifest_for_plane(plane)
            if air_manifest:
                plane["manifest"] = air_manifest
        except (KeyError, TypeError, ValueError, IndexError) as exc:
            print(f"[fleet] air-route failed for {plane_id}: {exc}", flush=True)
            plane["route"] = []

    # Truck CMR consignment manifests. Trucks already have routes loaded
    # client-side via the HERE proxy, so we don't need any route enrichment
    # here — just attach the manifest.
    for truck in data.get("trucks", []):
        try:
            cmr_manifest = build_truck_manifest_for_truck(truck)
            if cmr_manifest:
                truck["manifest"] = cmr_manifest
        except Exception as exc:
            print(f"[fleet] truck manifest failed for {truck.get('id')}: {exc}", flush=True)

    return JSONResponse(data)


@app.get("/api/fleet/petros/{vehicle_id}/manifest.xlsx")
async def fleet_petros_manifest_xlsx(vehicle_id: str):
    """Generate + stream the cargo manifest as a styled Excel workbook.

    Picks the right builder per vehicle type (ship -> Cargo Manifest;
    truck -> CMR; plane -> Air Waybill). Manifest is freshly generated
    from the seeded RNG so the workbook always matches what the sidebar
    is showing for that vehicle id.
    """
    path = DATA / "petros_fleet.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail=f"fleet read failed: {exc}")

    vehicle: dict | None = None
    for group in ("ships", "trucks", "planes"):
        for v in data.get(group, []):
            if v.get("id") == vehicle_id:
                vehicle = v
                break
        if vehicle:
            break
    if not vehicle:
        raise HTTPException(status_code=404, detail=f"vehicle {vehicle_id} not found")

    # Generate manifest fresh — same deterministic seed as the JSON endpoint,
    # so the workbook is in sync with whatever the sidebar shows.
    if vehicle["type"] == "ship":
        vehicle["manifest"] = build_manifest_for_ship(vehicle)
    elif vehicle["type"] == "truck":
        vehicle["manifest"] = build_truck_manifest_for_truck(vehicle)
    elif vehicle["type"] == "plane":
        vehicle["manifest"] = build_plane_manifest_for_plane(vehicle)

    if not vehicle.get("manifest"):
        raise HTTPException(status_code=404, detail=f"no manifest for vehicle type {vehicle['type']!r}")

    try:
        blob = build_manifest_xlsx_for_vehicle(vehicle)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"xlsx build failed: {exc}")

    filename = f"{vehicle_id}_manifest.xlsx"
    return Response(
        content=blob,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


# ─── AI chat ──────────────────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    # Per-request snapshot from the frontend (dataMode, activeScenario,
    # fleet summary, disruptions). Free-form dict so the frontend can evolve
    # what it sends without breaking the backend contract. nim_chat.py
    # JSON-serializes it into the system prompt verbatim.
    context: Optional[dict] = None


@app.post("/api/ai/chat")
async def ai_chat(request_body: ChatRequest) -> JSONResponse:
    """Proxy a chat completion to NVIDIA NIM (Nemotron 3 Super 120B).

    The frontend assembles `context` from useVehicleStore and passes it on
    every turn — the model is otherwise stateless, so the snapshot has to
    travel with each request. `messages` is the conversation history (user/
    assistant turns only; the system prompt is added by nim_chat).
    """
    messages = [m.model_dump() for m in request_body.messages]
    try:
        result = await nim_chat(messages=messages, context=request_body.context)
    except RuntimeError as exc:
        # Missing API key or empty upstream response — caller error / config.
        print(f"[chat] RuntimeError: {exc}", flush=True)
        raise HTTPException(status_code=500, detail=str(exc))
    except httpx.HTTPStatusError as exc:
        body = exc.response.text[:500] if exc.response is not None else ""
        print(f"[chat] upstream {exc.response.status_code}: {body}", flush=True)
        raise HTTPException(
            status_code=502,
            detail=f"NVIDIA Endpoints returned {exc.response.status_code}: {body}",
        )
    except httpx.ReadTimeout:
        print("[chat] upstream timeout", flush=True)
        raise HTTPException(
            status_code=504,
            detail="chat failed: upstream timeout — try again, or simplify the question",
        )
    except Exception as exc:
        # Surface the exception TYPE so future empty-message failures are
        # still debuggable from the frontend error toast.
        exc_repr = f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__
        print(f"[chat] {exc_repr}", flush=True)
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=502, detail=f"chat failed: {exc_repr}")

    return JSONResponse(result)


# Optional: expose /static if assets ever appear there.
_static_dir = ROOT / "static"
if _static_dir.is_dir():
    app.mount("/static", StaticFiles(directory=_static_dir), name="static")

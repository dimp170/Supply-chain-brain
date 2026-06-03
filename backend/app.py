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
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from services._geo import grid_bucket as _grid_bucket, too_close as _too_close
from services.database import fetch_all_alerts, fetch_all_vessels, get_pool
from services.fleet_matcher import FleetMatcher
from services.ingestor import AISIngestor
from services.planes import fetch_live_planes
from services.risk_engine import PortRiskEngine
from services.routing import fetch_truck_route
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


# Regex to split AIS destinations on common separators while preserving them.
# Handles forms like "GIGIB > ESALG", "CNSHA>NLRTM", "LON-HAM", "X / Y".
_PORT_SEPARATOR = re.compile(r"(\s*[>→/\-]\s*)")


def _resolve_destination(raw: str) -> str:
    """Resolve UN/LOCODE codes in an AIS destination string to friendly names.

    Single codes: "GIGIB" → "Gibraltar".
    Compound: "GIGIB > ESALG" → "Gibraltar → Algeciras".
    Unknown codes pass through as-is so we don't drop information we couldn't
    resolve. Empty input passes through as empty.
    """
    if not raw:
        return raw
    parts = _PORT_SEPARATOR.split(raw)
    out: list[str] = []
    for part in parts:
        # If the part is a separator, normalize it to " → " for display.
        if _PORT_SEPARATOR.match(part):
            out.append(" → ")
            continue
        stripped = part.strip().upper()
        resolved = PORT_NAMES.get(stripped)
        out.append(resolved if resolved else part.strip())
    return "".join(out).strip()


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
    """HERE routing proxy. Returns enriched RoutePoint[] the frontend overlays."""
    try:
        o_lng, o_lat = (float(x) for x in o.split(","))
        d_lng, d_lat = (float(x) for x in d.split(","))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="o and d must be 'lng,lat'")

    try:
        points = await fetch_truck_route((o_lng, o_lat), (d_lng, d_lat))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"routing failed: {exc}")
    return JSONResponse({"route": points})


# ─── Weather ──────────────────────────────────────────────────────────────────

@app.post("/api/weather")
async def weather(request_body: dict) -> JSONResponse:
    """Fetch current weather for multiple locations from Open-Meteo.
    
    Request body should contain:
    {
        "locations": [[lat, lon], [lat, lon], ...]
    }
    
    Returns weather conditions and risk zones for each location.
    """
    try:
        locations = request_body.get("locations", [])
        if not locations:
            raise ValueError("locations array is required")
        
        # Convert to list of tuples (lat, lon)
        location_tuples = [(loc[0], loc[1]) for loc in locations]
        
        result = await fetch_weather_for_locations(location_tuples)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"weather fetch failed: {exc}")
    
    return JSONResponse(result)


# ─── Fleet seed data (Petros Transport) ───────────────────────────────────────

@app.get("/api/fleet/petros")
async def fleet_petros() -> JSONResponse:
    """Static Petros Transport fleet (the demo dataset). Loaded from JSON so
    it can be hand-edited Python-side without touching TypeScript."""
    path = DATA / "petros_fleet.json"
    try:
        return JSONResponse(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail=f"fleet read failed: {exc}")


# Optional: expose /static if assets ever appear there.
_static_dir = ROOT / "static"
if _static_dir.is_dir():
    app.mount("/static", StaticFiles(directory=_static_dir), name="static")

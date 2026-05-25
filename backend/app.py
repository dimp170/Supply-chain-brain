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
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from services.database import fetch_all_alerts, fetch_all_vessels, get_pool
from services.fleet_matcher import FleetMatcher
from services.ingestor import AISIngestor
from services.planes import fetch_live_planes
from services.risk_engine import PortRiskEngine
from services.routing import fetch_truck_route

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
    """How many vessel rows pass the same quality filter /api/vessels uses."""
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

    Quality criteria applied here (matches what the old TS service used to do
    client-side): destinationPort + callSign present, speed >= 5 km/h, not
    at-port (NavigationStatus 1/5/6). Capped to MAX_EMITTED so the cinematic
    globe doesn't get carpeted in markers.
    """
    matcher: FleetMatcher = state.get("matcher") or FleetMatcher()
    try:
        rows = fetch_all_vessels()
        alerts = fetch_all_alerts()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"data fetch failed: {exc}")

    name_to_alert = {a["port_name"].upper(): a for a in alerts.values()}
    ships: list[dict] = []

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

        mmsi = row["mmsi"]
        vessel_name = (row.get("vessel_name") or "").strip() or f"Vessel {mmsi}"
        ship_type   = int(row.get("ship_type") or 0)
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

        ships.append({
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
            "destinationPort": destination,
            "callSign":       call_sign,
            "imoNumber":      row.get("imo"),
            "draught":        row.get("draught"),
            "vesselLength":   row.get("length"),
            "destinationRisk":     risk,
            "destinationIncident": incident,
        })

        if len(ships) >= MAX_EMITTED:
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

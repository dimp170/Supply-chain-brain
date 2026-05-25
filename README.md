# Supply Chain Brain

A logistics control tower built around a Mapbox 3D globe. Live AIS ships,
Aviation Edge planes, HERE-routed trucks, and the Petros Transport demo fleet
— with port-risk alerts scraped from maritime RSS feeds.

The app is two processes joined at a single `npm run dev`:

- **Next.js 16 / React 19 frontend** at the repo root (`app/`, `components/`,
  `stores/`, `services/`, `lib/`, `types/`). Owns the cinematic boot sequence,
  the Mapbox globe, and the fleet sidebar.
- **FastAPI + SQLite backend** under `backend/`. Holds the persistent AIS
  WebSocket, scrapes RSS for port risk, proxies HERE Routing and Aviation
  Edge, and serves the Petros fleet seed data.

The frontend never talks to AISStream / HERE / Aviation Edge directly; it hits
the FastAPI app, which keeps one subscription open per process.

## Repo layout

```
Supply-chain-brain/
├── app/                       ← Next.js routes (page.tsx, layout.tsx, globals.css)
├── components/                ← React UI (map, boot overlay, sidebar, shell)
├── stores/                    ← Zustand store (vehicleStore.ts)
├── services/                  ← Thin HTTP clients to the FastAPI backend
│   ├── shipsClient.ts            ShipPoller — polls /api/vessels every 5s
│   ├── planesClient.ts           fetchLivePlanes() → /api/planes
│   ├── routingClient.ts          fetchTruckRoute() → /api/route
│   ├── petrosFleet.ts            fetchPetrosFleet() → /api/fleet/petros
│   └── telemetrySimulator.ts     local mock-truck movement tick
├── lib/                       ← apiClient.ts (NEXT_PUBLIC_API_BASE wrapper)
├── types/                     ← Vehicle, RoutePoint
├── backend/                   ← Python / FastAPI
│   ├── app.py                    All endpoints + lifespan
│   ├── requirements.txt
│   ├── templates/index.html      Backend sanity-check page at :8000
│   └── services/
│       ├── database.py           SQLite pool + upserts (vessel_cache, port_alerts)
│       ├── ingestor.py           AISStream WebSocket → SQLite
│       ├── planes.py             Aviation Edge proxy
│       ├── routing.py            HERE Routing + flexpolyline decode
│       ├── risk_engine.py        RSS scraper → port_alerts
│       └── fleet_matcher.py      Regex: vessel name → operator
├── data/                      ← Shared seed data + SQLite db (both stacks read)
│   ├── ports.json                25 UN/LOCODE ports
│   ├── mappings.json             cargo types + shipping-line regex
│   ├── petros_fleet.json         21 trucks · 25 ships · 25 planes
│   └── tracking.db               created on first backend boot
├── package.json
├── tsconfig.json
└── .env.local
```

## First-time setup

**macOS / Linux:**

```bash
npm install
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
```

**Windows (PowerShell):**

```powershell
npm install
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r backend\requirements.txt
```

> If `py` isn't recognised, install Python 3.12 from
> <https://www.python.org/downloads/windows/> (check "Add Python to PATH").
> Avoid the Microsoft Store build — its pip sandbox causes issues.
>
> If `Activate.ps1` errors with an execution-policy message, run once:
> `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`

`.env.local` (already in `.gitignore`):

```
NEXT_PUBLIC_MAPBOX_TOKEN=...
NEXT_PUBLIC_HERE_API_KEY=...
NEXT_PUBLIC_AISSTREAM_API_KEY=...
AVIATION_EDGE_API_KEY=...
DATALASTIC_API_KEY=...
NEXT_PUBLIC_API_BASE=http://localhost:8000

# Backend mirrors — Python doesn't see NEXT_PUBLIC_ vars
AISSTREAM_API_KEY=...
HERE_API_KEY=...
```

## Run

```bash
npm run dev
```

Boots both processes in one terminal:

```
[next] ✓ Ready on http://localhost:3000
[api]  INFO:     Uvicorn running on http://127.0.0.1:8000
[api]  [ingestor] connected to aisstream.io
```

Open <http://localhost:3000> for the cinematic UI. <http://localhost:8000>
serves a stripped-down standalone Mapbox demo as a backend sanity check.

To run them separately:

```bash
npm run dev:next     # just Next.js (:3000)
npm run dev:api      # just FastAPI (:8000)
```

## What lives where

| Concern              | Frontend                   | Backend                                  |
| -------------------- | -------------------------- | ---------------------------------------- |
| 3D globe + boot      | `components/map/`, `boot/` | —                                        |
| Vehicle store        | `stores/vehicleStore.ts`   | —                                        |
| Live ships (AIS)     | `services/shipsClient.ts`  | `backend/services/ingestor.py` + SQLite  |
| Live planes          | `services/planesClient.ts` | `backend/services/planes.py`             |
| Truck routes         | `services/routingClient.ts`| `backend/services/routing.py`            |
| Petros demo fleet    | `services/petrosFleet.ts`  | `data/petros_fleet.json`                 |
| Port risk alerts     | —                          | `backend/services/risk_engine.py`        |

SQLite lives at `data/tracking.db` and is created on first backend boot.

## API surface

The FastAPI backend exposes:

- `GET /api/health` — `{ "status": "ok" }`
- `GET /api/vessels` — Live ships, shaped as the frontend `Ship` type
- `GET /api/vessels.geojson` — Same data as a GeoJSON FeatureCollection (used by the standalone demo at `/`)
- `GET /api/ingestor/status` — AISStatus payload the SystemStrip + BootOverlay read
- `GET /api/planes` — Live airborne flights from Aviation Edge
- `GET /api/route?o=lng,lat&d=lng,lat` — HERE truck route + decoded polyline + cumulative distance
- `GET /api/fleet/petros` — Petros Transport demo fleet seed
- `GET /api/ports` — UN/LOCODE port reference
- `GET /` — Standalone Mapbox 2D demo page (backend sanity check)

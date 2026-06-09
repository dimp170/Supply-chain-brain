"""On-demand SQLite snapshot of the live fleet, for AI tool calling.

The Supply Chain Brain runtime keeps vehicle state in a Zustand store on the
frontend and never durably persists it (positions update every 50 ms via the
truck simulator; durable storage would just thrash the disk). For most AI
queries that's fine — the JSON snapshot we already ship in the chat context
is enough for the model to reason about.

For spatial / temporal / filter-heavy queries ("trucks passing through Hamburg
in the next 2 hours", "ships within 200 km of Singapore", "5 vehicles with
the longest remaining ETA") in-prompt reasoning is unreliable. SQL handles
them cleanly and deterministically.

So: per AI tool-call, we materialize a fresh in-memory SQLite database from
the vehicles payload the frontend already sends in the context block. The
connection is ephemeral — opened, queried, discarded. There is no persistence,
no migration, no schema versioning. The shape of `vehicles` is dictated by
`services/aiClient.ts::compactVehicle`; keep both in sync if you add fields.

A custom `haversine_km(lat1, lng1, lat2, lng2)` SQL function is registered
on every connection so the AI can write distance queries without needing
PostGIS — useful for "near X" / "passing through Y" style filters.
"""
from __future__ import annotations

import math
import re
import sqlite3
from typing import Any

# Columns the snapshot exposes. Mirrors the compact vehicle shape from
# services/aiClient.ts. New fields go here AND in compact_vehicle. Order
# matters: it must match the INSERT below.
SCHEMA_COLUMNS = [
    ("id", "TEXT PRIMARY KEY"),
    ("name", "TEXT"),
    ("type", "TEXT"),           # truck | ship | plane
    ("company", "TEXT"),
    ("data_source", "TEXT"),    # live | mock
    ("status", "TEXT"),         # moving | delayed | stopped
    ("lat", "REAL"),
    ("lng", "REAL"),
    ("speed", "REAL"),          # km/h
    ("heading", "REAL"),        # degrees
    ("cargo", "TEXT"),
    ("dest_lng", "REAL"),
    ("dest_lat", "REAL"),
    ("remaining_km", "REAL"),
    ("remaining_min", "REAL"),
    ("temp", "REAL"),
    # Ship-specific
    ("dest_port", "TEXT"),
    ("call_sign", "TEXT"),
    ("imo", "INTEGER"),
    ("length_m", "REAL"),
    ("draught_m", "REAL"),
    ("dest_risk", "TEXT"),
    ("dest_incident", "TEXT"),
    # Plane-specific
    ("flight", "TEXT"),
    ("airline", "TEXT"),
    ("dep", "TEXT"),
    ("arr", "TEXT"),
    ("alt_m", "REAL"),
    # Disruption convenience flags. Booleans stored as INTEGER (0/1).
    ("has_disruption", "INTEGER"),
    ("disruption_count", "INTEGER"),
]

# Shipments table — flattened across ship/truck/plane manifests. One row
# per individual shipment (B/L, CMR, or AWB). Joined to vehicles via
# vehicle_id. New fields here AND in CompactShipment on the frontend.
SHIPMENT_COLUMNS = [
    ("vehicle_id",     "TEXT"),     # FK -> vehicles.id
    ("vehicle_type",   "TEXT"),     # 'ship' | 'truck' | 'plane'
    ("doc_id",         "TEXT"),     # B/L number (ship) / CMR number (truck) / HAWB (plane)
    ("customer_code",  "TEXT"),     # opaque shipper id (e.g. "SH-1234")
    ("commodity",      "TEXT"),     # human description of goods
    ("hs_code",        "TEXT"),     # 6-digit Harmonized System code
    ("country_origin", "TEXT"),     # ISO-2 country code
    ("gross_kg",       "REAL"),     # gross weight in kg
    ("volume_m3",      "REAL"),     # cubic meters
    ("value_usd",      "REAL"),     # declared value USD
    ("hazmat",         "INTEGER"),  # 0 / 1
    ("hazmat_class",   "TEXT"),     # IMDG / ADR / DGR class (e.g. '3', '6.1', '2.3')
    ("hazmat_un",      "TEXT"),     # UN number (e.g. 'UN1267')
    ("reefer",         "INTEGER"),  # 0 / 1 (refrigerated)
    ("temperature",    "REAL"),     # setpoint °C (nullable)
    ("unit_count",     "INTEGER"),  # containers (ship) / pallets (truck) / pieces (plane)
    ("unit_label",     "TEXT"),     # 'TEU' | 'pallet' | 'PCS'
    ("chargeable_kg",  "REAL"),     # planes only — what airlines bill on
    ("shc",            "TEXT"),     # planes only — IATA SHC codes joined by space
]


# Human-readable description of the schema for the AI's system prompt.
# Keep this aligned with SCHEMA_COLUMNS — the model uses this to write queries.
SCHEMA_DOC = """Table: vehicles  (one row per fleet vehicle)

  Common columns:
    id            TEXT     unique vehicle id (e.g. "pt-ship-10", "pt-truck-08")
    name          TEXT     human-readable name (e.g. "PT Suez Express")
    type          TEXT     'truck' | 'ship' | 'plane'
    company       TEXT     operator (Petros Transport for own fleet)
    data_source   TEXT     'mock' | 'live'
    status        TEXT     'moving' | 'delayed' | 'stopped'
    lat, lng      REAL     current position (degrees)
    speed         REAL     current speed in km/h
    heading       REAL     current heading in degrees
    cargo         TEXT     cargo description
    dest_lng,
    dest_lat      REAL     destination coordinates
    remaining_km  REAL     km left to destination (nullable)
    remaining_min REAL     minutes left to destination (nullable)
    temp          REAL     cargo temperature in C (nullable)
    has_disruption INTEGER 1 if vehicle has any active disruption, else 0
    disruption_count INTEGER number of active disruptions on this vehicle

  Ship-only columns (null for other types):
    dest_port     TEXT     destination port name
    call_sign     TEXT     AIS call sign
    imo           INTEGER  IMO number
    length_m      REAL     vessel length in metres
    draught_m     REAL     vessel draught in metres
    dest_risk     TEXT     'WARNING' | 'CRITICAL' if destination port is flagged
    dest_incident TEXT     incident description if destination port is flagged

  Plane-only columns (null for other types):
    flight        TEXT     flight number / callsign
    airline       TEXT     airline name
    dep, arr      TEXT     departure / arrival airport IATA codes
    alt_m         REAL     altitude in metres

Available SQL function:
    haversine_km(lat1, lng1, lat2, lng2) -> REAL
      Great-circle distance in kilometres between two coordinates. Use this
      for "within X km of Y" or "passing through Y" style queries.

Table: shipments  (one row per individual cargo shipment — B/L, CMR, or AWB)

  vehicle_id    TEXT    FK -> vehicles.id (always JOIN on this for spatial queries)
  vehicle_type  TEXT    'ship' | 'truck' | 'plane'  — duplicated from vehicles.type for fast filtering
  doc_id        TEXT    Bill of Lading (ship), CMR number (truck), House AWB (plane)
  customer_code TEXT    anonymised shipper id (e.g. 'SH-4731') — group shipments by customer
  commodity     TEXT    free-text goods description, e.g. 'Pharmaceuticals (cold chain)', 'Dubai Crude Oil'
  hs_code       TEXT    6-digit Harmonized System code, e.g. '270900' = crude oil, '850760' = lithium-ion batteries
  country_origin TEXT   ISO-2 country code, e.g. 'AE', 'CN', 'DE'
  gross_kg      REAL    gross weight in kilograms
  volume_m3     REAL    stowage volume in cubic metres
  value_usd     REAL    declared value in USD
  hazmat        INTEGER 1 if dangerous goods, else 0
  hazmat_class  TEXT    IMDG/ADR/DGR class string when hazmat=1, e.g. '3' (flammable liquid), '2.3' (toxic gas)
  hazmat_un     TEXT    UN dangerous-goods number when hazmat=1, e.g. 'UN1267' (crude oil), 'UN3480' (li-ion batteries)
  reefer        INTEGER 1 if refrigerated cargo, else 0
  temperature   REAL    setpoint °C for reefer shipments (nullable)
  unit_count    INTEGER unit count appropriate to mode: containers (ship), pallets (truck), pieces (plane)
  unit_label    TEXT    'TEU' (ship containers), 'pallet' (truck), 'PCS' (planes)
  chargeable_kg REAL    planes only — max(gross, volumetric) — what air carriers bill on
  shc           TEXT    planes only — IATA Special Handling Codes joined by space, e.g. 'DGR COL VAL'

Example JOIN queries:
    -- Total cargo value carried by ships transiting near Suez right now
    SELECT SUM(s.value_usd) AS total_at_risk_usd
    FROM shipments s
    JOIN vehicles v ON v.id = s.vehicle_id
    WHERE v.type = 'ship'
      AND haversine_km(v.lat, v.lng, 30.6, 32.3) < 800;

    -- Hazmat shipments within 500 km of typhoon centre (24.8N, 142.5E)
    SELECT v.name, s.commodity, s.hazmat_class, s.hazmat_un, s.value_usd
    FROM shipments s
    JOIN vehicles v ON v.id = s.vehicle_id
    WHERE s.hazmat = 1
      AND haversine_km(v.lat, v.lng, 24.8, 142.5) < 500;

    -- Total tonnes of grain (HS 1001 wheat / 1005 corn / 1201 soybeans) heading anywhere
    SELECT SUM(s.gross_kg) / 1000 AS total_tonnes
    FROM shipments s
    WHERE s.hs_code IN ('100199', '100590', '120190');
"""

# Patterns we reject outright. SELECT-only, no DDL/DML, no PRAGMA, no ATTACH.
# We also forbid semicolons after the first statement to block multi-statement
# injection. The model is on our side here — this is belt-and-braces.
_FORBIDDEN = re.compile(
    r"\b(insert|update|delete|drop|alter|create|replace|truncate|attach|detach|"
    r"pragma|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release)\b",
    re.IGNORECASE,
)


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in kilometres. Registered as a SQLite function."""
    try:
        lat1f, lng1f, lat2f, lng2f = float(lat1), float(lng1), float(lat2), float(lng2)
    except (TypeError, ValueError):
        return float("inf")
    R = 6371.0
    dlat = math.radians(lat2f - lat1f)
    dlng = math.radians(lng2f - lng1f)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1f)) * math.cos(math.radians(lat2f)) * math.sin(dlng / 2) ** 2
    )
    c = 2 * math.asin(math.sqrt(a))
    return R * c


def _row_from_vehicle(v: dict[str, Any]) -> tuple:
    """Project a compact-vehicle dict to a tuple in SCHEMA_COLUMNS order.

    The frontend ships `position: [lat, lng]` and `destination: [lng, lat]`
    (matching the Vehicle.destination convention used elsewhere). We unpack
    those into flat lat/lng/dest_lat/dest_lng columns so SQL queries can
    reference them naturally.
    """
    position = v.get("position") or [None, None]
    destination = v.get("destination") or [None, None]
    return (
        v.get("id"),
        v.get("name"),
        v.get("type"),
        v.get("company"),
        v.get("dataSource"),
        v.get("status"),
        position[0],
        position[1],
        v.get("speed"),
        v.get("heading"),
        v.get("cargo"),
        destination[0],  # dest_lng
        destination[1],  # dest_lat
        v.get("remainingKm"),
        v.get("remainingMin"),
        v.get("temp"),
        v.get("destPort"),
        v.get("callSign"),
        v.get("imo"),
        v.get("lengthM"),
        v.get("draughtM"),
        v.get("destRisk"),
        v.get("destIncident"),
        v.get("flight"),
        v.get("airline"),
        v.get("dep"),
        v.get("arr"),
        v.get("altM"),
        # Disruption convenience — populated below in snapshot_connection
        0,  # placeholder, overwritten via UPDATE
        0,  # placeholder, overwritten via UPDATE
    )


def _row_from_shipment(s: dict[str, Any]) -> tuple:
    """Project a CompactShipment dict (from aiClient.ts) to a tuple in
    SHIPMENT_COLUMNS order. All optional fields tolerate None."""
    return (
        s.get("vehicleId"),
        s.get("vehicleType"),
        s.get("docId"),
        s.get("customerCode"),
        s.get("commodity"),
        s.get("hsCode"),
        s.get("countryOrigin"),
        s.get("grossKg"),
        s.get("volumeM3"),
        s.get("valueUSD"),
        1 if s.get("hazmat") else 0,
        s.get("hazmatClass"),
        s.get("hazmatUn"),
        1 if s.get("reefer") else 0,
        s.get("temperature"),
        s.get("unitCount"),
        s.get("unitLabel"),
        s.get("chargeableKg"),
        s.get("shc"),
    )


def snapshot_connection(
    vehicles: list[dict[str, Any]],
    disruptions: list[dict[str, Any]] | None = None,
    shipments: list[dict[str, Any]] | None = None,
) -> sqlite3.Connection:
    """Create an in-memory SQLite database populated from a vehicle snapshot.

    Caller is responsible for `.close()`ing the returned connection. The
    haversine_km function is registered on the connection.

    Disruption counts are derived from the disruptions list (also from the
    AI context) so spatial queries can join "vehicles WHERE has_disruption=1
    AND haversine_km(...) < 100" cleanly.
    """
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.create_function("haversine_km", 4, _haversine_km, deterministic=True)

    col_defs = ", ".join(f"{name} {dtype}" for name, dtype in SCHEMA_COLUMNS)
    conn.execute(f"CREATE TABLE vehicles ({col_defs})")

    placeholders = ", ".join("?" for _ in SCHEMA_COLUMNS)
    rows = [_row_from_vehicle(v) for v in vehicles]
    conn.executemany(f"INSERT INTO vehicles VALUES ({placeholders})", rows)

    # Derive disruption flags. We loop in Python rather than maintain a
    # separate disruptions table — the AI rarely needs to join, and the
    # context already lists disruptions with vehicleId so the model can read
    # them straight out of JSON when it does.
    if disruptions:
        counts: dict[str, int] = {}
        for d in disruptions:
            vid = d.get("vehicleId")
            if vid:
                counts[vid] = counts.get(vid, 0) + 1
        for vid, count in counts.items():
            conn.execute(
                "UPDATE vehicles SET has_disruption=1, disruption_count=? WHERE id=?",
                (count, vid),
            )

    # Build shipments table — empty schema if no shipments supplied so the
    # AI's queries still parse cleanly (they'll just return 0 rows).
    ship_cols = ", ".join(f"{name} {dtype}" for name, dtype in SHIPMENT_COLUMNS)
    conn.execute(f"CREATE TABLE shipments ({ship_cols})")
    if shipments:
        ship_placeholders = ", ".join("?" for _ in SHIPMENT_COLUMNS)
        ship_rows = [_row_from_shipment(s) for s in shipments]
        conn.executemany(
            f"INSERT INTO shipments VALUES ({ship_placeholders})", ship_rows,
        )
        # Indexes that pay off the most for the AI's JOIN patterns.
        conn.execute("CREATE INDEX idx_ship_vid ON shipments(vehicle_id)")
        conn.execute("CREATE INDEX idx_ship_hazmat ON shipments(hazmat) WHERE hazmat=1")
        conn.execute("CREATE INDEX idx_ship_reefer ON shipments(reefer) WHERE reefer=1")

    conn.commit()
    return conn


def is_select_only(sql: str) -> tuple[bool, str]:
    """Cheap safety check: reject anything that's not a single SELECT.

    Returns (ok, reason). Reason is human-readable for the error fed back
    to the model so it can correct itself.
    """
    stripped = sql.strip().rstrip(";").strip()
    if not stripped:
        return False, "empty query"
    head = stripped.split()[0].lower() if stripped.split() else ""
    if head != "select" and head != "with":
        return False, f"query must start with SELECT or WITH (got: {head!r})"
    if _FORBIDDEN.search(stripped):
        return False, "query contains a disallowed keyword (only SELECT is permitted)"
    # No trailing semicolon-separated statements.
    if ";" in stripped:
        return False, "only a single SQL statement is allowed"
    return True, ""


def run_query(
    vehicles: list[dict[str, Any]],
    disruptions: list[dict[str, Any]] | None,
    sql: str,
    *,
    row_limit: int = 200,
    shipments: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Execute a single SELECT against a fresh snapshot and return rows.

    Returns:
      {
        "rows": [...],          # list of dicts, capped at row_limit
        "row_count": int,       # total rows BEFORE the cap
        "columns": [str, ...],  # column names
        "truncated": bool,      # True if row_limit was hit
      }

    Raises ValueError on a forbidden/empty query (caller maps to a
    structured tool error so the model can self-correct).
    """
    ok, reason = is_select_only(sql)
    if not ok:
        raise ValueError(reason)

    conn = snapshot_connection(vehicles, disruptions, shipments)
    try:
        cursor = conn.execute(sql)
        all_rows = cursor.fetchall()
        columns = [d[0] for d in cursor.description] if cursor.description else []
    finally:
        conn.close()

    truncated = len(all_rows) > row_limit
    rows_capped = all_rows[:row_limit]
    rows_as_dicts = [dict(zip(columns, row)) for row in rows_capped]

    return {
        "rows": rows_as_dicts,
        "row_count": len(all_rows),
        "columns": columns,
        "truncated": truncated,
    }

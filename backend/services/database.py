"""SQLite connection pool and transactional UPSERT handlers.

Schema lives here. The Next.js frontend never touches SQLite directly — the
FastAPI app in app.py reads from these tables and reshapes the rows into the
Ship / port-alert objects the React code expects.
"""
from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from queue import Empty, Queue
from typing import Iterator, Optional

# backend/services/database.py → parent.parent.parent is repo root, where the
# shared data/ directory sits. Both stacks read from data/, so it stays at the
# top level even though only the backend writes to tracking.db.
DB_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "tracking.db"


class ConnectionPool:
    """A minimal thread-safe SQLite connection pool."""

    def __init__(self, path: Path, size: int = 5) -> None:
        self._path = path
        self._pool: Queue[sqlite3.Connection] = Queue(maxsize=size)
        self._lock = threading.Lock()
        path.parent.mkdir(parents=True, exist_ok=True)
        for _ in range(size):
            self._pool.put(self._make_connection())

    def _make_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(
            self._path,
            check_same_thread=False,
            isolation_level=None,
            timeout=30.0,
        )
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    @contextmanager
    def acquire(self) -> Iterator[sqlite3.Connection]:
        try:
            conn = self._pool.get(timeout=10)
        except Empty:
            conn = self._make_connection()
        try:
            yield conn
        finally:
            try:
                self._pool.put_nowait(conn)
            except Exception:
                try:
                    conn.close()
                except Exception:
                    pass

    def close_all(self) -> None:
        with self._lock:
            while not self._pool.empty():
                try:
                    self._pool.get_nowait().close()
                except Exception:
                    pass


_pool: Optional[ConnectionPool] = None


def get_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        _pool = ConnectionPool(DB_PATH)
        init_schema()
    return _pool


def init_schema() -> None:
    """Create the vessel_cache and port_alerts tables if they do not exist."""
    assert _pool is not None
    with _pool.acquire() as conn:
        try:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS vessel_cache (
                    mmsi          TEXT PRIMARY KEY,
                    vessel_name   TEXT,
                    ship_type     INTEGER,
                    lat           REAL,
                    lng           REAL,
                    cog           REAL,
                    heading       REAL,
                    sog           REAL,
                    nav_status    INTEGER,
                    destination   TEXT,
                    call_sign     TEXT,
                    imo           INTEGER,
                    draught       REAL,
                    length        REAL,
                    last_updated  TEXT
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS port_alerts (
                    unlocode    TEXT PRIMARY KEY,
                    port_name   TEXT,
                    risk_level  TEXT,
                    incident    TEXT,
                    timestamp   TEXT
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_vessel_updated ON vessel_cache(last_updated)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_vessel_dest ON vessel_cache(destination)"
            )

            # Forward-compat: ADD COLUMN any missing fields if an older schema exists.
            existing_cols = {row["name"] for row in conn.execute("PRAGMA table_info(vessel_cache)")}
            new_cols = {
                "cog":        "REAL",
                "heading":    "REAL",
                "sog":        "REAL",
                "nav_status": "INTEGER",
                "call_sign":  "TEXT",
                "imo":        "INTEGER",
                "draught":    "REAL",
                "length":     "REAL",
            }
            for col, ctype in new_cols.items():
                if col not in existing_cols:
                    try:
                        conn.execute(f"ALTER TABLE vessel_cache ADD COLUMN {col} {ctype}")
                    except sqlite3.Error as exc:
                        print(f"[database] ADD COLUMN {col} failed: {exc}")
        except sqlite3.Error as exc:
            print(f"[database] schema init failed: {exc}")


def upsert_vessel(
    mmsi: str,
    *,
    vessel_name: str = "",
    ship_type: int = 0,
    lat: float = 0.0,
    lng: float = 0.0,
    cog: Optional[float] = None,
    heading: Optional[float] = None,
    sog: Optional[float] = None,
    nav_status: Optional[int] = None,
    destination: str = "",
    call_sign: str = "",
    imo: Optional[int] = None,
    draught: Optional[float] = None,
    length: Optional[float] = None,
) -> None:
    """Atomic upsert of a vessel position into the cache.

    Keyword-only beyond mmsi — there are 13 fields and positional was getting
    unreadable. COALESCE-on-blank protects static fields (name, destination,
    call sign) that arrive in separate ShipStaticData packets from being
    clobbered by subsequent position-only packets.
    """
    pool = get_pool()
    now = datetime.now(timezone.utc).isoformat()
    sql = (
        "INSERT INTO vessel_cache "
        "(mmsi, vessel_name, ship_type, lat, lng, "
        " cog, heading, sog, nav_status, "
        " destination, call_sign, imo, draught, length, last_updated) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(mmsi) DO UPDATE SET "
        " vessel_name  = COALESCE(NULLIF(excluded.vessel_name, ''), vessel_cache.vessel_name), "
        " ship_type    = COALESCE(NULLIF(excluded.ship_type, 0),    vessel_cache.ship_type), "
        " lat          = excluded.lat, "
        " lng          = excluded.lng, "
        " cog          = COALESCE(excluded.cog,        vessel_cache.cog), "
        " heading      = COALESCE(excluded.heading,    vessel_cache.heading), "
        " sog          = COALESCE(excluded.sog,        vessel_cache.sog), "
        " nav_status   = COALESCE(excluded.nav_status, vessel_cache.nav_status), "
        " destination  = COALESCE(NULLIF(excluded.destination, ''), vessel_cache.destination), "
        " call_sign    = COALESCE(NULLIF(excluded.call_sign, ''),   vessel_cache.call_sign), "
        " imo          = COALESCE(excluded.imo,        vessel_cache.imo), "
        " draught      = COALESCE(excluded.draught,    vessel_cache.draught), "
        " length       = COALESCE(excluded.length,     vessel_cache.length), "
        " last_updated = excluded.last_updated"
    )
    with pool.acquire() as conn:
        try:
            conn.execute(
                sql,
                (
                    mmsi, vessel_name, ship_type, lat, lng,
                    cog, heading, sog, nav_status,
                    destination, call_sign, imo, draught, length,
                    now,
                ),
            )
        except sqlite3.Error as exc:
            print(f"[database] upsert_vessel failed for {mmsi}: {exc}")


def upsert_port_alert(
    unlocode: str, port_name: str, risk_level: str, incident: str
) -> None:
    pool = get_pool()
    now = datetime.now(timezone.utc).isoformat()
    with pool.acquire() as conn:
        try:
            conn.execute(
                """
                INSERT INTO port_alerts (unlocode, port_name, risk_level, incident, timestamp)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(unlocode) DO UPDATE SET
                    port_name  = excluded.port_name,
                    risk_level = excluded.risk_level,
                    incident   = excluded.incident,
                    timestamp  = excluded.timestamp
                """,
                (unlocode, port_name, risk_level, incident, now),
            )
        except sqlite3.Error as exc:
            print(f"[database] upsert_port_alert failed for {unlocode}: {exc}")


def fetch_all_vessels() -> list[dict]:
    pool = get_pool()
    with pool.acquire() as conn:
        try:
            rows = conn.execute(
                "SELECT mmsi, vessel_name, ship_type, lat, lng, "
                "cog, heading, sog, nav_status, "
                "destination, call_sign, imo, draught, length, last_updated "
                "FROM vessel_cache"
            ).fetchall()
            return [dict(r) for r in rows]
        except sqlite3.Error as exc:
            print(f"[database] fetch_all_vessels failed: {exc}")
            return []


def fetch_all_alerts() -> dict[str, dict]:
    """Return a {unlocode: alert_row} mapping for O(1) lookup."""
    pool = get_pool()
    with pool.acquire() as conn:
        try:
            rows = conn.execute(
                "SELECT unlocode, port_name, risk_level, incident, timestamp FROM port_alerts"
            ).fetchall()
            return {r["unlocode"]: dict(r) for r in rows}
        except sqlite3.Error as exc:
            print(f"[database] fetch_all_alerts failed: {exc}")
            return {}

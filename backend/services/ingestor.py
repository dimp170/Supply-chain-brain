"""Async AISStream ingestion worker.

Subscribes to aisstream.io for PositionReport + ShipStaticData, caches static-
data fields (so they aren't lost between position-only packets), then upserts
each position into the vessel_cache table. The frontend never sees this code;
it only sees rows via /api/vessels.

Defaults to a global bounding box so the cinematic Mapbox globe can populate
worldwide. Override with the AIS_BBOX env var (JSON list of [[SW_lat, SW_lng],
[NE_lat, NE_lng]] boxes) if you want to narrow it.

Tracks live counters (msg_count, state, last_message) so /api/ingestor/status
can serve them — that endpoint replaces the AISStatus the old browser-side
WebSocket client used to emit.
"""
from __future__ import annotations

import asyncio
import json
import os
from typing import Any

import websockets
from websockets.exceptions import ConnectionClosed, WebSocketException

from .database import upsert_vessel

AIS_STREAM_URL = "wss://stream.aisstream.io/v0/stream"
DEFAULT_BBOX = [[[-90.0, -180.0], [90.0, 180.0]]]


def _clean(text: Any) -> str:
    if text is None:
        return ""
    return str(text).strip().replace("@", "").strip()


def _parse_bbox_env(raw: str | None) -> list | None:
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list) and parsed:
            return parsed
    except (TypeError, ValueError):
        pass
    return None


class AISIngestor:
    def __init__(
        self,
        api_key: str | None = None,
        bbox: list | None = None,
        backoff_initial: float = 2.0,
        backoff_max: float = 60.0,
    ) -> None:
        self.api_key = api_key or os.environ.get("AISSTREAM_API_KEY", "")
        self.bbox = bbox or _parse_bbox_env(os.environ.get("AIS_BBOX")) or DEFAULT_BBOX
        self.backoff_initial = backoff_initial
        self.backoff_max = backoff_max
        self._stop = asyncio.Event()

        # Live counters exposed via /api/ingestor/status.
        self.msg_count: int = 0
        self.state: str = "connecting"
        self.last_message: str | None = None

    def stop(self) -> None:
        self._stop.set()

    def _subscription_payload(self) -> str:
        return json.dumps({
            "APIKey": self.api_key,
            "BoundingBoxes": self.bbox,
            "FilterMessageTypes": ["PositionReport", "ShipStaticData"],
        })

    async def _handle_static(self, mmsi: str, meta: dict, static: dict) -> None:
        if not static.get("Valid", True):
            return
        try:
            ship_type = int(static.get("Type") or 0)
        except (TypeError, ValueError):
            ship_type = 0
        try:
            imo_val = int(static.get("Imo") or 0)
        except (TypeError, ValueError):
            imo_val = 0
        try:
            draught_raw = float(static.get("MaximumStaticDraught") or static.get("Draught") or 0)
        except (TypeError, ValueError):
            draught_raw = 0.0
        # Legacy "Draught" field is 1/10 metre; MaximumStaticDraught is metres.
        draught_m = draught_raw / 10.0 if draught_raw > 30 else draught_raw
        try:
            bow   = float(static.get("DimensionToBow")   or 0)
            stern = float(static.get("DimensionToStern") or 0)
        except (TypeError, ValueError):
            bow = stern = 0.0
        length_m = bow + stern

        upsert_vessel(
            mmsi,
            vessel_name=_clean(static.get("Name")),
            ship_type=ship_type,
            lat=float(meta.get("latitude") or 0.0),
            lng=float(meta.get("longitude") or 0.0),
            destination=_clean(static.get("Destination")),
            call_sign=_clean(static.get("CallSign")),
            imo=imo_val or None,
            draught=draught_m or None,
            length=length_m or None,
        )
        self.last_message = f"static {mmsi}"

    async def _handle_position(self, mmsi: str, meta: dict, pos: dict) -> None:
        try:
            lat = float(pos.get("Latitude"))
            lng = float(pos.get("Longitude"))
        except (TypeError, ValueError):
            return
        if abs(lat) > 90 or abs(lng) > 180 or (lat == 0 and lng == 0):
            return

        try:
            sog_knots = float(pos.get("Sog") or 0)
        except (TypeError, ValueError):
            sog_knots = 0.0
        try:
            cog_deg = float(pos.get("Cog") or 0)
        except (TypeError, ValueError):
            cog_deg = 0.0
        try:
            heading_deg = float(pos.get("TrueHeading") or 511)
        except (TypeError, ValueError):
            heading_deg = 511.0
        try:
            ns = pos.get("NavigationStatus")
            nav_status = int(ns) if ns is not None else None
        except (TypeError, ValueError):
            nav_status = None

        self.msg_count += 1
        try:
            upsert_vessel(
                mmsi,
                vessel_name=_clean(meta.get("ShipName")),
                lat=lat,
                lng=lng,
                cog=cog_deg,
                heading=heading_deg if heading_deg != 511 else None,
                sog=sog_knots,
                nav_status=nav_status,
            )
        except Exception as exc:
            print(f"[ingestor] upsert error: {exc}")

    async def _consume(self) -> None:
        if not self.api_key:
            self.state = "error"
            self.last_message = "AISSTREAM_API_KEY not set"
            print("[ingestor] AISSTREAM_API_KEY not set; sleeping (no live feed)")
            await asyncio.sleep(60)
            return

        async with websockets.connect(
            AIS_STREAM_URL, ping_interval=20, ping_timeout=20, max_size=2**20
        ) as ws:
            await ws.send(self._subscription_payload())
            self.state = "connected"
            self.last_message = None
            print(f"[ingestor] connected to aisstream.io (bbox={self.bbox})")

            while not self._stop.is_set():
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=60)
                except asyncio.TimeoutError:
                    continue

                try:
                    packet = json.loads(raw)
                except (TypeError, ValueError):
                    continue

                meta = packet.get("MetaData") or {}
                mmsi = str(meta.get("MMSI") or "").strip()
                if not mmsi:
                    continue

                msg_type = packet.get("MessageType")
                msg_block = packet.get("Message") or {}

                if msg_type == "ShipStaticData":
                    await self._handle_static(mmsi, meta, msg_block.get("ShipStaticData") or {})
                    continue

                if msg_type == "PositionReport":
                    await self._handle_position(mmsi, meta, msg_block.get("PositionReport") or {})
                    continue

                self.last_message = msg_type

    async def run_forever(self) -> None:
        backoff = self.backoff_initial
        while not self._stop.is_set():
            try:
                self.state = "connecting"
                await self._consume()
                backoff = self.backoff_initial
            except (ConnectionClosed, WebSocketException, OSError) as exc:
                self.state = "disconnected"
                self.last_message = str(exc)
                print(f"[ingestor] disconnected ({exc}); backing off {backoff:.1f}s")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, self.backoff_max)
            except Exception as exc:
                self.state = "error"
                self.last_message = str(exc)
                print(f"[ingestor] unexpected error: {exc}; backing off {backoff:.1f}s")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, self.backoff_max)

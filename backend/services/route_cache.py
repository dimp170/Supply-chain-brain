"""On-disk cache for HERE truck route responses.

Petros mock truck origin/destination pairs are static, so caching the HERE
responses on disk means:
  * After the first successful fetch per route, subsequent page loads
    serve the polyline instantly without round-tripping HERE.
  * HERE rate-limit / 502 errors don't break the demo *as long as* the
    route has cached at least once.
  * Backend (uvicorn) restarts don't trigger re-fetches — the JSON file
    persists.

Cache key is rounded to 4 decimal places (~11 metres at the equator) so
identical origin/dest pairs hit the same entry regardless of float jitter
between page loads. The cache file is hand-deletable — `rm data/
truck_routes_cache.json` forces a full refresh next time the routes are
requested.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Optional

# Repo data directory — same place petros_fleet.json lives.
_ROOT = Path(__file__).resolve().parent.parent.parent
CACHE_FILE = _ROOT / "data" / "truck_routes_cache.json"

# Single async lock keeps concurrent write attempts (multiple trucks
# preloading in parallel from app/page.tsx) from racing on the JSON file.
_lock = asyncio.Lock()
_cache: dict[str, list[dict]] | None = None


def _key(origin: tuple[float, float], destination: tuple[float, float]) -> str:
    """Stringified rounded coordinates — used as the dict key. Rounding
    smooths over floating-point jitter so identical truck pairs always
    hit the same entry."""
    return (
        f"{round(origin[0], 4)},{round(origin[1], 4)}|"
        f"{round(destination[0], 4)},{round(destination[1], 4)}"
    )


def _load() -> dict:
    """Lazy-load the cache from disk on first call. Falls back to an empty
    dict if the file is missing or corrupt — never throws to the caller."""
    global _cache
    if _cache is not None:
        return _cache
    try:
        if CACHE_FILE.exists():
            _cache = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
            if not isinstance(_cache, dict):
                _cache = {}
            print(f"[route_cache] loaded {len(_cache)} cached routes from {CACHE_FILE}", flush=True)
        else:
            _cache = {}
            print(f"[route_cache] starting empty (no cache file yet)", flush=True)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"[route_cache] load failed ({exc}); starting empty", flush=True)
        _cache = {}
    return _cache


def _save() -> None:
    """Atomic write — temp file + rename so a partially-written JSON can't
    corrupt the cache if uvicorn crashes mid-write. Best-effort: errors
    are logged but not raised because the cache is a perf optimisation,
    not a correctness requirement."""
    if _cache is None:
        return
    try:
        CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = CACHE_FILE.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps(_cache, separators=(",", ":"), ensure_ascii=False),
            encoding="utf-8",
        )
        tmp.replace(CACHE_FILE)
    except OSError as exc:
        print(f"[route_cache] save failed: {exc}", flush=True)


def get(
    origin: tuple[float, float], destination: tuple[float, float]
) -> Optional[list[dict]]:
    """Synchronous cache lookup. Returns the cached RoutePoint list or None
    if this origin/dest pair hasn't been seen yet."""
    return _load().get(_key(origin, destination))


async def put(
    origin: tuple[float, float],
    destination: tuple[float, float],
    points: list[dict],
) -> None:
    """Store a route in the cache and flush to disk. Async so concurrent
    truck preloads don't race on the file. No-op if `points` is empty —
    don't want to cache the zero-result so a HERE recovery actually
    re-fetches."""
    if not points:
        return
    async with _lock:
        cache = _load()
        cache[_key(origin, destination)] = points
        _save()


def size() -> int:
    """Cached-entry count. Useful for diagnostics / startup logging."""
    return len(_load())

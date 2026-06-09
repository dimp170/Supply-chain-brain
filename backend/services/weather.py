"""Weather data fetching service.

Fetches current weather from Open-Meteo (free, no API key required).
This runs server-side to avoid CORS issues that plague client-side calls.

Open-Meteo API: https://open-meteo.com/en/docs
Rate limit: ~10k requests/day, batched requests are cheaper than individual calls.
"""
from __future__ import annotations

from typing import Any, Optional
import httpx
import asyncio
import math
from datetime import datetime, timedelta

OPEN_METEO_BASE = "https://api.open-meteo.com/v1"

# Weather grid sections to reduce Open-Meteo calls.
# A 2°×2° tile is roughly 220km at the equator and still useful for logistics risk mapping.
SECTION_SIZE_LAT = 2.0
SECTION_SIZE_LON = 2.0

# Cache per grid section rather than raw coordinate, so nearby points reuse the same data.
_weather_cache: dict[tuple[float, float], tuple[dict[str, Any], datetime]] = {}
CACHE_TTL = timedelta(minutes=10)        # real Open-Meteo data — 10 min TTL
MOCK_CACHE_TTL = timedelta(seconds=30)   # mock fallback data — 30 s TTL so a
                                         # transient Open-Meteo blip doesn't
                                         # pin a section to "Simulated" for
                                         # 10 minutes after the API recovers.
                                         # Without this, every vehicle in the
                                         # bad section reads "Simulated" for
                                         # the entire demo even though the
                                         # underlying issue cleared seconds in.

# WMO Weather interpretation codes
WMO_CODES = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Foggy",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    61: "Slight rain",
    63: "Moderate rain",
    65: "Heavy rain",
    71: "Slight snow",
    73: "Moderate snow",
    75: "Heavy snow",
    77: "Snow grains",
    80: "Slight rain showers",
    81: "Moderate rain showers",
    82: "Violent rain showers",
    85: "Slight snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with slight hail",
    99: "Thunderstorm with heavy hail",
}


def section_key(latitude: float, longitude: float) -> tuple[float, float]:
    return (
        math.floor(latitude / SECTION_SIZE_LAT) * SECTION_SIZE_LAT,
        math.floor(longitude / SECTION_SIZE_LON) * SECTION_SIZE_LON,
    )


def section_center(key: tuple[float, float]) -> tuple[float, float]:
    return (
        key[0] + SECTION_SIZE_LAT / 2,
        key[1] + SECTION_SIZE_LON / 2,
    )


async def fetch_weather_at_location(
    latitude: float, longitude: float
) -> Optional[dict[str, Any]]:
    """Fetch current weather for a section's center point from Open-Meteo.
    
    Falls back to mock data if the API is unavailable or rate-limited.
    """
    section = section_key(latitude, longitude)
    location_key = section

    # Check cache first. Mock entries get a shorter TTL than real entries so a
    # transient Open-Meteo failure doesn't pin a section to "Simulated" for
    # the entire demo. If cache is stale, drop into the fetch path below.
    if location_key in _weather_cache:
        cached_data, timestamp = _weather_cache[location_key]
        ttl = MOCK_CACHE_TTL if cached_data.get("source") == "mock" else CACHE_TTL
        if datetime.now() - timestamp < ttl:
            print(
                f"[weather] cache hit ({cached_data.get('source')}) "
                f"section={section}",
                flush=True,
            )
            return cached_data

    center_lat, center_lon = section_center(section)
    try:
        params = {
            "latitude": str(center_lat),
            "longitude": str(center_lon),
            "current": "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,precipitation",
            "timezone": "auto",
        }

        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{OPEN_METEO_BASE}/forecast", params=params)
            response.raise_for_status()
            data = response.json()
        
        result = {
            "latitude": data["latitude"],
            "longitude": data["longitude"],
            "temperature": data["current"]["temperature_2m"],
            "humidity": data["current"]["relative_humidity_2m"],
            "windSpeed": data["current"]["wind_speed_10m"],
            "windDirection": data["current"]["wind_direction_10m"],
            "precipitation": data["current"]["precipitation"],
            "weatherCode": data["current"]["weather_code"],
            "description": WMO_CODES.get(
                data["current"]["weather_code"], "Unknown"
            ),
            "timestamp": data["current"]["time"],
            "source": "open-meteo",
            "section": section,
            "sectionCenter": [center_lat, center_lon],
        }
        
        # Cache the result by section
        _weather_cache[location_key] = (result, datetime.now())

        # NOTE: Windows console uses cp1252 by default, which cannot encode
        # Unicode chars like degree-symbol or right-arrow. Keep diagnostic
        # logs ASCII-only or print() itself raises ValueError and gets
        # silently turned into a 400 by the FastAPI handler. Bit me once.
        print(
            f"[weather] OK open-meteo section={section} "
            f"temp={result['temperature']:.1f}C wind={result['windSpeed']:.1f}km/h",
            flush=True,
        )

        return result
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 429:
            print(
                f"[weather] 429 rate-limited section={section} -> using mock fallback",
                flush=True,
            )
        else:
            print(
                f"[weather] HTTP {e.response.status_code} section={section} -> mock fallback",
                flush=True,
            )
        # Fall through to mock data
    except Exception as e:
        print(
            f"[weather] fetch failed section={section}: {type(e).__name__}: {e} -> mock fallback",
            flush=True,
        )
        # Fall through to mock data
    
    # Fallback: return mock weather data so frontend always has something
    import random
    mock_result = {
        "latitude": latitude,
        "longitude": longitude,
        "temperature": 15 + random.uniform(-5, 20),  # 10-35°C
        "humidity": 40 + random.randint(0, 50),
        "windSpeed": 5 + random.uniform(0, 25),  # 5-30 km/h
        "windDirection": random.randint(0, 360),
        "precipitation": 0 if random.random() > 0.15 else random.uniform(1, 10),
        "weatherCode": 0 if random.random() > 0.2 else 61,  # occasional rain
        "description": "Mock weather data (API unavailable)",
        "timestamp": datetime.now().isoformat() + "Z",
        "source": "mock",
    }
    
    # Cache mock data — read TTL is MOCK_CACHE_TTL above (30 s). Short window
    # so the next call after Open-Meteo recovers immediately gets real data.
    _weather_cache[location_key] = (mock_result, datetime.now())

    return mock_result


async def normalize_location_sections(
    locations: list[tuple[float, float]],
) -> list[tuple[float, float]]:
    """Map raw locations to unique section centers to reduce API requests."""
    section_centers: dict[tuple[float, float], tuple[float, float]] = {}
    for lat, lon in locations:
        section = section_key(lat, lon)
        if section not in section_centers:
            section_centers[section] = section_center(section)
    return list(section_centers.values())


async def fetch_weather_for_locations(
    locations: list[tuple[float, float]],
) -> dict[str, Any]:
    """Fetch weather for multiple locations with section-based dedup.

    Locations are collapsed to grid sections before talking to Open-Meteo,
    then fetched in PARALLEL. Open-Meteo's free tier comfortably handles
    10 req/s per IP, so the previous sequential-with-1s-sleep approach was
    leaving 7+ seconds on the table for a typical 8-location batch.

    Per-section results are cached in `_weather_cache` for CACHE_TTL, so
    repeated calls for the same area (truck moving inside a 2°×2° tile)
    short-circuit without re-hitting the API. The semaphore is a belt-
    and-braces guard for the case where someone calls this with a very
    large location list — we cap concurrency at 8 outbound requests so
    we never accidentally swarm Open-Meteo and trigger rate limiting.
    """
    unique_locations = await normalize_location_sections(locations)

    sem = asyncio.Semaphore(8)

    async def _fetch_one(lat: float, lon: float):
        async with sem:
            return await fetch_weather_at_location(lat, lon)

    results = await asyncio.gather(
        *(_fetch_one(lat, lon) for lat, lon in unique_locations)
    )
    conditions = [r for r in results if r is not None]
    
    # Generate simple risk zones based on conditions
    risk_zones = []
    for idx, condition in enumerate(conditions):
        temp = condition["temperature"]
        wind = condition["windSpeed"]
        precip = condition["precipitation"]
        
        # Temperature extremes
        if temp > 35:
            risk_zones.append({
                "id": f"heat-{idx}",
                "type": "weather_alert",
                "severity": "CRITICAL" if temp > 40 else "HIGH",
                "center": [condition["latitude"], condition["longitude"]],
                "radius": 50,
                "affectedVehicles": [],
                "description": f"Extreme heat: {temp:.1f}°C",
                "recommendations": [
                    "Reduce speed for refrigerated cargo",
                    "Add cooling stops every 2 hours",
                    "Monitor temperature closely",
                ],
                "validFrom": condition["timestamp"],
                "validUntil": "2026-06-04T00:00:00Z",
            })
        
        # Strong winds
        if wind > 50:
            risk_zones.append({
                "id": f"wind-{idx}",
                "type": "weather_alert",
                "severity": "CRITICAL" if wind > 70 else "HIGH",
                "center": [condition["latitude"], condition["longitude"]],
                "radius": 100,
                "affectedVehicles": [],
                "description": f"Strong winds: {wind:.1f} km/h",
                "recommendations": [
                    "Reduce speed for high-profile cargo",
                    "Consider delay until conditions improve",
                    "Monitor for vehicle instability",
                ],
                "validFrom": condition["timestamp"],
                "validUntil": "2026-06-04T00:00:00Z",
            })
        
        # Heavy precipitation
        if precip > 10:
            risk_zones.append({
                "id": f"rain-{idx}",
                "type": "weather_alert",
                "severity": "HIGH" if precip > 25 else "MEDIUM",
                "center": [condition["latitude"], condition["longitude"]],
                "radius": 50,
                "affectedVehicles": [],
                "description": f"Heavy precipitation: {precip:.1f} mm",
                "recommendations": [
                    "Reduce speed",
                    "Increase following distance",
                    "Monitor for flooding on roads",
                ],
                "validFrom": condition["timestamp"],
                "validUntil": "2026-06-04T00:00:00Z",
            })
    
    return {
        "alerts": [],
        "conditions": conditions,
        "riskZones": risk_zones,
        "lastUpdated": conditions[0]["timestamp"] if conditions else None,
    }

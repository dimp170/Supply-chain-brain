"""IATA airport code -> (lng, lat) lookup for the Petros mock plane fleet.

Used by `/api/fleet/petros` to resolve a plane's `departureAirport` to
coordinates for great-circle route construction. The route then runs from
the DEPARTURE airport to the ARRIVAL airport (whose coords are already
stored as the plane's `destination` field), so the frontend can render a
full great-circle polyline with the already-flown segment drawn darker up
to where the aircraft currently sits.

If an IATA code isn't in this lookup, the caller falls back to using the
plane's current position as the route origin — the route still renders,
just without a meaningful travelled segment.

Coordinates are airport reference points (approximately the geographic
centre of the runway complex), not city centres.
"""

from __future__ import annotations

# IATA -> (lng, lat) for every code referenced in petros_fleet.json's
# departureAirport / arrivalAirport fields. Add new codes here as new
# planes are introduced.
AIRPORT_COORDS: dict[str, tuple[float, float]] = {
    "AKL": (174.79, -37.01),   # Auckland
    "ALA": (77.04,   43.35),   # Almaty
    "AMS": (4.76,    52.31),   # Amsterdam Schiphol
    "BKK": (100.75,  13.69),   # Bangkok Suvarnabhumi
    "BOG": (-74.14,   4.70),   # Bogota El Dorado
    "BOM": (72.87,   19.09),   # Mumbai Chhatrapati Shivaji
    "CAI": (31.40,   30.12),   # Cairo
    "CDG": (2.55,    49.01),   # Paris Charles de Gaulle
    "CGK": (106.66,  -6.12),   # Jakarta Soekarno-Hatta
    "CMN": (-7.59,   33.37),   # Casablanca Mohammed V
    "CPT": (18.60,  -33.97),   # Cape Town
    "DOH": (51.61,   25.27),   # Doha Hamad
    "DXB": (55.36,   25.25),   # Dubai
    "EZE": (-58.54, -34.82),   # Buenos Aires Ezeiza
    "FRA": (8.55,    50.04),   # Frankfurt
    "GRU": (-46.48, -23.43),   # Sao Paulo Guarulhos
    "HAN": (105.81,  21.22),   # Hanoi Noi Bai
    "HEL": (24.97,   60.32),   # Helsinki Vantaa
    "HKG": (113.91,  22.31),   # Hong Kong
    "ICN": (126.45,  37.46),   # Seoul Incheon
    "JFK": (-73.78,  40.64),   # New York JFK
    "JNB": (28.24,  -26.13),   # Johannesburg O R Tambo
    "KHI": (67.16,   24.91),   # Karachi Jinnah
    "KUL": (101.71,   2.74),   # Kuala Lumpur
    "LAX": (-118.41, 33.94),   # Los Angeles
    "LHR": (-0.45,   51.47),   # London Heathrow
    "LIM": (-77.11, -12.02),   # Lima Jorge Chavez
    "LOS": (3.32,     6.58),   # Lagos Murtala Muhammed
    "MAA": (80.18,   12.99),   # Chennai
    "MAD": (-3.57,   40.49),   # Madrid Barajas
    "MEL": (144.84, -37.67),   # Melbourne Tullamarine
    "MEX": (-99.07,  19.44),   # Mexico City Benito Juarez
    "MIA": (-80.29,  25.79),   # Miami
    "MNL": (121.02,  14.51),   # Manila Ninoy Aquino
    "NBO": (36.93,   -1.32),   # Nairobi Jomo Kenyatta
    "NRT": (140.39,  35.77),   # Tokyo Narita
    "ORD": (-87.91,  41.97),   # Chicago O'Hare
    "PEK": (116.59,  40.08),   # Beijing Capital
    "PVG": (121.81,  31.15),   # Shanghai Pudong
    "SCL": (-70.79, -33.39),   # Santiago de Chile
    "SGN": (106.65,  10.82),   # Ho Chi Minh City Tan Son Nhat
    "SIN": (103.99,   1.36),   # Singapore Changi
    "SVO": (37.41,   55.97),   # Moscow Sheremetyevo
    "SYD": (151.18, -33.95),   # Sydney Kingsford Smith
    "THR": (51.31,   35.69),   # Tehran Mehrabad
    "VVO": (132.15,  43.40),   # Vladivostok
    "YVR": (-123.18, 49.20),   # Vancouver
    "YYZ": (-79.63,  43.68),   # Toronto Pearson
}


def coords_for_airport(code: str | None) -> tuple[float, float] | None:
    """Return (lng, lat) for an IATA airport code, or None if unknown.

    Lookup is case-insensitive and tolerant of extra whitespace.
    """
    if not code:
        return None
    key = code.strip().upper()
    return AIRPORT_COORDS.get(key)

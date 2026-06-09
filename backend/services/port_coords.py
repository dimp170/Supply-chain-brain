"""Port name -> (lng, lat) lookup for the Petros mock fleet.

Used by `/api/fleet/petros` to resolve a ship's `originPort` to coordinates
for sea-route construction. The route then runs from the ORIGIN PORT (not
the ship's current position) to the DESTINATION PORT, so the frontend can
render a full route polyline with the already-travelled segment drawn in a
darker shade up to where the ship currently sits.

If a port name isn't in this lookup, the caller falls back to using the
ship's current position as the route origin.

Coordinates are approximate port-entry / harbour-mouth points, not city
centres, so they reliably snap to the searoute maritime network.
"""

from __future__ import annotations

# (lng, lat) for every port currently referenced in petros_fleet.json's
# originPort and destinationPort fields. Add new ports here as new ships
# are introduced.
PORT_COORDS: dict[str, tuple[float, float]] = {
    "ADEN":          (45.04, 12.78),
    "ALGECIRAS":     (-5.45, 36.13),
    "ANCHORAGE":     (-149.90, 61.22),
    "ARKHANGELSK":   (40.51, 64.54),
    "AUCKLAND":      (174.76, -36.85),
    "BARCELONA":     (2.17, 41.38),
    "BRISBANE":      (153.03, -27.47),
    "BUENOS AIRES":  (-58.38, -34.60),
    "BUSAN":         (129.08, 35.18),
    "CAPE TOWN":     (18.42, -33.92),
    "CARTAGENA":     (-75.51, 10.40),
    "CHENNAI":       (80.27, 13.08),
    "COLOMBO":       (79.85, 6.93),
    "CONSTANTA":     (28.66, 44.18),
    "DAKAR":         (-17.45, 14.72),
    "DAMMAM":        (50.10, 26.43),
    "DUBAI":         (55.30, 25.28),
    "DURBAN":        (31.04, -29.86),
    "FREMANTLE":     (115.74, -32.05),
    "GENOA":         (8.95, 44.41),
    "HALIFAX":       (-63.58, 44.65),
    "HAMBURG":       (10.00, 53.55),
    "HELSINKI":      (24.94, 60.17),
    "HONG KONG":     (114.17, 22.32),
    "HOUSTON":       (-95.37, 29.76),
    "ISTANBUL":      (28.98, 41.01),
    "KUWAIT":        (47.97, 29.38),
    "LAGOS":         (3.39, 6.45),
    "LE HAVRE":      (0.10, 49.49),
    "LISBON":        (-9.14, 38.72),
    "LONG BEACH":    (-118.19, 33.77),
    "LOS ANGELES":   (-118.24, 33.74),
    "MANILA":        (120.97, 14.60),
    "MOMBASA":       (39.67, -4.04),
    "MONTEVIDEO":    (-56.16, -34.90),
    "MUMBAI":        (72.83, 18.97),
    "MURMANSK":      (33.05, 68.97),
    "MUSCAT":        (58.59, 23.61),
    "NEW YORK":      (-74.04, 40.69),
    "OAKLAND":       (-122.30, 37.80),
    "PETROPAVLOVSK": (158.65, 53.02),
    "PIRAEUS":       (23.65, 37.94),
    "PORT SAID":     (32.31, 31.27),
    "PROVIDENIYA":   (-173.30, 64.42),
    "PUNTA ARENAS":  (-70.91, -53.16),
    "RECIFE":        (-34.88, -8.04),
    "ROTTERDAM":     (4.00, 51.95),
    "SANTOS":        (-46.33, -23.97),
    "SEATTLE":       (-122.34, 47.61),
    "SHANGHAI":      (121.47, 31.23),
    "SINGAPORE":     (103.82, 1.27),
    "ST PETERSBURG": (30.31, 59.93),
    "SUEZ PORT":     (32.55, 29.87),
    "SURABAYA":      (112.74, -7.27),
    "SYDNEY":        (151.21, -33.87),
    "TANGER":        (-5.79, 35.78),
    "TOKYO":         (139.65, 35.45),
    "VERACRUZ":      (-96.13, 19.19),
    "VLADIVOSTOK":   (131.89, 43.12),
    "YOKOHAMA":      (139.65, 35.43),
}


def coords_for_port(name: str | None) -> tuple[float, float] | None:
    """Return (lng, lat) for a port name, or None if unknown.

    Lookup is case-insensitive and tolerant of extra whitespace.
    """
    if not name:
        return None
    key = name.strip().upper()
    return PORT_COORDS.get(key)

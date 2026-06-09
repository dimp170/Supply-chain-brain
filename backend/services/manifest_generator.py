"""Procedural cargo manifest generator for the Petros mock ship fleet.

Generates one manifest per ship, deterministically seeded by ship id so the
same ship gets the same manifest across page loads (no jittering — important
when the AI agent answers "what's on pt-ship-49?" and the operator clicks
through to verify).

Manifest shape mirrors `types/manifest.ts` on the frontend. Per-sub-type
generation logic lives in the build_<subtype>_shipment functions; the
top-level build_manifest_for_ship picks the right one based on the ship's
`vesselSubType` field set in petros_fleet.json.

What's intentionally NOT modeled:
  * Shipper / consignee names — operator intel doesn't need them and faking
    plausible company names risks accidental hits on real businesses.
  * Origin/destination addresses — same reason.
  * Full HTS-10 codes — HS-6 is enough for commodity-flow analysis and the
    AI's value-at-risk questions. HS-10 is a customs concern, not ours.
"""
from __future__ import annotations

import math
import random
from typing import Optional


# ── HS code commodity pools per vessel sub-type ──────────────────────────────
# Format: (commodity_description, hs6_code, hazmat_p, reefer_p)
# Probabilities trigger optional fields on the generated shipment.

CommodityRow = tuple[str, str, float, float]

CONTAINER_COMMODITIES: list[CommodityRow] = [
    ("Consumer electronics",                "851712", 0.00, 0.00),
    ("Apparel and textiles",                "620342", 0.00, 0.00),
    ("Pharmaceuticals (non-controlled)",    "300490", 0.05, 0.25),
    ("Automotive parts",                    "870829", 0.00, 0.00),
    ("Industrial machinery parts",          "843143", 0.00, 0.00),
    ("Packaged food products",              "210690", 0.00, 0.10),
    ("Industrial chemicals (drummed)",      "382499", 0.65, 0.00),
    ("Furniture and home goods",            "940360", 0.00, 0.00),
    ("Toys and games",                      "950300", 0.00, 0.00),
    ("Cosmetics and personal care",         "330499", 0.00, 0.00),
    ("Specialty paints (drummed)",          "320820", 0.70, 0.00),
    ("Construction materials",              "681011", 0.00, 0.00),
    ("Electronic components (chip-level)",  "854231", 0.00, 0.00),
    ("Solar panel modules",                 "854142", 0.00, 0.00),
    ("Sporting goods",                      "950699", 0.00, 0.00),
]

TANKER_COMMODITIES: list[CommodityRow] = [
    ("Dubai Crude Oil",                     "270900", 1.00, 0.00),
    ("Brent Crude Oil",                     "270900", 1.00, 0.00),
    ("WTI Crude Oil",                       "270900", 1.00, 0.00),
    ("Refined Gasoline",                    "271012", 1.00, 0.00),
    ("Jet A-1 Aviation Fuel",               "271019", 1.00, 0.00),
    ("Diesel Fuel (ULSD)",                  "271019", 1.00, 0.00),
    ("Liquefied Natural Gas",               "271111", 1.00, 0.00),
    ("Liquefied Petroleum Gas",             "271113", 1.00, 0.00),
    ("Anhydrous Ammonia",                   "281410", 1.00, 0.00),
    ("Palm Oil (refined)",                  "151190", 0.00, 0.00),
    ("Sulfuric Acid (98%)",                 "280700", 1.00, 0.00),
    ("Methanol",                            "290511", 1.00, 0.00),
]

BULKER_COMMODITIES: list[CommodityRow] = [
    ("Iron Ore Fines",                      "260111", 0.00, 0.00),
    ("Iron Ore Pellets",                    "260112", 0.00, 0.00),
    ("Thermal Coal",                        "270112", 0.00, 0.00),
    ("Coking Coal",                         "270111", 0.00, 0.00),
    ("Wheat (HRS)",                         "100199", 0.00, 0.00),
    ("Corn (Yellow No. 2)",                 "100590", 0.00, 0.00),
    ("Soybeans",                            "120190", 0.00, 0.00),
    ("Urea Fertilizer (granular)",          "310210", 0.00, 0.00),
    ("Phosphate Rock",                      "251010", 0.00, 0.00),
    ("Bauxite",                             "260600", 0.00, 0.00),
    ("Cement Clinker",                      "252329", 0.00, 0.00),
    ("Sugar (raw)",                         "170111", 0.00, 0.00),
]

REEFER_COMMODITIES: list[CommodityRow] = [
    ("Bananas (Cavendish)",                 "080390", 0.00, 1.00),
    ("Citrus — Oranges",                    "080510", 0.00, 1.00),
    ("Citrus — Lemons",                     "080550", 0.00, 1.00),
    ("Frozen Atlantic Salmon",              "030313", 0.00, 1.00),
    ("Frozen Bluefin Tuna",                 "030341", 0.00, 1.00),
    ("Frozen Beef (boxed)",                 "020230", 0.00, 1.00),
    ("Frozen Poultry",                      "020714", 0.00, 1.00),
    ("Refrigerated Dairy (cheese)",         "040690", 0.00, 1.00),
    ("Temperature-controlled Pharmaceuticals", "300490", 0.05, 1.00),
    ("Fresh Cut Flowers",                   "060311", 0.00, 1.00),
    ("Frozen Shrimp",                       "030617", 0.00, 1.00),
]

RORO_COMMODITIES: list[tuple[str, str, str]] = [
    # (description, hs6, unit_type)
    ("Passenger Cars (mixed brands)",       "870323", "passenger_car"),
    ("Compact SUVs",                        "870324", "passenger_car"),
    ("Mid-size Commercial Trucks",          "870421", "commercial_truck"),
    ("Heavy Commercial Trucks",             "870422", "commercial_truck"),
    ("Crawler Excavators",                  "842952", "heavy_equipment"),
    ("Wheel Loaders",                       "842951", "heavy_equipment"),
    ("Agricultural Tractors",               "843210", "agricultural_machinery"),
    ("Combine Harvesters",                  "843351", "agricultural_machinery"),
]

BREAKBULK_COMMODITIES: list[CommodityRow] = [
    ("Steel Coils (hot-rolled)",            "720839", 0.00, 0.00),
    ("Sawn Lumber",                         "440710", 0.00, 0.00),
    ("Steel Pipes (large diameter)",        "730520", 0.00, 0.00),
    ("Wind Turbine Blades",                 "841290", 0.00, 0.00),
    ("Project Modules (industrial)",        "847990", 0.00, 0.00),
    ("Copper Cathodes",                     "740312", 0.00, 0.00),
    ("Aluminium Ingots",                    "760110", 0.00, 0.00),
]


# ── Hazmat metadata, keyed by commodity description ──────────────────────────
HAZMAT_BY_COMMODITY: dict[str, dict] = {
    "Dubai Crude Oil":          {"unNumber": "UN1267", "imdgClass": "3",   "packingGroup": "I",   "properShippingName": "PETROLEUM CRUDE OIL"},
    "Brent Crude Oil":          {"unNumber": "UN1267", "imdgClass": "3",   "packingGroup": "I",   "properShippingName": "PETROLEUM CRUDE OIL"},
    "WTI Crude Oil":            {"unNumber": "UN1267", "imdgClass": "3",   "packingGroup": "I",   "properShippingName": "PETROLEUM CRUDE OIL"},
    "Refined Gasoline":         {"unNumber": "UN1203", "imdgClass": "3",   "packingGroup": "II",  "properShippingName": "MOTOR SPIRIT"},
    "Jet A-1 Aviation Fuel":    {"unNumber": "UN1863", "imdgClass": "3",   "packingGroup": "III", "properShippingName": "FUEL, AVIATION, TURBINE ENGINE"},
    "Diesel Fuel (ULSD)":       {"unNumber": "UN1202", "imdgClass": "3",   "packingGroup": "III", "properShippingName": "DIESEL FUEL"},
    "Liquefied Natural Gas":    {"unNumber": "UN1972", "imdgClass": "2.1",                       "properShippingName": "METHANE, REFRIGERATED LIQUID"},
    "Liquefied Petroleum Gas":  {"unNumber": "UN1075", "imdgClass": "2.1",                       "properShippingName": "PETROLEUM GASES, LIQUEFIED"},
    "Anhydrous Ammonia":        {"unNumber": "UN1005", "imdgClass": "2.3",                       "properShippingName": "AMMONIA, ANHYDROUS"},
    "Sulfuric Acid (98%)":      {"unNumber": "UN1830", "imdgClass": "8",   "packingGroup": "II",  "properShippingName": "SULPHURIC ACID"},
    "Methanol":                 {"unNumber": "UN1230", "imdgClass": "3",   "packingGroup": "II",  "properShippingName": "METHANOL"},
    "Industrial chemicals (drummed)": {"unNumber": "UN3265", "imdgClass": "8", "packingGroup": "II", "properShippingName": "CORROSIVE LIQUID, ACIDIC, ORGANIC, N.O.S."},
    "Specialty paints (drummed)":     {"unNumber": "UN1263", "imdgClass": "3", "packingGroup": "III", "properShippingName": "PAINT"},
    "Pharmaceuticals (non-controlled)":         {"unNumber": "UN3373", "imdgClass": "6.2",                        "properShippingName": "BIOLOGICAL SUBSTANCE, CATEGORY B"},
    "Temperature-controlled Pharmaceuticals":   {"unNumber": "UN3373", "imdgClass": "6.2",                        "properShippingName": "BIOLOGICAL SUBSTANCE, CATEGORY B"},
}


# ── Port -> ISO-2 country code lookup ────────────────────────────────────────
# Covers every port currently in petros_fleet.json's originPort/destinationPort
# fields. Mirrors backend/services/port_coords.py — keep in sync if new ports
# are added.
COUNTRY_BY_PORT: dict[str, str] = {
    "ADEN":          "YE", "ALGECIRAS":     "ES", "ANCHORAGE":    "US",
    "ARKHANGELSK":   "RU", "AUCKLAND":      "NZ", "BARCELONA":    "ES",
    "BRISBANE":      "AU", "BUENOS AIRES":  "AR", "BUSAN":        "KR",
    "CAPE TOWN":     "ZA", "CARTAGENA":     "CO", "CHENNAI":      "IN",
    "COLOMBO":       "LK", "CONSTANTA":     "RO", "DAKAR":        "SN",
    "DAMMAM":        "SA", "DUBAI":         "AE", "DURBAN":       "ZA",
    "FREMANTLE":     "AU", "GENOA":         "IT", "HALIFAX":      "CA",
    "HAMBURG":       "DE", "HELSINKI":      "FI", "HONG KONG":    "HK",
    "HOUSTON":       "US", "ISTANBUL":      "TR", "KUWAIT":       "KW",
    "LAGOS":         "NG", "LE HAVRE":      "FR", "LISBON":       "PT",
    "LONG BEACH":    "US", "LOS ANGELES":   "US", "MANILA":       "PH",
    "MOMBASA":       "KE", "MONTEVIDEO":    "UY", "MUMBAI":       "IN",
    "MURMANSK":      "RU", "MUSCAT":        "OM", "NEW YORK":     "US",
    "OAKLAND":       "US", "PETROPAVLOVSK": "RU", "PIRAEUS":      "GR",
    "PORT SAID":     "EG", "PROVIDENIYA":   "RU", "PUNTA ARENAS": "CL",
    "RECIFE":        "BR", "ROTTERDAM":     "NL", "SANTOS":       "BR",
    "SEATTLE":       "US", "SHANGHAI":      "CN", "SINGAPORE":    "SG",
    "ST PETERSBURG": "RU", "SUEZ PORT":     "EG", "SURABAYA":     "ID",
    "SYDNEY":        "AU", "TANGER":        "MA", "TOKYO":        "JP",
    "VERACRUZ":      "MX", "VLADIVOSTOK":   "RU", "YOKOHAMA":     "JP",
}


def _country_for_port(port_name: Optional[str]) -> str:
    if not port_name:
        return "ZZ"  # unknown
    return COUNTRY_BY_PORT.get(port_name.strip().upper(), "ZZ")


# ── ID generators ────────────────────────────────────────────────────────────
# Container IDs follow BIC format: 4-letter owner code + 7 digits. We use
# "PTRU" for Petros containers (fictional). Seal numbers are 7-digit alnum.
# B/L and booking refs use carrier-prefixed sequences.

def _container_id(rng: random.Random) -> str:
    return f"PTRU{rng.randint(1000000, 9999999)}"


def _seal_number(rng: random.Random) -> str:
    return f"PT{rng.randint(100000, 999999):06d}"


def _bl_number(ship_id: str, voyage_seq: int, idx: int) -> str:
    # Pull the last 2 digits from "pt-ship-49"
    digits = "".join(c for c in ship_id if c.isdigit())[-2:] or "00"
    return f"PTBL{voyage_seq:04d}-{digits}-{idx:03d}"


def _booking_ref(ship_id: str, idx: int) -> str:
    digits = "".join(c for c in ship_id if c.isdigit())[-2:] or "00"
    return f"PTBK-{digits}-{idx:03d}"


def _customer_code(rng: random.Random) -> str:
    return f"SH-{rng.randint(1000, 9999)}"


# ── Common shipment-construction helpers ─────────────────────────────────────

INCOTERMS = ["FOB", "CIF", "CFR", "DAP", "EXW", "DDP"]
FREIGHT_TERMS = ["PREPAID", "COLLECT"]


def _pick_incoterm(rng: random.Random) -> str:
    # Bias toward FOB/CIF/CFR — the three most common in deep-sea trade.
    return rng.choices(INCOTERMS, weights=[35, 30, 20, 8, 4, 3])[0]


def _build_hazmat(commodity: str, rng: random.Random) -> Optional[dict]:
    """Look up hazmat metadata for a commodity. Returns None if commodity
    isn't in the hazmat table (i.e. not dangerous goods)."""
    info = HAZMAT_BY_COMMODITY.get(commodity)
    if not info:
        return None
    return dict(info)  # copy so callers can't mutate the shared dict


# ── Per-sub-type shipment builders ───────────────────────────────────────────

def _build_container_shipment(
    ship_id: str,
    voyage_seq: int,
    idx: int,
    origin_country: str,
    rng: random.Random,
    pool: list[CommodityRow] = CONTAINER_COMMODITIES,
    force_reefer: bool = False,
) -> dict:
    """One B/L for a container/reefer ship."""
    commodity, hs, hazmat_p, reefer_p = rng.choice(pool)
    hazmat_triggered = (not force_reefer) and rng.random() < hazmat_p
    reefer_triggered = force_reefer or rng.random() < reefer_p

    container_count = rng.randint(1, 30)
    # 20'STD ~ 22 t max gross, 40'HC ~ 30 t. Pick a type, derive gross weight.
    if reefer_triggered:
        container_type = rng.choice(["20'REF", "40'REF"])
    else:
        container_type = rng.choices(
            ["20'STD", "40'STD", "40'HC"], weights=[30, 35, 35]
        )[0]
    # Average gross per container (tonnes)
    avg_tonnes = {"20'STD": 17, "40'STD": 22, "40'HC": 22, "20'REF": 19, "40'REF": 24}[container_type]
    gross_kg = int(container_count * avg_tonnes * 1000 * rng.uniform(0.85, 1.10))
    net_kg = int(gross_kg * 0.88)  # tare ~12% of gross
    # Volume — 20' = 33 CBM, 40' = 67 CBM, 40'HC = 76 CBM
    cbm_per = {"20'STD": 33, "40'STD": 67, "40'HC": 76, "20'REF": 28, "40'REF": 60}[container_type]
    volume = int(container_count * cbm_per * rng.uniform(0.85, 0.98))

    # Declared value — depends on commodity. Use a coarse $/kg multiplier.
    value_per_kg = {
        "Consumer electronics": 28.0,
        "Electronic components (chip-level)": 220.0,
        "Solar panel modules": 8.0,
        "Apparel and textiles": 12.0,
        "Pharmaceuticals (non-controlled)": 70.0,
        "Temperature-controlled Pharmaceuticals": 95.0,
        "Automotive parts": 10.0,
        "Industrial machinery parts": 9.0,
        "Packaged food products": 3.5,
        "Industrial chemicals (drummed)": 4.0,
        "Furniture and home goods": 6.5,
        "Toys and games": 7.0,
        "Cosmetics and personal care": 18.0,
        "Specialty paints (drummed)": 5.0,
        "Construction materials": 1.5,
        "Sporting goods": 9.0,
    }.get(commodity, 6.0)
    value_usd = int(net_kg * value_per_kg * rng.uniform(0.85, 1.20))

    # Generate one container ID + seal per actual container — no truncation.
    # Container counts per shipment top out around 30 in the generator, which
    # is small enough to render comfortably in the panel's 2-column grid.
    container_ids = [_container_id(rng) for _ in range(container_count)]
    seal_numbers = [_seal_number(rng) for _ in range(container_count)]

    shipment = {
        "blNumber": _bl_number(ship_id, voyage_seq, idx),
        "bookingReference": _booking_ref(ship_id, idx),
        "customerCode": _customer_code(rng),
        "cargoForm": "reefer_containers" if reefer_triggered else "containerized",
        "containerType": container_type,
        "containerCount": container_count,
        "containerIds": container_ids,
        "sealNumbers": seal_numbers,
        "commodityDescription": commodity,
        "hsCode": hs,
        "packageType": "container",
        "packageCount": container_count,
        "grossWeightKg": gross_kg,
        "netWeightKg": net_kg,
        "volumeCBM": volume,
        "declaredValueUSD": value_usd,
        "countryOfOrigin": origin_country,
        "freightTerms": rng.choice(FREIGHT_TERMS),
        "incoterms": _pick_incoterm(rng),
    }
    if hazmat_triggered:
        hz = _build_hazmat(commodity, rng)
        if hz:
            shipment["hazmat"] = hz
    if reefer_triggered:
        # Frozen vs chilled setpoints — drives operational planning
        shipment["temperature"] = rng.choice([-25, -20, -18, 2, 4, 6, 12])
    return shipment


def _build_tanker_shipment(
    ship_id: str,
    voyage_seq: int,
    idx: int,
    origin_country: str,
    rng: random.Random,
    locked_commodity: Optional[CommodityRow] = None,
) -> dict:
    """One B/L for a tanker. Tankers typically carry one product across all
    cargo tanks, so a single voyage is one or two B/Ls of the same grade."""
    row = locked_commodity or rng.choice(TANKER_COMMODITIES)
    commodity, hs, hazmat_p, _ = row

    # Cargo split across N tanks — VLCCs have up to 15 cargo tanks
    n_tanks = rng.randint(6, 12)
    tank_names = []
    for t in range(n_tanks):
        side = rng.choice(["P", "S", "C"])  # Port, Starboard, Center
        tank_names.append(f"{side}{(t // 3) + 1}")
    tank_names = sorted(set(tank_names))[:n_tanks]

    # 100k-300k DWT × loading factor → tonnes lifted
    tonnes = rng.randint(60_000, 230_000)
    gross_kg = tonnes * 1000
    net_kg = gross_kg  # bulk liquid — no packaging tare
    # Density ~0.85 for crude, 0.74 for gasoline, 0.45 for LNG
    density = {
        "Dubai Crude Oil": 0.86, "Brent Crude Oil": 0.84, "WTI Crude Oil": 0.83,
        "Refined Gasoline": 0.74, "Jet A-1 Aviation Fuel": 0.80,
        "Diesel Fuel (ULSD)": 0.84, "Liquefied Natural Gas": 0.45,
        "Liquefied Petroleum Gas": 0.55, "Anhydrous Ammonia": 0.68,
        "Palm Oil (refined)": 0.92, "Sulfuric Acid (98%)": 1.83, "Methanol": 0.79,
    }.get(commodity, 0.85)
    volume = int(tonnes / density)  # CBM

    # Value per tonne (rough US$ proxies)
    value_per_t = {
        "Dubai Crude Oil": 500, "Brent Crude Oil": 530, "WTI Crude Oil": 510,
        "Refined Gasoline": 800, "Jet A-1 Aviation Fuel": 850,
        "Diesel Fuel (ULSD)": 780, "Liquefied Natural Gas": 600,
        "Liquefied Petroleum Gas": 550, "Anhydrous Ammonia": 450,
        "Palm Oil (refined)": 1000, "Sulfuric Acid (98%)": 80, "Methanol": 400,
    }.get(commodity, 500)
    value_usd = int(tonnes * value_per_t * rng.uniform(0.90, 1.10))

    shipment = {
        "blNumber": _bl_number(ship_id, voyage_seq, idx),
        "bookingReference": _booking_ref(ship_id, idx),
        "customerCode": _customer_code(rng),
        "cargoForm": "bulk_liquid",
        "tankNumbers": tank_names,
        "productGrade": commodity,
        "commodityDescription": commodity,
        "hsCode": hs,
        "packageType": "bulk",
        "packageCount": 1,
        "grossWeightKg": gross_kg,
        "netWeightKg": net_kg,
        "volumeCBM": volume,
        "declaredValueUSD": value_usd,
        "countryOfOrigin": origin_country,
        "freightTerms": "PREPAID",  # tanker grades almost always prepaid
        "incoterms": rng.choice(["FOB", "CIF", "CFR"]),
    }
    if rng.random() < hazmat_p:
        hz = _build_hazmat(commodity, rng)
        if hz:
            shipment["hazmat"] = hz
    # LNG carriers ALWAYS report cryogenic setpoint
    if "LNG" in commodity or "Natural Gas" in commodity:
        shipment["temperature"] = -162  # methane boil-off temp
    return shipment


def _build_bulker_shipment(
    ship_id: str,
    voyage_seq: int,
    idx: int,
    origin_country: str,
    rng: random.Random,
    locked_commodity: Optional[CommodityRow] = None,
) -> dict:
    row = locked_commodity or rng.choice(BULKER_COMMODITIES)
    commodity, hs, _, _ = row

    n_holds = rng.randint(5, 9)
    hold_numbers = [str(i + 1) for i in range(n_holds)]

    # 50k-180k DWT × loading factor
    tonnes = rng.randint(40_000, 160_000)
    gross_kg = tonnes * 1000
    net_kg = gross_kg
    # Stowage factor m³/t — varies by commodity
    sf = {
        "Iron Ore Fines": 0.4, "Iron Ore Pellets": 0.5,
        "Thermal Coal": 1.3, "Coking Coal": 1.4,
        "Wheat (HRS)": 1.3, "Corn (Yellow No. 2)": 1.4, "Soybeans": 1.4,
        "Urea Fertilizer (granular)": 1.0, "Phosphate Rock": 0.7,
        "Bauxite": 0.7, "Cement Clinker": 0.55, "Sugar (raw)": 1.2,
    }.get(commodity, 0.9)
    volume = int(tonnes * sf)

    value_per_t = {
        "Iron Ore Fines": 100, "Iron Ore Pellets": 130,
        "Thermal Coal": 110, "Coking Coal": 220,
        "Wheat (HRS)": 280, "Corn (Yellow No. 2)": 240, "Soybeans": 460,
        "Urea Fertilizer (granular)": 420, "Phosphate Rock": 220,
        "Bauxite": 50, "Cement Clinker": 70, "Sugar (raw)": 460,
    }.get(commodity, 200)
    value_usd = int(tonnes * value_per_t * rng.uniform(0.90, 1.10))

    return {
        "blNumber": _bl_number(ship_id, voyage_seq, idx),
        "bookingReference": _booking_ref(ship_id, idx),
        "customerCode": _customer_code(rng),
        "cargoForm": "bulk_dry",
        "holdNumbers": hold_numbers,
        "commodityDescription": commodity,
        "hsCode": hs,
        "packageType": "bulk",
        "packageCount": 1,
        "grossWeightKg": gross_kg,
        "netWeightKg": net_kg,
        "volumeCBM": volume,
        "declaredValueUSD": value_usd,
        "countryOfOrigin": origin_country,
        "freightTerms": rng.choice(["PREPAID", "COLLECT"]),
        "incoterms": rng.choices(["FOB", "CIF", "CFR"], weights=[55, 25, 20])[0],
    }


def _build_roro_shipment(
    ship_id: str,
    voyage_seq: int,
    idx: int,
    origin_country: str,
    rng: random.Random,
) -> dict:
    description, hs, unit_type = rng.choice(RORO_COMMODITIES)

    # Units per batch — passenger cars come in big batches, heavy equipment small
    unit_count = {
        "passenger_car": rng.randint(150, 800),
        "commercial_truck": rng.randint(40, 200),
        "heavy_equipment": rng.randint(5, 40),
        "agricultural_machinery": rng.randint(10, 80),
    }[unit_type]

    # Weight per unit (kg)
    avg_kg = {
        "passenger_car": 1500,
        "commercial_truck": 12000,
        "heavy_equipment": 35000,
        "agricultural_machinery": 8000,
    }[unit_type]
    gross_kg = int(unit_count * avg_kg * rng.uniform(0.9, 1.1))
    net_kg = gross_kg

    # Volume per unit (m³)
    avg_cbm = {
        "passenger_car": 12,
        "commercial_truck": 50,
        "heavy_equipment": 90,
        "agricultural_machinery": 60,
    }[unit_type]
    volume = int(unit_count * avg_cbm * rng.uniform(0.9, 1.05))

    # Value per unit (US$)
    avg_value = {
        "passenger_car": 28_000,
        "commercial_truck": 95_000,
        "heavy_equipment": 320_000,
        "agricultural_machinery": 180_000,
    }[unit_type]
    value_usd = int(unit_count * avg_value * rng.uniform(0.85, 1.10))

    return {
        "blNumber": _bl_number(ship_id, voyage_seq, idx),
        "bookingReference": _booking_ref(ship_id, idx),
        "customerCode": _customer_code(rng),
        "cargoForm": "vehicle_units",
        "unitCount": unit_count,
        "unitType": unit_type,
        "commodityDescription": description,
        "hsCode": hs,
        "packageType": "unit",
        "packageCount": unit_count,
        "grossWeightKg": gross_kg,
        "netWeightKg": net_kg,
        "volumeCBM": volume,
        "declaredValueUSD": value_usd,
        "countryOfOrigin": origin_country,
        "freightTerms": "PREPAID",
        "incoterms": rng.choices(["FOB", "CIF", "DAP"], weights=[45, 35, 20])[0],
    }


def _build_reefer_shipment(
    ship_id: str,
    voyage_seq: int,
    idx: int,
    origin_country: str,
    rng: random.Random,
) -> dict:
    """Dedicated reefer-ship shipment — always reefer containers, always
    temperature-controlled cargo. Routes through the container-form builder
    with the pool overridden to reefer commodities."""
    return _build_container_shipment(
        ship_id, voyage_seq, idx, origin_country, rng,
        pool=REEFER_COMMODITIES, force_reefer=True,
    )


def _build_breakbulk_shipment(
    ship_id: str,
    voyage_seq: int,
    idx: int,
    origin_country: str,
    rng: random.Random,
) -> dict:
    commodity, hs, hazmat_p, _ = rng.choice(BREAKBULK_COMMODITIES)

    package_type = rng.choices(
        ["pallet", "case", "drum", "bag", "unit"],
        weights=[40, 25, 10, 10, 15],
    )[0]
    package_count = rng.randint(20, 600)

    avg_kg_per = {
        "Steel Coils (hot-rolled)": 20_000,
        "Sawn Lumber": 1500,
        "Steel Pipes (large diameter)": 4000,
        "Wind Turbine Blades": 25_000,
        "Project Modules (industrial)": 18_000,
        "Copper Cathodes": 1500,
        "Aluminium Ingots": 750,
    }.get(commodity, 2000)
    gross_kg = int(package_count * avg_kg_per * rng.uniform(0.85, 1.10))
    net_kg = int(gross_kg * 0.97)

    cbm_per = {
        "Steel Coils (hot-rolled)": 3,
        "Sawn Lumber": 2.4,
        "Steel Pipes (large diameter)": 6,
        "Wind Turbine Blades": 200,
        "Project Modules (industrial)": 40,
        "Copper Cathodes": 0.18,
        "Aluminium Ingots": 0.28,
    }.get(commodity, 2)
    volume = max(1, int(package_count * cbm_per * rng.uniform(0.85, 1.0)))

    value_per_kg = {
        "Steel Coils (hot-rolled)": 0.85,
        "Sawn Lumber": 0.45,
        "Steel Pipes (large diameter)": 1.20,
        "Wind Turbine Blades": 25.0,
        "Project Modules (industrial)": 18.0,
        "Copper Cathodes": 9.0,
        "Aluminium Ingots": 2.6,
    }.get(commodity, 2.0)
    value_usd = int(net_kg * value_per_kg * rng.uniform(0.85, 1.15))

    shipment = {
        "blNumber": _bl_number(ship_id, voyage_seq, idx),
        "bookingReference": _booking_ref(ship_id, idx),
        "customerCode": _customer_code(rng),
        "cargoForm": "breakbulk",
        "commodityDescription": commodity,
        "hsCode": hs,
        "packageType": package_type,
        "packageCount": package_count,
        "grossWeightKg": gross_kg,
        "netWeightKg": net_kg,
        "volumeCBM": volume,
        "declaredValueUSD": value_usd,
        "countryOfOrigin": origin_country,
        "freightTerms": rng.choice(["PREPAID", "COLLECT"]),
        "incoterms": rng.choices(["FOB", "CIF", "CFR"], weights=[50, 30, 20])[0],
    }
    if rng.random() < hazmat_p:
        hz = _build_hazmat(commodity, rng)
        if hz:
            shipment["hazmat"] = hz
    return shipment


# ── Top-level entry point ────────────────────────────────────────────────────

def _seed_for_ship(ship_id: str) -> int:
    """Stable seed from a ship id so manifests don't jitter across reloads."""
    # Hash the id deterministically — use a small, stable hash so the seed
    # fits comfortably in an int.
    h = 0
    for ch in ship_id:
        h = (h * 131 + ord(ch)) & 0xFFFFFFFF
    return h


# ──────────────────────────────────────────────────────────────────────────────
# Truck manifests — CMR consignment notes
# ──────────────────────────────────────────────────────────────────────────────

# Commodity pool for road freight. Skews regional/inland/value-per-kg ranges
# different from sea: less mining bulk (those go ocean), more retail-ready,
# more time-critical (just-in-time auto parts), more last-mile.
# Format: (description, hs6, hazmat_p, reefer_p, value_per_kg_usd)
_TRUCK_COMMODITIES: list[tuple[str, str, float, float, float]] = [
    ("Retail consumer goods (mixed)",          "990000", 0.00, 0.05, 8.0),
    ("Packaged groceries",                     "210690", 0.00, 0.15, 3.5),
    ("Frozen meat & poultry",                  "020714", 0.00, 1.00, 8.0),
    ("Dairy products",                         "040690", 0.00, 1.00, 6.0),
    ("Fresh produce",                          "070200", 0.00, 1.00, 2.5),
    ("Pharmaceuticals (pallet)",               "300490", 0.05, 0.55, 95.0),
    ("Automotive parts (just-in-time)",        "870829", 0.00, 0.00, 11.0),
    ("Industrial chemicals (drummed)",         "382499", 0.70, 0.00, 4.5),
    ("Construction materials",                 "681011", 0.00, 0.00, 1.2),
    ("Furniture (flat-pack)",                  "940360", 0.00, 0.00, 7.0),
    ("Electronics / IT equipment",             "851712", 0.00, 0.00, 35.0),
    ("Building hardware",                      "732690", 0.00, 0.00, 4.0),
    ("Paper products",                         "481000", 0.00, 0.00, 2.0),
    ("Beverages (palletised)",                 "220300", 0.00, 0.00, 2.0),
    ("Cement / mortar (bagged)",               "252329", 0.00, 0.00, 0.4),
    ("Wood / timber",                          "440710", 0.00, 0.00, 0.8),
    ("Fuel (jerry cans / IBC)",                "271019", 1.00, 0.00, 1.5),
    ("Cleaning chemicals",                     "340290", 0.45, 0.00, 4.5),
    ("Apparel (boxed)",                        "620342", 0.00, 0.00, 18.0),
    ("E-commerce parcels (mixed)",             "990000", 0.00, 0.00, 14.0),
]

# ADR hazmat lookup — keyed by commodity description (mirrors HAZMAT_BY_COMMODITY
# above but uses ADR class strings and tunnel codes).
_ADR_BY_COMMODITY: dict[str, dict] = {
    "Industrial chemicals (drummed)":  {"unNumber": "UN3265", "adrClass": "8", "packingGroup": "II",  "properShippingName": "CORROSIVE LIQUID, ACIDIC, ORGANIC, N.O.S.", "tunnelCode": "E"},
    "Fuel (jerry cans / IBC)":         {"unNumber": "UN1202", "adrClass": "3", "packingGroup": "III", "properShippingName": "DIESEL FUEL",                                  "tunnelCode": "D"},
    "Cleaning chemicals":              {"unNumber": "UN1903", "adrClass": "8", "packingGroup": "III", "properShippingName": "DISINFECTANT, LIQUID, CORROSIVE, N.O.S.",     "tunnelCode": "E"},
    "Pharmaceuticals (pallet)":        {"unNumber": "UN3373", "adrClass": "6.2",                     "properShippingName": "BIOLOGICAL SUBSTANCE, CATEGORY B"},
}

# Trailer body distribution — pick one per truck based on commodity bias.
_TRAILER_TYPES = ["dry_van", "refrigerated", "curtainside", "flatbed", "tanker", "container", "drop_deck"]
_TRAILER_CAPACITY_M3 = {
    "dry_van":      90.0,
    "refrigerated": 75.0,    # insulation eats some interior
    "curtainside":  95.0,
    "flatbed":     120.0,    # open deck — no enclosure
    "tanker":       33.0,    # 33 m³ ≈ standard 24-25 t road tanker
    "container":    65.0,    # 40' STD shape
    "drop_deck":   100.0,
}


def _truck_registration(rng: random.Random) -> str:
    """Plausible-looking trailer plate. Mixes 3 letters + 4 digits — common
    EU plate format, country-agnostic enough to read as 'a truck' to anyone."""
    letters = "".join(rng.choice("ABCDEFGHJKLMNPRSTVWXYZ") for _ in range(3))
    digits  = rng.randint(1000, 9999)
    return f"{letters}-{digits}"


def _cmr_number(truck_id: str, idx: int = 0) -> str:
    digits = "".join(c for c in truck_id if c.isdigit())[-2:] or "00"
    if idx == 0:
        return f"CMR-PT-2026-{digits}M"  # master CMR
    return f"CMR-PT-2026-{digits}-{idx:03d}"


def _pick_trailer_for_truck(rng: random.Random) -> str:
    """Distribution skewed toward dry van + curtainside (the EU workhorses).
    Reefer + flatbed + container appear at realistic minority rates."""
    return rng.choices(
        _TRAILER_TYPES,
        weights=[35, 12, 25, 10, 8, 8, 2],  # dry van + curtainside dominate
    )[0]


def _commodity_pool_for_trailer(trailer: str) -> list:
    """Filter commodity pool by trailer compatibility — a reefer doesn't haul
    cement; a tanker doesn't haul furniture."""
    if trailer == "refrigerated":
        return [c for c in _TRUCK_COMMODITIES if c[3] > 0]  # reefer_p > 0
    if trailer == "tanker":
        return [c for c in _TRUCK_COMMODITIES if "Fuel" in c[0] or "chemicals" in c[0].lower()]
    if trailer == "flatbed":
        return [c for c in _TRUCK_COMMODITIES if c[0] in {"Construction materials", "Wood / timber", "Building hardware"}]
    # dry_van / curtainside / container / drop_deck — most things
    return [c for c in _TRUCK_COMMODITIES if c[3] == 0 and "Fuel" not in c[0]]


def _build_truck_shipment(
    truck_id: str,
    trip_seq: int,
    idx: int,
    origin_country: str,
    trailer: str,
    rng: random.Random,
) -> dict:
    pool = _commodity_pool_for_trailer(trailer) or _TRUCK_COMMODITIES
    commodity, hs, hazmat_p, reefer_p, value_per_kg = rng.choice(pool)
    hazmat_triggered = rng.random() < hazmat_p
    reefer_triggered = trailer == "refrigerated"

    # Package type & count — pallets dominate; drums for chemicals; bulk for tankers
    if trailer == "tanker":
        package_type, package_count = "bulk", 1
        gross_kg = rng.randint(18_000, 26_000)
        volume = round(gross_kg / 850, 1)  # ~850 kg/m³ avg liquid density
    elif "Fuel" in commodity:
        package_type = "drum"
        package_count = rng.randint(20, 60)
        gross_kg = package_count * 200  # 200 kg per drum
        volume = package_count * 0.22
    else:
        # Standard pallet load. EUR_pallet for EU origin, ISO otherwise.
        package_type = "EUR_pallet" if origin_country in {"DE", "FR", "NL", "BE", "IT", "ES", "AT"} else "ISO_pallet"
        package_count = rng.randint(8, 33)  # 33 EUR pallets = full 13.6m trailer
        # Weight per pallet typical 400-900 kg
        avg_kg_per = rng.randint(450, 850)
        gross_kg = package_count * avg_kg_per
        # Volume per EUR pallet ≈ 1.92 m³ stack
        volume = round(package_count * rng.uniform(1.4, 2.0), 1)

    net_kg = int(gross_kg * 0.93)  # palletisation tare
    value_usd = int(gross_kg * value_per_kg * rng.uniform(0.85, 1.20))

    shipment = {
        "consignmentNumber": _cmr_number(truck_id, idx),
        "bookingReference": f"BK-{truck_id[-2:]}-{idx:03d}",
        "customerCode": f"SH-{rng.randint(1000, 9999)}",
        "goodsDescription": commodity,
        "hsCode": hs,
        "packageType": package_type,
        "packageCount": package_count,
        "grossWeightKg": int(gross_kg),
        "netWeightKg": net_kg,
        "volumeM3": volume,
        "declaredValueUSD": value_usd,
        "countryOfOrigin": origin_country,
        "freightTerms": rng.choice(["PREPAID", "COLLECT"]),
    }
    # Cross-border? Add Incoterms.
    if rng.random() < 0.6:
        shipment["incoterms"] = rng.choices(["FOB", "CIF", "CFR", "DAP", "DDP", "EXW"], weights=[20, 15, 15, 30, 15, 5])[0]
    if reefer_triggered:
        shipment["temperature"] = rng.choice([-25, -20, -18, 2, 4, 6, 8])
    if hazmat_triggered and commodity in _ADR_BY_COMMODITY:
        shipment["adr"] = dict(_ADR_BY_COMMODITY[commodity])
    return shipment


def build_truck_manifest_for_truck(truck: dict) -> Optional[dict]:
    """Build a CMR-style manifest for one Petros truck. Deterministic per truck
    id so the manifest stays stable across reloads."""
    truck_id = truck["id"]
    rng = random.Random(_seed_for_ship(truck_id))   # reuse same id-hash helper
    origin_country = _country_for_port(truck.get("originCity") or truck.get("originPort"))
    if origin_country == "ZZ":
        # No port-based origin — try to infer from coords or fall back to a
        # generic EU code so HS data still makes sense.
        origin_country = "DE" if 0 < truck.get("longitude", 0) < 30 else "US"

    trailer = _pick_trailer_for_truck(rng)
    load_factor = rng.choices(["FTL", "LTL"], weights=[65, 35])[0]
    n_shipments = 1 if load_factor == "FTL" else rng.randint(2, 6)

    digits = "".join(c for c in truck_id if c.isdigit())
    trip_seq = int(digits) if digits else rng.randint(1000, 9999)

    shipments = [
        _build_truck_shipment(truck_id, trip_seq, i + 1, origin_country, trailer, rng)
        for i in range(n_shipments)
    ]

    total_gross   = sum(s["grossWeightKg"] for s in shipments)
    total_volume  = sum(s["volumeM3"] for s in shipments)
    total_value   = sum(s["declaredValueUSD"] for s in shipments)
    total_pallets = sum(s["packageCount"] for s in shipments
                        if s["packageType"] in {"EUR_pallet", "ISO_pallet"}) or None
    hazmat_present = any("adr" in s for s in shipments)
    reefer_present = any("temperature" in s for s in shipments)

    return {
        "consignmentNumber": _cmr_number(truck_id, 0),
        "tripNumber": f"PT-TRIP-{trip_seq:04d}",
        "issuedAt": "2026-05-25T00:00:00Z",
        "trailerType": trailer,
        "vehicleRegistration": _truck_registration(rng),
        "trailerCapacityM3": _TRAILER_CAPACITY_M3.get(trailer),
        "loadFactor": load_factor,
        "totalPallets": total_pallets,
        "totalGrossWeightKg": total_gross,
        "totalVolumeM3": round(total_volume, 1),
        "totalDeclaredValueUSD": total_value,
        "hazmatPresent": hazmat_present,
        "reeferPresent": reefer_present,
        "shipments": shipments,
    }


# ──────────────────────────────────────────────────────────────────────────────
# Plane manifests — IATA Air Waybills
# ──────────────────────────────────────────────────────────────────────────────

# Air freight skews high-value low-weight time-sensitive. Format:
# (description, hs6, dgr_p, perishable_p, val_per_kg_usd, default_shc)
_AIR_COMMODITIES: list[tuple[str, str, float, float, float, list[str]]] = [
    ("Pharmaceuticals (cold chain)",       "300490", 0.05, 1.00,  220.0, ["PER", "COL"]),
    ("Pharmaceuticals (controlled)",       "300490", 0.10, 0.50,  340.0, ["VAL"]),
    ("Consumer electronics",               "851712", 0.00, 0.00,   95.0, []),
    ("Semiconductors / wafers",            "854231", 0.00, 0.00,  680.0, ["VAL"]),
    ("Lithium-ion batteries",              "850760", 1.00, 0.00,   65.0, ["DGR"]),
    ("E-commerce parcels (express)",       "990000", 0.00, 0.00,   45.0, []),
    ("Fresh seafood",                      "030339", 0.00, 1.00,   28.0, ["PER", "COL"]),
    ("Fresh cut flowers",                  "060311", 0.00, 1.00,   18.0, ["PER", "COL"]),
    ("Aircraft parts (AOG)",               "880330", 0.00, 0.00,  280.0, ["VAL", "HEA"]),
    ("Automotive parts (JIT)",             "870829", 0.00, 0.00,   55.0, []),
    ("Jewellery / watches",                "711319", 0.00, 0.00, 3200.0, ["VAL", "VUN"]),
    ("Industrial machinery (high-tech)",   "847989", 0.00, 0.00,  130.0, ["HEA"]),
    ("Diagnostic samples",                 "300290", 0.10, 0.40,   75.0, ["PER"]),
    ("Vaccines (deep-cold)",               "300220", 0.00, 1.00,  450.0, ["PER", "FRO"]),
    ("Couriered documents",                "490199", 0.00, 0.00,   12.0, []),
    ("Apparel (premium / fashion)",        "620342", 0.00, 0.00,   42.0, []),
    ("Lab chemicals (ground transport segment)", "382499", 0.85, 0.00, 55.0, ["DGR"]),
    ("Aerospace parts",                    "880330", 0.00, 0.00,  180.0, ["HEA", "VAL"]),
]

# IATA DGR by commodity. Packing instructions are real PIs from the IATA DGR.
_DGR_BY_COMMODITY: dict[str, dict] = {
    "Lithium-ion batteries":           {"unNumber": "UN3480", "dgrClass": "9", "properShippingName": "LITHIUM ION BATTERIES", "packingInstruction": "965", "cargoAircraftOnly": True},
    "Pharmaceuticals (controlled)":    {"unNumber": "UN3373", "dgrClass": "6.2", "properShippingName": "BIOLOGICAL SUBSTANCE, CATEGORY B", "packingInstruction": "650"},
    "Lab chemicals (ground transport segment)": {"unNumber": "UN1993", "dgrClass": "3", "packingGroup": "II", "properShippingName": "FLAMMABLE LIQUID, N.O.S.", "packingInstruction": "353"},
    "Pharmaceuticals (cold chain)":    {"unNumber": "UN3373", "dgrClass": "6.2", "properShippingName": "BIOLOGICAL SUBSTANCE, CATEGORY B", "packingInstruction": "650"},
    "Diagnostic samples":              {"unNumber": "UN3373", "dgrClass": "6.2", "properShippingName": "BIOLOGICAL SUBSTANCE, CATEGORY B", "packingInstruction": "650"},
}


def _awb_number(prefix: str, plane_id: str, idx: int = 0) -> str:
    """IATA-format AWB: 3-digit airline prefix + 8-digit serial + check.
    For Petros Air we use the fictional "888" prefix."""
    digits = "".join(c for c in plane_id if c.isdigit())[-2:] or "00"
    serial = int(digits) * 100000 + idx * 1000 + 1
    # 8-digit zero-padded, plus a check digit (just last digit of serial for fake)
    return f"{prefix}-{serial:08d}"


def _pick_uld(weight_kg: int, volume_m3: float, rng: random.Random) -> Optional[str]:
    """Pick a ULD code that can physically hold this shipment, or 'loose'.
    Mirrors how forwarders pick build-up containers."""
    if weight_kg < 200 and volume_m3 < 1.5:
        return rng.choice(["AKE", "loose"])
    if weight_kg < 1500 and volume_m3 < 4.0:
        return rng.choice(["LD3", "LD7", "PAG"])
    if weight_kg < 4500 and volume_m3 < 5.0:
        return rng.choice(["LD9", "PMC"])
    if weight_kg < 7000:
        return "LD11"
    return "PMC"


def _build_air_shipment(
    plane_id: str,
    flight_no: str,
    idx: int,
    origin_country: str,
    rng: random.Random,
) -> dict:
    commodity, hs, dgr_p, _, value_per_kg, default_shc = rng.choice(_AIR_COMMODITIES)
    dgr_triggered = rng.random() < dgr_p

    # Pieces (PCS) — usually small for air (typical airfreight load 5-200 pcs)
    pieces = rng.choices(
        [rng.randint(1, 5), rng.randint(5, 30), rng.randint(30, 200)],
        weights=[15, 60, 25],
    )[0]
    # Weight per piece varies — pharma ~30 kg, semi ~5 kg, machinery ~150 kg
    avg_kg_per = {
        "Pharmaceuticals (cold chain)": 30, "Pharmaceuticals (controlled)": 25,
        "Consumer electronics": 12, "Semiconductors / wafers": 6,
        "Lithium-ion batteries": 18, "E-commerce parcels (express)": 4,
        "Fresh seafood": 22, "Fresh cut flowers": 14,
        "Aircraft parts (AOG)": 75, "Automotive parts (JIT)": 22,
        "Jewellery / watches": 2, "Industrial machinery (high-tech)": 180,
        "Diagnostic samples": 8, "Vaccines (deep-cold)": 18,
        "Couriered documents": 1, "Apparel (premium / fashion)": 12,
        "Lab chemicals (ground transport segment)": 25,
        "Aerospace parts": 95,
    }.get(commodity, 20)
    gross_kg = int(pieces * avg_kg_per * rng.uniform(0.85, 1.15))

    # Volume — typically ~6 m³/t for air-freight density
    volume = round(gross_kg / rng.uniform(140, 200), 2)
    # Chargeable weight = max(gross, volume * 167 kg/m³ density ratio per IATA)
    chargeable = max(gross_kg, int(volume * 167))

    value_usd = int(gross_kg * value_per_kg * rng.uniform(0.85, 1.20))
    customs_value = int(value_usd * rng.uniform(0.85, 1.0))

    shc = list(default_shc)
    if dgr_triggered and "DGR" not in shc:
        shc.insert(0, "DGR")

    shipment = {
        "houseAwbNumber": _awb_number("888", plane_id, idx),
        "bookingReference": f"AWB-BK-{plane_id[-2:]}-{idx:03d}",
        "customerCode": f"SH-{rng.randint(1000, 9999)}",
        "goodsDescription": commodity,
        "hsCode": hs,
        "pieces": pieces,
        "grossWeightKg": gross_kg,
        "chargeableWeightKg": chargeable,
        "volumeM3": volume,
        "uldType": _pick_uld(gross_kg, volume, rng),
        "specialHandlingCodes": shc,
        "declaredValueUSD": value_usd,
        "declaredValueForCustomsUSD": customs_value,
        "countryOfOrigin": origin_country,
        "freightBasis": rng.choice(["P", "C", "X"]),
    }
    if dgr_triggered and commodity in _DGR_BY_COMMODITY:
        shipment["dgr"] = dict(_DGR_BY_COMMODITY[commodity])
    if "COL" in shc or "FRO" in shc:
        shipment["temperature"] = -20 if "FRO" in shc else rng.choice([2, 4, 6, 8])
    return shipment


def build_plane_manifest_for_plane(plane: dict) -> Optional[dict]:
    """Build an IATA Air Waybill manifest for one Petros plane."""
    plane_id = plane["id"]
    rng = random.Random(_seed_for_ship(plane_id))
    # Country of origin = departure airport country (best-effort via IATA hint;
    # if we don't know, default to "US" so HS data still resolves cleanly).
    origin_country = {
        "JP": "JP", "US": "US", "DE": "DE", "FR": "FR", "AE": "AE",
        "GB": "GB", "NL": "NL", "SG": "SG", "CN": "CN", "BR": "BR",
        "IT": "IT", "AU": "AU",
    }.get((plane.get("departureAirport") or "")[:2].upper(), "US")

    digits = "".join(c for c in plane_id if c.isdigit())
    trip_seq = int(digits) if digits else rng.randint(1000, 9999)
    flight_no = plane.get("flightNumber") or f"PTA{trip_seq:03d}"
    n_shipments = rng.randint(3, 9)

    shipments = [
        _build_air_shipment(plane_id, flight_no, i + 1, origin_country, rng)
        for i in range(n_shipments)
    ]

    total_pieces     = sum(s["pieces"] for s in shipments)
    total_gross      = sum(s["grossWeightKg"] for s in shipments)
    total_chargeable = sum(s["chargeableWeightKg"] for s in shipments)
    total_volume     = round(sum(s["volumeM3"] for s in shipments), 2)
    total_value      = sum(s["declaredValueUSD"] for s in shipments)
    uld_count        = sum(1 for s in shipments if (s.get("uldType") or "loose") != "loose")

    dgr_onboard       = any("dgr" in s for s in shipments)
    perish_onboard    = any("PER" in s.get("specialHandlingCodes", []) for s in shipments)
    val_onboard       = any("VAL" in s.get("specialHandlingCodes", []) for s in shipments)
    coldchain_onboard = any(("COL" in s.get("specialHandlingCodes", [])) or ("FRO" in s.get("specialHandlingCodes", [])) for s in shipments)

    return {
        "masterAwbNumber": _awb_number("888", plane_id, 0),
        "flightNumber": flight_no,
        "flightDate": "2026-05-25",
        "issuedAt": "2026-05-25T00:00:00Z",
        "aircraftRegistration": f"PT-{rng.randrange(100, 999)}",
        "totalPieces": total_pieces,
        "totalGrossWeightKg": total_gross,
        "totalChargeableWeightKg": total_chargeable,
        "totalVolumeM3": total_volume,
        "totalDeclaredValueUSD": total_value,
        "uldCount": uld_count or None,
        "dangerousGoodsOnboard": dgr_onboard,
        "perishablesOnboard": perish_onboard,
        "valuableOnboard": val_onboard,
        "coldChainOnboard": coldchain_onboard,
        "shipments": shipments,
    }


# ──────────────────────────────────────────────────────────────────────────────


def build_manifest_for_ship(ship: dict) -> Optional[dict]:
    """Build one CargoManifest dict for a Petros ship row.

    The ship dict must carry `id` and `vesselSubType`. If `vesselSubType` is
    missing the function returns None — the caller treats that as "no
    manifest for this ship" rather than guessing a default.
    """
    sub_type = ship.get("vesselSubType")
    if not sub_type:
        return None

    ship_id = ship["id"]
    rng = random.Random(_seed_for_ship(ship_id))
    origin_country = _country_for_port(ship.get("originPort"))

    # Voyage sequence — derived from ship id so it stays stable
    digits = "".join(c for c in ship_id if c.isdigit())
    voyage_seq = int(digits) if digits else rng.randint(1000, 9999)

    # Shipment count per sub-type
    n_shipments = {
        "container": rng.randint(4, 12),
        "tanker":    rng.randint(1, 2),
        "bulker":    rng.randint(1, 2),
        "reefer":    rng.randint(2, 4),
        "roro":      rng.randint(1, 4),
        "breakbulk": rng.randint(5, 15),
    }.get(sub_type, 4)

    shipments: list[dict] = []
    # Tankers/bulkers lock a single commodity across the voyage's shipments —
    # a VLCC doesn't load crude AND gasoline in the same voyage.
    locked: Optional[CommodityRow] = None
    if sub_type == "tanker":
        locked = rng.choice(TANKER_COMMODITIES)
    elif sub_type == "bulker":
        locked = rng.choice(BULKER_COMMODITIES)

    for i in range(1, n_shipments + 1):
        if sub_type == "container":
            shipments.append(_build_container_shipment(ship_id, voyage_seq, i, origin_country, rng))
        elif sub_type == "tanker":
            shipments.append(_build_tanker_shipment(ship_id, voyage_seq, i, origin_country, rng, locked))
        elif sub_type == "bulker":
            shipments.append(_build_bulker_shipment(ship_id, voyage_seq, i, origin_country, rng, locked))
        elif sub_type == "reefer":
            shipments.append(_build_reefer_shipment(ship_id, voyage_seq, i, origin_country, rng))
        elif sub_type == "roro":
            shipments.append(_build_roro_shipment(ship_id, voyage_seq, i, origin_country, rng))
        elif sub_type == "breakbulk":
            shipments.append(_build_breakbulk_shipment(ship_id, voyage_seq, i, origin_country, rng))

    # Aggregate stats
    total_gross = sum(s["grossWeightKg"] for s in shipments)
    total_volume = sum(s["volumeCBM"] for s in shipments)
    total_value = sum(s["declaredValueUSD"] for s in shipments)
    hazmat_present = any("hazmat" in s for s in shipments)
    reefer_present = any(s.get("cargoForm") == "reefer_containers" for s in shipments)
    total_containers = sum(s.get("containerCount", 0) for s in shipments) or None
    total_units = sum(s.get("unitCount", 0) for s in shipments) or None

    manifest = {
        "manifestNumber": f"MAN-PT-2026-{voyage_seq:05d}",
        "voyageNumber": f"PT-VYG-{voyage_seq:04d}",
        "issuedAt": "2026-05-25T00:00:00Z",
        "vesselSubType": sub_type,
        "totalGrossWeightKg": total_gross,
        "totalVolumeCBM": total_volume,
        "totalDeclaredValueUSD": total_value,
        "hazmatPresent": hazmat_present,
        "reeferPresent": reefer_present,
        "shipments": shipments,
    }
    if total_containers:
        manifest["totalContainers"] = total_containers
    if total_units:
        manifest["totalUnits"] = total_units
    return manifest

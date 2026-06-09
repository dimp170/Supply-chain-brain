"""Per-ship cargo manifest -> styled .xlsx export.

Produces a workbook that reads like a real freight-forwarder document:
  Sheet 1 (Manifest)  — vessel + voyage header band, aggregate totals.
  Sheet 2 (Shipments) — one row per Bill of Lading with all fields
                         flattened. Hazmat rows tinted red; reefer rows
                         tinted blue. Frozen header.

Returns the workbook as a bytes blob — the FastAPI endpoint streams it
back with the Excel content-type so the browser saves it as a file.

No formulas — pure data export. The manifest is canonical at the moment
of generation; nothing in the workbook needs recalculation. (If we ever
add per-shipment derived fields like value-per-kg, those should be
formulas per the xlsx skill guidance.)
"""
from __future__ import annotations

import io
from typing import Any

from openpyxl import Workbook
from openpyxl.styles import (
    Alignment, Border, Fill, Font, PatternFill, Side,
)
from openpyxl.utils import get_column_letter


# ── Visual tokens — match the dark UI accent so the spreadsheet feels
#    related to the on-screen panel without being un-Excel-like. ────────
_FONT = "Arial"

_HEADER_FILL    = PatternFill("solid", start_color="0F172A", end_color="0F172A")   # slate-900
_SECTION_FILL   = PatternFill("solid", start_color="1E293B", end_color="1E293B")   # slate-800
_COL_HEADER_FILL = PatternFill("solid", start_color="334155", end_color="334155")  # slate-700
_HAZMAT_FILL    = PatternFill("solid", start_color="FEE2E2", end_color="FEE2E2")   # red-100
_REEFER_FILL    = PatternFill("solid", start_color="DBEAFE", end_color="DBEAFE")   # blue-100

_WHITE_BOLD    = Font(name=_FONT, size=14, color="FFFFFF", bold=True)
_WHITE_SUB     = Font(name=_FONT, size=10, color="CBD5E1")
_SECTION_FONT  = Font(name=_FONT, size=11, color="FFFFFF", bold=True)
_COL_HDR_FONT  = Font(name=_FONT, size=10, color="FFFFFF", bold=True)
_LABEL_FONT    = Font(name=_FONT, size=10, color="64748B", bold=False)
_VALUE_FONT    = Font(name=_FONT, size=11, color="0F172A", bold=False)
_VALUE_BOLD    = Font(name=_FONT, size=11, color="0F172A", bold=True)
_BODY_FONT     = Font(name=_FONT, size=10, color="0F172A")

_LEFT_ALIGN  = Alignment(horizontal="left",  vertical="center", wrap_text=True)
_RIGHT_ALIGN = Alignment(horizontal="right", vertical="center")
_CENTER      = Alignment(horizontal="center", vertical="center")

_THIN = Side(border_style="thin", color="E2E8F0")  # slate-200
_BORDER_BOX = Border(left=_THIN, right=_THIN, top=_THIN, bottom=_THIN)


# ── Plain-language lookups (kept in sync with frontend data/cargoLabels.ts). ──

_IMDG_CLASS_LABELS = {
    "1":   "Explosives",
    "2.1": "Flammable gases",
    "2.2": "Non-flammable, non-toxic gases",
    "2.3": "Toxic gases",
    "3":   "Flammable liquids",
    "4.1": "Flammable solids",
    "4.2": "Spontaneously combustible",
    "4.3": "Dangerous when wet",
    "5.1": "Oxidizing substances",
    "5.2": "Organic peroxides",
    "6.1": "Toxic substances",
    "6.2": "Infectious substances",
    "7":   "Radioactive materials",
    "8":   "Corrosive substances",
    "9":   "Miscellaneous dangerous goods",
}
_INCOTERM_LABELS = {
    "EXW": "Ex Works",
    "FOB": "Free On Board",
    "CFR": "Cost and Freight",
    "CIF": "Cost, Insurance and Freight",
    "DAP": "Delivered at Place",
    "DDP": "Delivered Duty Paid",
}
_FREIGHT_LABELS = {
    "PREPAID": "Prepaid (shipper)",
    "COLLECT": "Collect (consignee)",
}
_SUBTYPE_LABELS = {
    "container": "Container ship",
    "tanker":    "Tanker",
    "bulker":    "Bulk carrier",
    "reefer":    "Refrigerated cargo",
    "roro":      "RoRo (vehicle carrier)",
    "breakbulk": "General cargo / breakbulk",
}


def _imdg_label(cls: str | None) -> str:
    if not cls:
        return ""
    return f"{_IMDG_CLASS_LABELS.get(cls, '')} (Class {cls})".strip()


def _incoterm_label(code: str | None) -> str:
    if not code:
        return ""
    full = _INCOTERM_LABELS.get(code, "")
    return f"{full} ({code})" if full else code


# ── Sheet 1: Manifest summary ─────────────────────────────────────────────

def _write_summary_sheet(ws, ship: dict, m: dict) -> None:
    """Two-column label/value layout with a header band on top."""
    # Layout: column A = label, column B = value
    ws.column_dimensions["A"].width = 26
    ws.column_dimensions["B"].width = 42

    # Header band — row 1 and 2 merged across A:B, two-line title.
    ws.merge_cells("A1:B1")
    ws["A1"] = "CARGO MANIFEST"
    ws["A1"].font = _WHITE_BOLD
    ws["A1"].fill = _HEADER_FILL
    ws["A1"].alignment = _LEFT_ALIGN
    ws.row_dimensions[1].height = 30

    ws.merge_cells("A2:B2")
    subtitle = f"{ship.get('name', '')} · {_SUBTYPE_LABELS.get(m.get('vesselSubType', ''), m.get('vesselSubType', ''))}"
    ws["A2"] = subtitle
    ws["A2"].font = _WHITE_SUB
    ws["A2"].fill = _HEADER_FILL
    ws["A2"].alignment = _LEFT_ALIGN
    ws.row_dimensions[2].height = 22

    # Section: vessel / voyage identification
    row = 4
    row = _write_section(ws, row, "VESSEL & VOYAGE")
    row = _write_field(ws, row, "Vessel name",       ship.get("name", ""))
    row = _write_field(ws, row, "Vessel sub-type",   _SUBTYPE_LABELS.get(m.get("vesselSubType", ""), m.get("vesselSubType", "")))
    row = _write_field(ws, row, "Manifest number",   m.get("manifestNumber", ""), mono=True)
    row = _write_field(ws, row, "Voyage number",     m.get("voyageNumber", ""),   mono=True)
    row = _write_field(ws, row, "Issued",            m.get("issuedAt", ""))
    row = _write_field(ws, row, "Origin port",       ship.get("originPort", ""))
    row = _write_field(ws, row, "Destination port",  ship.get("destinationPort", ""))
    if ship.get("vesselLength"):
        row = _write_field(ws, row, "Vessel length",  f"{ship['vesselLength']} m")
    if ship.get("draught"):
        row = _write_field(ws, row, "Draught",        f"{ship['draught']} m")
    if ship.get("imoNumber"):
        row = _write_field(ws, row, "IMO number",     str(ship["imoNumber"]), mono=True)
    if ship.get("callSign"):
        row = _write_field(ws, row, "Call sign",      ship["callSign"], mono=True)

    # Section: aggregate totals
    row += 1
    row = _write_section(ws, row, "AGGREGATE TOTALS")
    if m.get("totalContainers"):
        row = _write_field(ws, row, "Total containers", f"{m['totalContainers']:,} TEU")
    if m.get("totalUnits"):
        row = _write_field(ws, row, "Total vehicle units", f"{m['totalUnits']:,}")
    row = _write_field(ws, row, "Total gross weight",  _format_weight(m.get("totalGrossWeightKg", 0)))
    row = _write_field(ws, row, "Total volume",        f"{m.get('totalVolumeCBM', 0):,} m³")
    row = _write_field(
        ws, row, "Total declared value",
        f"${m.get('totalDeclaredValueUSD', 0):,}",
        value_bold=True,
    )
    row = _write_field(ws, row, "Shipments (B/Ls)",    str(len(m.get("shipments", []))))
    row = _write_field(ws, row, "Hazmat on board",     "Yes" if m.get("hazmatPresent") else "No")
    row = _write_field(ws, row, "Refrigerated cargo",  "Yes" if m.get("reeferPresent") else "No")


def _write_section(ws, row: int, title: str) -> int:
    """Section header strip spanning A:B."""
    ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=2)
    cell = ws.cell(row=row, column=1, value=title)
    cell.font = _SECTION_FONT
    cell.fill = _SECTION_FILL
    cell.alignment = _LEFT_ALIGN
    ws.row_dimensions[row].height = 20
    return row + 1


def _write_field(ws, row: int, label: str, value: Any, *, mono: bool = False, value_bold: bool = False) -> int:
    label_cell = ws.cell(row=row, column=1, value=label)
    label_cell.font = _LABEL_FONT
    label_cell.alignment = _LEFT_ALIGN

    value_cell = ws.cell(row=row, column=2, value=value)
    value_cell.font = _VALUE_BOLD if value_bold else _VALUE_FONT
    if mono:
        value_cell.font = Font(name="Consolas", size=11, color="0F172A", bold=value_bold)
    value_cell.alignment = _LEFT_ALIGN
    return row + 1


def _format_weight(kg: int | float) -> str:
    if kg >= 1000:
        return f"{kg / 1000:,.1f} t"
    return f"{kg:,} kg"


# ── Sheet 2: Shipments ────────────────────────────────────────────────────

# Column spec — (header, width). Order is rendered left-to-right.
_SHIPMENT_COLS: list[tuple[str, int]] = [
    ("B/L number",        20),
    ("Booking ref",       16),
    ("Customer ref",      14),
    ("Cargo form",        20),
    ("Commodity",         38),
    ("HS code",           10),
    ("Country origin",    14),
    ("Container type",    18),
    ("Containers",        12),
    ("Container IDs",     46),
    ("Tanks / Holds",     20),
    ("Vehicle type",      22),
    ("Units",             10),
    ("Gross weight (kg)", 17),
    ("Net weight (kg)",   17),
    ("Volume (m³)",       13),
    ("Declared value (USD)", 20),
    ("Hazmat UN",         11),
    ("IMDG class",        26),
    ("Packing group",     14),
    ("Proper shipping name", 36),
    ("Temperature (°C)",  16),
    ("Incoterms",         28),
    ("Freight terms",     22),
]


def _write_shipments_sheet(ws, m: dict) -> None:
    """One row per B/L. Frozen header. Hazmat rows tinted red, reefer blue.

    Columns that don't apply to a given cargo form (e.g. Container IDs on a
    tanker row) are left blank — easier to scan than zero-padding."""
    # Header row
    for col_idx, (header, width) in enumerate(_SHIPMENT_COLS, start=1):
        cell = ws.cell(row=1, column=col_idx, value=header)
        cell.font = _COL_HDR_FONT
        cell.fill = _COL_HEADER_FILL
        cell.alignment = _CENTER
        cell.border = _BORDER_BOX
        ws.column_dimensions[get_column_letter(col_idx)].width = width
    ws.row_dimensions[1].height = 28

    # Freeze the header so it stays visible as the reader scrolls.
    ws.freeze_panes = "A2"

    shipments = m.get("shipments", [])
    for r_offset, s in enumerate(shipments, start=2):
        cargo_form = s.get("cargoForm", "")
        is_hazmat = bool(s.get("hazmat"))
        is_reefer = (cargo_form == "reefer_containers") or (s.get("temperature") is not None and cargo_form != "bulk_liquid")
        row_fill = _HAZMAT_FILL if is_hazmat else (_REEFER_FILL if is_reefer else None)

        values = [
            s.get("blNumber", ""),
            s.get("bookingReference", ""),
            s.get("customerCode", ""),
            cargo_form.replace("_", " "),
            s.get("commodityDescription", ""),
            s.get("hsCode", ""),
            s.get("countryOfOrigin", ""),
            s.get("containerType", ""),
            s.get("containerCount", "") if s.get("containerCount") else "",
            ", ".join(s.get("containerIds", []) or []),
            ", ".join(s.get("tankNumbers", []) or s.get("holdNumbers", []) or []),
            s.get("unitType", "").replace("_", " "),
            s.get("unitCount", "") if s.get("unitCount") else "",
            s.get("grossWeightKg", 0),
            s.get("netWeightKg", 0),
            s.get("volumeCBM", 0),
            s.get("declaredValueUSD", 0),
            (s.get("hazmat") or {}).get("unNumber", ""),
            _imdg_label((s.get("hazmat") or {}).get("imdgClass")),
            (s.get("hazmat") or {}).get("packingGroup", ""),
            (s.get("hazmat") or {}).get("properShippingName", ""),
            s.get("temperature", "") if s.get("temperature") is not None else "",
            _incoterm_label(s.get("incoterms")),
            _FREIGHT_LABELS.get(s.get("freightTerms", ""), s.get("freightTerms", "")),
        ]

        for col_idx, value in enumerate(values, start=1):
            cell = ws.cell(row=r_offset, column=col_idx, value=value)
            cell.font = _BODY_FONT
            cell.border = _BORDER_BOX
            # Right-align numerics; left-align text; centre status flags.
            header_label = _SHIPMENT_COLS[col_idx - 1][0]
            if any(token in header_label for token in ("weight", "Volume", "value", "Temperature", "Units", "Containers")):
                cell.alignment = _RIGHT_ALIGN
            else:
                cell.alignment = _LEFT_ALIGN
            if row_fill:
                cell.fill = row_fill

        # Number formats — only on cells that hold numerics.
        ws.cell(row=r_offset, column=14).number_format = "#,##0"          # Gross kg
        ws.cell(row=r_offset, column=15).number_format = "#,##0"          # Net kg
        ws.cell(row=r_offset, column=16).number_format = "#,##0"          # Volume m³
        ws.cell(row=r_offset, column=17).number_format = '"$"#,##0'       # Declared value
        ws.row_dimensions[r_offset].height = 24


# ── Public entry point ────────────────────────────────────────────────────

def build_manifest_xlsx(ship: dict, manifest: dict) -> bytes:
    """Build the .xlsx workbook for a single ship's manifest. Returns the
    file contents as bytes — caller streams them back to the browser."""
    wb = Workbook()

    summary = wb.active
    summary.title = "Manifest"
    _write_summary_sheet(summary, ship, manifest)

    shipments = wb.create_sheet("Shipments")
    _write_shipments_sheet(shipments, manifest)

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# ─── Truck CMR workbook ───────────────────────────────────────────────────────

_TRAILER_LABELS = {
    "dry_van":      "Dry van", "refrigerated": "Refrigerated", "curtainside": "Curtainside",
    "flatbed":      "Flatbed", "tanker":       "Tanker",       "container":   "Container skeletal",
    "drop_deck":    "Drop deck",
}


def _write_truck_summary(ws, truck: dict, m: dict) -> None:
    ws.column_dimensions["A"].width = 26
    ws.column_dimensions["B"].width = 42

    ws.merge_cells("A1:B1")
    ws["A1"] = "CMR CONSIGNMENT NOTE"
    ws["A1"].font = _WHITE_BOLD; ws["A1"].fill = _HEADER_FILL; ws["A1"].alignment = _LEFT_ALIGN
    ws.row_dimensions[1].height = 30

    ws.merge_cells("A2:B2")
    ws["A2"] = f"{truck.get('name', '')} · road freight"
    ws["A2"].font = _WHITE_SUB; ws["A2"].fill = _HEADER_FILL; ws["A2"].alignment = _LEFT_ALIGN
    ws.row_dimensions[2].height = 22

    row = 4
    row = _write_section(ws, row, "VEHICLE & TRIP")
    row = _write_field(ws, row, "Truck name",          truck.get("name", ""))
    row = _write_field(ws, row, "Vehicle registration", m.get("vehicleRegistration", ""), mono=True)
    row = _write_field(ws, row, "Trailer type",         _TRAILER_LABELS.get(m.get("trailerType", ""), m.get("trailerType", "")))
    if m.get("trailerCapacityM3"):
        row = _write_field(ws, row, "Trailer capacity",  f"{m['trailerCapacityM3']} m³")
    row = _write_field(ws, row, "Load type",            "FTL — Full Truckload" if m.get("loadFactor") == "FTL" else "LTL — Less than Truckload")
    row = _write_field(ws, row, "Master CMR",           m.get("consignmentNumber", ""), mono=True)
    row = _write_field(ws, row, "Trip number",          m.get("tripNumber", ""), mono=True)
    row = _write_field(ws, row, "Issued",               m.get("issuedAt", ""))

    row += 1
    row = _write_section(ws, row, "AGGREGATE TOTALS")
    if m.get("totalPallets"):
        row = _write_field(ws, row, "Pallets",          f"{m['totalPallets']:,}")
    row = _write_field(ws, row, "Total gross weight",   _format_weight(m.get("totalGrossWeightKg", 0)))
    row = _write_field(ws, row, "Total volume",         f"{m.get('totalVolumeM3', 0):,} m³")
    row = _write_field(ws, row, "Total declared value", f"${m.get('totalDeclaredValueUSD', 0):,}", value_bold=True)
    row = _write_field(ws, row, "Shipments (CMRs)",     str(len(m.get("shipments", []))))
    row = _write_field(ws, row, "ADR hazmat on board",  "Yes" if m.get("hazmatPresent") else "No")
    row = _write_field(ws, row, "Refrigerated cargo",   "Yes" if m.get("reeferPresent") else "No")


_TRUCK_COLS = [
    ("CMR number", 22), ("Booking ref", 16), ("Customer ref", 14),
    ("Commodity", 38), ("HS code", 10), ("Country origin", 14),
    ("Package type", 16), ("Packages", 10),
    ("Gross weight (kg)", 17), ("Net weight (kg)", 17), ("Volume (m³)", 13),
    ("Declared value (USD)", 20),
    ("ADR UN", 11), ("ADR class", 26), ("Packing group", 14), ("Tunnel code", 12),
    ("Proper shipping name", 36),
    ("Temperature (°C)", 16),
    ("Incoterms", 28), ("Freight terms", 22),
]


def _write_truck_shipments(ws, m: dict) -> None:
    for col_idx, (header, width) in enumerate(_TRUCK_COLS, start=1):
        c = ws.cell(row=1, column=col_idx, value=header)
        c.font = _COL_HDR_FONT; c.fill = _COL_HEADER_FILL; c.alignment = _CENTER; c.border = _BORDER_BOX
        ws.column_dimensions[get_column_letter(col_idx)].width = width
    ws.row_dimensions[1].height = 28
    ws.freeze_panes = "A2"

    for r, s in enumerate(m.get("shipments", []), start=2):
        is_hazmat = bool(s.get("adr"))
        is_reefer = s.get("temperature") is not None
        fill = _HAZMAT_FILL if is_hazmat else (_REEFER_FILL if is_reefer else None)

        adr = s.get("adr") or {}
        vals = [
            s.get("consignmentNumber", ""), s.get("bookingReference", ""), s.get("customerCode", ""),
            s.get("goodsDescription", ""), s.get("hsCode", ""), s.get("countryOfOrigin", ""),
            s.get("packageType", "").replace("_", " "), s.get("packageCount", 0),
            s.get("grossWeightKg", 0), s.get("netWeightKg", 0), s.get("volumeM3", 0),
            s.get("declaredValueUSD", 0),
            adr.get("unNumber", ""), _imdg_label(adr.get("adrClass")),
            adr.get("packingGroup", ""), adr.get("tunnelCode", ""),
            adr.get("properShippingName", ""),
            s.get("temperature", "") if s.get("temperature") is not None else "",
            _incoterm_label(s.get("incoterms")) if s.get("incoterms") else "",
            _FREIGHT_LABELS.get(s.get("freightTerms", ""), s.get("freightTerms", "")),
        ]
        for col_idx, val in enumerate(vals, start=1):
            cell = ws.cell(row=r, column=col_idx, value=val)
            cell.font = _BODY_FONT; cell.border = _BORDER_BOX
            cell.alignment = _RIGHT_ALIGN if col_idx in {8, 9, 10, 11, 12, 18} else _LEFT_ALIGN
            if fill: cell.fill = fill
        ws.cell(row=r, column=8 ).number_format = "#,##0"
        ws.cell(row=r, column=9 ).number_format = "#,##0"
        ws.cell(row=r, column=10).number_format = "#,##0"
        ws.cell(row=r, column=11).number_format = "#,##0.0"
        ws.cell(row=r, column=12).number_format = '"$"#,##0'
        ws.row_dimensions[r].height = 24


def build_truck_manifest_xlsx(truck: dict, manifest: dict) -> bytes:
    wb = Workbook()
    summary = wb.active; summary.title = "CMR"
    _write_truck_summary(summary, truck, manifest)
    shipments = wb.create_sheet("Shipments")
    _write_truck_shipments(shipments, manifest)
    buf = io.BytesIO(); wb.save(buf); return buf.getvalue()


# ─── Plane AWB workbook ───────────────────────────────────────────────────────

def _write_plane_summary(ws, plane: dict, m: dict) -> None:
    ws.column_dimensions["A"].width = 26
    ws.column_dimensions["B"].width = 42

    ws.merge_cells("A1:B1")
    ws["A1"] = "AIR WAYBILL (MASTER)"
    ws["A1"].font = _WHITE_BOLD; ws["A1"].fill = _HEADER_FILL; ws["A1"].alignment = _LEFT_ALIGN
    ws.row_dimensions[1].height = 30

    ws.merge_cells("A2:B2")
    ws["A2"] = f"{plane.get('name', '')} · flight {m.get('flightNumber', '')}"
    ws["A2"].font = _WHITE_SUB; ws["A2"].fill = _HEADER_FILL; ws["A2"].alignment = _LEFT_ALIGN
    ws.row_dimensions[2].height = 22

    row = 4
    row = _write_section(ws, row, "FLIGHT & AIRCRAFT")
    row = _write_field(ws, row, "Aircraft name",        plane.get("name", ""))
    row = _write_field(ws, row, "Aircraft registration", m.get("aircraftRegistration", ""), mono=True)
    row = _write_field(ws, row, "Flight number",        m.get("flightNumber", ""), mono=True)
    row = _write_field(ws, row, "Flight date",          m.get("flightDate", ""))
    row = _write_field(ws, row, "Master AWB",           m.get("masterAwbNumber", ""), mono=True)
    if plane.get("departureAirport"): row = _write_field(ws, row, "Departure airport (IATA)", plane["departureAirport"])
    if plane.get("arrivalAirport"):   row = _write_field(ws, row, "Arrival airport (IATA)",   plane["arrivalAirport"])
    row = _write_field(ws, row, "Issued",               m.get("issuedAt", ""))

    row += 1
    row = _write_section(ws, row, "AGGREGATE TOTALS")
    row = _write_field(ws, row, "Total pieces (PCS)",       f"{m.get('totalPieces', 0):,}")
    row = _write_field(ws, row, "Total gross weight",       _format_weight(m.get("totalGrossWeightKg", 0)))
    row = _write_field(ws, row, "Total chargeable weight",  _format_weight(m.get("totalChargeableWeightKg", 0)))
    row = _write_field(ws, row, "Total volume",             f"{m.get('totalVolumeM3', 0):,} m³")
    row = _write_field(ws, row, "Total declared value",     f"${m.get('totalDeclaredValueUSD', 0):,}", value_bold=True)
    if m.get("uldCount"):
        row = _write_field(ws, row, "ULDs",                 str(m["uldCount"]))
    row = _write_field(ws, row, "Shipments (HAWBs)",        str(len(m.get("shipments", []))))
    row = _write_field(ws, row, "Dangerous goods (DGR)",    "Yes" if m.get("dangerousGoodsOnboard") else "No")
    row = _write_field(ws, row, "Perishables on board",     "Yes" if m.get("perishablesOnboard") else "No")
    row = _write_field(ws, row, "Cold chain on board",      "Yes" if m.get("coldChainOnboard") else "No")
    row = _write_field(ws, row, "Valuable on board",        "Yes" if m.get("valuableOnboard") else "No")


_PLANE_COLS = [
    ("House AWB", 20), ("Booking ref", 16), ("Customer ref", 14),
    ("Commodity", 38), ("HS code", 10), ("Country origin", 14),
    ("Pieces", 9), ("Gross weight (kg)", 17), ("Chargeable weight (kg)", 20),
    ("Volume (m³)", 13), ("ULD type", 10),
    ("Declared value (USD)", 20), ("Customs value (USD)", 20),
    ("SHC codes", 26),
    ("DGR UN", 11), ("DGR class", 26), ("Packing group", 14), ("Packing instruction", 18),
    ("Proper shipping name", 36),
    ("Temperature (°C)", 16),
    ("Freight basis", 18),
]


def _write_plane_shipments(ws, m: dict) -> None:
    for col_idx, (header, width) in enumerate(_PLANE_COLS, start=1):
        c = ws.cell(row=1, column=col_idx, value=header)
        c.font = _COL_HDR_FONT; c.fill = _COL_HEADER_FILL; c.alignment = _CENTER; c.border = _BORDER_BOX
        ws.column_dimensions[get_column_letter(col_idx)].width = width
    ws.row_dimensions[1].height = 28
    ws.freeze_panes = "A2"

    for r, s in enumerate(m.get("shipments", []), start=2):
        is_dgr = bool(s.get("dgr"))
        is_perish = "PER" in s.get("specialHandlingCodes", []) or "COL" in s.get("specialHandlingCodes", []) or "FRO" in s.get("specialHandlingCodes", [])
        fill = _HAZMAT_FILL if is_dgr else (_REEFER_FILL if is_perish else None)

        dgr = s.get("dgr") or {}
        freight_basis = {"P": "Prepaid (shipper)", "C": "Collect (consignee)", "X": "Other"}.get(s.get("freightBasis"), s.get("freightBasis", ""))
        vals = [
            s.get("houseAwbNumber", ""), s.get("bookingReference", ""), s.get("customerCode", ""),
            s.get("goodsDescription", ""), s.get("hsCode", ""), s.get("countryOfOrigin", ""),
            s.get("pieces", 0), s.get("grossWeightKg", 0), s.get("chargeableWeightKg", 0),
            s.get("volumeM3", 0), s.get("uldType", ""),
            s.get("declaredValueUSD", 0), s.get("declaredValueForCustomsUSD", 0),
            " ".join(s.get("specialHandlingCodes", []) or []),
            dgr.get("unNumber", ""), _imdg_label(dgr.get("dgrClass")),
            dgr.get("packingGroup", ""), dgr.get("packingInstruction", ""),
            dgr.get("properShippingName", ""),
            s.get("temperature", "") if s.get("temperature") is not None else "",
            freight_basis,
        ]
        for col_idx, val in enumerate(vals, start=1):
            cell = ws.cell(row=r, column=col_idx, value=val)
            cell.font = _BODY_FONT; cell.border = _BORDER_BOX
            cell.alignment = _RIGHT_ALIGN if col_idx in {7, 8, 9, 10, 12, 13, 20} else _LEFT_ALIGN
            if fill: cell.fill = fill
        ws.cell(row=r, column=7 ).number_format = "#,##0"      # pieces
        ws.cell(row=r, column=8 ).number_format = "#,##0"      # gross kg
        ws.cell(row=r, column=9 ).number_format = "#,##0"      # chargeable kg
        ws.cell(row=r, column=10).number_format = "#,##0.0"    # volume
        ws.cell(row=r, column=12).number_format = '"$"#,##0'   # declared value
        ws.cell(row=r, column=13).number_format = '"$"#,##0'   # customs value
        ws.row_dimensions[r].height = 24


def build_plane_manifest_xlsx(plane: dict, manifest: dict) -> bytes:
    wb = Workbook()
    summary = wb.active; summary.title = "AWB"
    _write_plane_summary(summary, plane, manifest)
    shipments = wb.create_sheet("Shipments")
    _write_plane_shipments(shipments, manifest)
    buf = io.BytesIO(); wb.save(buf); return buf.getvalue()


# ─── Dispatcher ───────────────────────────────────────────────────────────────

def build_manifest_xlsx_for_vehicle(vehicle: dict) -> bytes:
    """Build the .xlsx workbook for any vehicle type. Picks ship / truck /
    plane builder based on vehicle['type'] and the shape of the attached
    manifest dict. Raises ValueError if the vehicle has no manifest."""
    manifest = vehicle.get("manifest")
    if not manifest:
        raise ValueError(f"vehicle {vehicle.get('id')} has no manifest")
    vtype = vehicle.get("type")
    if vtype == "ship":
        return build_manifest_xlsx(vehicle, manifest)
    if vtype == "truck":
        return build_truck_manifest_xlsx(vehicle, manifest)
    if vtype == "plane":
        return build_plane_manifest_xlsx(vehicle, manifest)
    raise ValueError(f"unsupported vehicle type {vtype!r}")

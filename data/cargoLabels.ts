// Human labels for the cryptic identifiers a real cargo manifest is full of.
// Used by the manifest sidebar / panel so the UI reads as plain English
// alongside the regulatory codes (which we still surface for traceability).

/** IMDG hazard-class plain-language descriptions. Subclasses use dotted
 *  notation per the IMDG Code. Source: IMO IMDG Code, latest amendments.
 *  Returns the regulatory class number untouched if we don't have a label —
 *  better to show "5.1" than to drop information. */
export const IMDG_CLASS_LABELS: Record<string, string> = {
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
};

export function imdgClassLabel(cls: string): string {
    return IMDG_CLASS_LABELS[cls] ?? `Class ${cls}`;
}

/** Incoterms 2020 — the three-letter codes shippers and freight forwarders
 *  use to assign cost / risk / delivery responsibilities. Source: ICC
 *  Incoterms 2020 Rules. */
export const INCOTERM_LABELS: Record<string, string> = {
    EXW: "Ex Works",
    FOB: "Free On Board",
    CFR: "Cost and Freight",
    CIF: "Cost, Insurance and Freight",
    DAP: "Delivered at Place",
    DDP: "Delivered Duty Paid",
};

export function incotermLabel(code: string): string {
    const label = INCOTERM_LABELS[code];
    return label ? `${label} (${code})` : code;
}

/** Freight payment terms. PREPAID = shipper paid carriage at origin;
 *  COLLECT = consignee pays carriage at destination. */
export function freightTermLabel(term: string): string {
    if (term === "PREPAID") return "Prepaid (shipper)";
    if (term === "COLLECT") return "Collect (consignee)";
    return term;
}

/** ISO-3166-1 alpha-2 → English country name, covering every code emitted
 *  by backend/services/manifest_generator.py::COUNTRY_BY_PORT. Add entries
 *  here when new ports are added to the Petros fleet. */
export const COUNTRY_NAMES: Record<string, string> = {
    AE: "United Arab Emirates",
    AR: "Argentina",
    AU: "Australia",
    BR: "Brazil",
    CA: "Canada",
    CL: "Chile",
    CN: "China",
    CO: "Colombia",
    DE: "Germany",
    EG: "Egypt",
    ES: "Spain",
    FI: "Finland",
    FR: "France",
    GR: "Greece",
    HK: "Hong Kong SAR",
    ID: "Indonesia",
    IN: "India",
    IT: "Italy",
    JP: "Japan",
    KE: "Kenya",
    KR: "South Korea",
    KW: "Kuwait",
    LK: "Sri Lanka",
    MA: "Morocco",
    MX: "Mexico",
    NG: "Nigeria",
    NL: "Netherlands",
    NZ: "New Zealand",
    OM: "Oman",
    PH: "Philippines",
    PT: "Portugal",
    RO: "Romania",
    RU: "Russia",
    SA: "Saudi Arabia",
    SG: "Singapore",
    SN: "Senegal",
    TR: "Türkiye",
    UY: "Uruguay",
    US: "United States",
    YE: "Yemen",
    ZA: "South Africa",
    ZZ: "Unknown",
};

export function countryName(iso2: string): string {
    return COUNTRY_NAMES[iso2.toUpperCase()] ?? iso2;
}

/** ISO container-type codes — what's printed on the door. Common ones cover
 *  ~95% of the global container fleet. */
export const CONTAINER_TYPE_LABELS: Record<string, string> = {
    "20'STD": "20-foot standard dry",
    "40'STD": "40-foot standard dry",
    "40'HC":  "40-foot high-cube dry",
    "20'REF": "20-foot refrigerated (reefer)",
    "40'REF": "40-foot refrigerated (reefer)",
};

export function containerTypeLabel(code: string): string {
    return CONTAINER_TYPE_LABELS[code] ?? code;
}

// Friendly airport names for the Petros plane fleet.
// Keep IATA codes in sync with backend/services/airport_coords.py — if you
// add a new code there, add it here too so the sidebar can resolve it.
//
// Names follow the "City Airport" convention (e.g., "London Heathrow" not
// "Heathrow"), so they're unambiguous when a city has multiple airports
// (LHR vs LGW, JFK vs LGA vs EWR, etc.).

export const AIRPORT_NAMES: Record<string, string> = {
    AKL: "Auckland",
    ALA: "Almaty",
    AMS: "Amsterdam Schiphol",
    BKK: "Bangkok Suvarnabhumi",
    BOG: "Bogotá El Dorado",
    BOM: "Mumbai",
    CAI: "Cairo",
    CDG: "Paris Charles de Gaulle",
    CGK: "Jakarta Soekarno-Hatta",
    CMN: "Casablanca Mohammed V",
    CPT: "Cape Town",
    DOH: "Doha Hamad",
    DXB: "Dubai",
    EZE: "Buenos Aires Ezeiza",
    FRA: "Frankfurt",
    GRU: "São Paulo Guarulhos",
    HAN: "Hanoi Noi Bai",
    HEL: "Helsinki Vantaa",
    HKG: "Hong Kong",
    ICN: "Seoul Incheon",
    JFK: "New York JFK",
    JNB: "Johannesburg O.R. Tambo",
    KHI: "Karachi Jinnah",
    KUL: "Kuala Lumpur",
    LAX: "Los Angeles",
    LHR: "London Heathrow",
    LIM: "Lima Jorge Chávez",
    LOS: "Lagos Murtala Muhammed",
    MAA: "Chennai",
    MAD: "Madrid Barajas",
    MEL: "Melbourne Tullamarine",
    MEX: "Mexico City",
    MIA: "Miami",
    MNL: "Manila Ninoy Aquino",
    NBO: "Nairobi Jomo Kenyatta",
    NRT: "Tokyo Narita",
    ORD: "Chicago O'Hare",
    PEK: "Beijing Capital",
    PVG: "Shanghai Pudong",
    SCL: "Santiago de Chile",
    SGN: "Ho Chi Minh City",
    SIN: "Singapore Changi",
    SVO: "Moscow Sheremetyevo",
    SYD: "Sydney Kingsford Smith",
    THR: "Tehran Mehrabad",
    VVO: "Vladivostok",
    YVR: "Vancouver",
    YYZ: "Toronto Pearson",
};

/** Resolve an IATA code to a friendly name. Falls back to the code itself
 *  if we don't have a mapping — so the UI degrades to "LHR" rather than
 *  showing blank. */
export function airportName(code: string | undefined | null): string {
    if (!code) return "";
    const upper = code.trim().toUpperCase();
    return AIRPORT_NAMES[upper] ?? upper;
}

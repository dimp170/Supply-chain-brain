export type ContinentCode = "NORTH AMERICA" | "EUROPE" | "ASIA" | "AFRICA" | "SOUTH AMERICA" | "OCEANIA";

type ContinentTarget = {
    center: [number, number];
    zoom:   number;
};

export const CONTINENTS: Record<ContinentCode, ContinentTarget> = {

    "NORTH AMERICA": { "center": [-100, 48], "zoom": 2.8 },
    "EUROPE": { "center": [25, 55],   "zoom": 3.5 },
    "SOUTH AMERICA": { "center": [-56, -15], "zoom": 2.5 },
    "AFRICA": { "center": [25, 0],   "zoom": 2.6 },
    "ASIA": { "center": [87, 44],  "zoom": 2.5 },
    "OCEANIA": { "center": [133, -24], "zoom": 2.8 }
};
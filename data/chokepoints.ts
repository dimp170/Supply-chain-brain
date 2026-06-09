export interface Chokepoint {
    id: string;
    name: string;
    coordinates: [number, number]; // [lng, lat]
    tier: "primary" | "secondary";
}

export const CHOKEPOINTS: Chokepoint[] = [
    { id: "suez",          name: "Suez Canal",        coordinates: [32.3,   30.7],  tier: "primary"   },
    { id: "hormuz",        name: "Strait of Hormuz",  coordinates: [56.4,   26.5],  tier: "primary"   },
    { id: "bab-el-mandeb", name: "Bab el-Mandeb",     coordinates: [43.4,   12.6],  tier: "primary"   },
    { id: "malacca",       name: "Strait of Malacca", coordinates: [103.5,   1.3],  tier: "primary"   },
    { id: "panama",        name: "Panama Canal",       coordinates: [-79.9,   9.3],  tier: "primary"   },
    { id: "gibraltar",     name: "Gibraltar",          coordinates: [-5.4,   36.1],  tier: "primary"   },
    { id: "bosphorus",     name: "Bosphorus",          coordinates: [29.0,   41.0],  tier: "primary"   },
    { id: "cape",          name: "Cape of Good Hope",  coordinates: [18.5,  -34.4],  tier: "primary"   },
    { id: "oresund",       name: "Øresund",            coordinates: [12.6,   55.9],  tier: "secondary" },
    { id: "dover",         name: "Dover Strait",       coordinates: [1.4,    51.1],  tier: "secondary" },
    { id: "lombok",        name: "Lombok Strait",      coordinates: [115.7,  -8.5],  tier: "secondary" },
    { id: "luzon",         name: "Luzon Strait",       coordinates: [121.0,  20.5],  tier: "secondary" },
];

// Petros Transport demo fleet — loaded from the FastAPI backend.
//
// The fleet data lives in `data/petros_fleet.json` (hand-editable on the
// Python side). FastAPI serves it from `/api/fleet/petros`; this module just
// fetches and types the response so `app/page.tsx` doesn't have to.

import { Truck, Ship, Plane } from "@/types/vehicle";
import { apiJson } from "@/lib/apiClient";

export type PetrosFleet = {
    trucks: Truck[];
    ships:  Ship[];
    planes: Plane[];
};

export async function fetchPetrosFleet(): Promise<PetrosFleet> {
    try {
        return await apiJson<PetrosFleet>("/api/fleet/petros");
    } catch (err) {
        console.warn("[petros] fetch failed:", err);
        return { trucks: [], ships: [], planes: [] };
    }
}

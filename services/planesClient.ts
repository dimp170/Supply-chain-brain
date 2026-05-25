// Thin polling client for live planes.
//
// Aviation Edge ingestion + airline-name enrichment now happens server-side
// in `backend/services/planes.py`. This module just calls `/api/planes` and
// returns the `Plane[]` the FastAPI app already shapes for us.

import { Vehicle } from "@/types/vehicle";
import { apiJson } from "@/lib/apiClient";

export async function fetchLivePlanes(): Promise<Vehicle[]> {
    try {
        const planes = await apiJson<Vehicle[]>("/api/planes");
        console.log(`[planes] ${planes.length} live planes`);
        return planes;
    } catch (err) {
        console.warn("[planes] fetch failed:", err);
        return [];
    }
}

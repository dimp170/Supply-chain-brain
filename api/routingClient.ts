// Thin client for the FastAPI `/api/route` endpoint.
//
// HERE Routing + flexpolyline decoding + cumulativeDistance enrichment all
// live in `backend/services/routing.py`. The frontend receives a fully-formed
// `RoutePoint[]` and hands it straight to the store.

import { RoutePoint } from "@/types/routePoint";
import { apiJson } from "@/lib/apiClient";

export async function fetchTruckRoute(
    start: [number, number],
    end:   [number, number],
): Promise<{ route: RoutePoint[] }> {
    const o = `${start[0]},${start[1]}`;
    const d = `${end[0]},${end[1]}`;
    return apiJson<{ route: RoutePoint[] }>(
        `/api/route?o=${encodeURIComponent(o)}&d=${encodeURIComponent(d)}`,
    );
}

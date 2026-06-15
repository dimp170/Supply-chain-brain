// Client for the /api/reroute optimization endpoint (NVIDIA NIM-powered).

import { RoutePoint } from "@/types/routePoint";
import { apiJson } from "@/lib/apiClient";

export interface HazardInput {
    lat: number;
    lng: number;
    radiusKm: number;
    reason: "weather" | "geopolitical" | "traffic";
    description: string;
}

export interface RerouteRequest {
    vehicleName: string;
    origin: [number, number]; // [lat, lng]
    destination: [number, number]; // [lat, lng]
    hazard: HazardInput;
}

export interface RerouteResponse {
    success: boolean;
    originalRoute: RoutePoint[];
    newRoute: RoutePoint[];
    originalDistanceKm: number;
    newDistanceKm: number;
    originalTimeHrs: number;
    newTimeHrs: number;
    delayHrs: number;
    hazard: HazardInput;
    explanation: string;
    aiPowered: boolean;
}

export async function fetchReroute(req: RerouteRequest): Promise<RerouteResponse> {
    return apiJson<RerouteResponse>("/api/reroute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
    });
}

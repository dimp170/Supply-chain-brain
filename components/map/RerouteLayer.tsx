"use client";

/**
 * RerouteLayer — renders the reroute optimization visualization on the Mapbox globe.
 *
 * When a reroute result is present in the vehicle store, this draws:
 *   1. Original route (red dashed line)
 *   2. New optimized route (green solid line)
 *   3. Hazard zone (red translucent circle)
 *
 * All layers are cleaned up automatically when the reroute result is cleared
 * (user clicks "RUN ANOTHER SCENARIO" or deselects the vehicle).
 */

import { useEffect } from "react";
import mapboxgl from "mapbox-gl";
import { useVehicleStore } from "@/stores/vehicleStore";
import * as turf from "@turf/turf";

const REROUTE_ORIGINAL_LINE = "reroute-original-line";
const REROUTE_ORIGINAL_SRC = "reroute-original-src";
const REROUTE_NEW_LINE = "reroute-new-line";
const REROUTE_NEW_SRC = "reroute-new-src";
const REROUTE_HAZARD_FILL = "reroute-hazard-fill";
const REROUTE_HAZARD_OUTLINE = "reroute-hazard-outline";
const REROUTE_HAZARD_SRC = "reroute-hazard-src";

const ALL_LAYERS = [REROUTE_ORIGINAL_LINE, REROUTE_NEW_LINE, REROUTE_HAZARD_FILL, REROUTE_HAZARD_OUTLINE];
const ALL_SOURCES = [REROUTE_ORIGINAL_SRC, REROUTE_NEW_SRC, REROUTE_HAZARD_SRC];

function cleanupLayers(map: mapboxgl.Map) {
    for (const id of ALL_LAYERS) {
        try { if (map.getLayer(id)) map.removeLayer(id); } catch { /* already removed */ }
    }
    for (const id of ALL_SOURCES) {
        try { if (map.getSource(id)) map.removeSource(id); } catch { /* already removed */ }
    }
}

interface Props {
    map: mapboxgl.Map | null;
}

export function RerouteLayer({ map }: Props) {
    const rerouteResult = useVehicleStore((s) => s.rerouteResult);

    useEffect(() => {
        if (!map) return;

        // Always clean up existing layers first
        cleanupLayers(map);

        if (!rerouteResult || !rerouteResult.success) return;

        const { originalRoute, newRoute, hazard } = rerouteResult;

        // --- Original route (red dashed) ---
        if (originalRoute && originalRoute.length >= 2) {
            const coords = originalRoute.map((p) => [p.lng, p.lat] as [number, number]);
            try {
                map.addSource(REROUTE_ORIGINAL_SRC, {
                    type: "geojson",
                    data: {
                        type: "Feature",
                        geometry: { type: "LineString", coordinates: coords },
                        properties: {},
                    },
                });
                map.addLayer({
                    id: REROUTE_ORIGINAL_LINE,
                    type: "line",
                    source: REROUTE_ORIGINAL_SRC,
                    layout: { "line-join": "round", "line-cap": "round" },
                    paint: {
                        "line-color": "#ef4444",      // red-500
                        "line-width": 3,
                        "line-opacity": 0.7,
                        "line-dasharray": [3, 2],
                    },
                });
            } catch (e) { console.warn("[RerouteLayer] original route error:", e); }
        }

        // --- New optimized route (green solid) ---
        if (newRoute && newRoute.length >= 2) {
            const coords = newRoute.map((p) => [p.lng, p.lat] as [number, number]);
            try {
                map.addSource(REROUTE_NEW_SRC, {
                    type: "geojson",
                    data: {
                        type: "Feature",
                        geometry: { type: "LineString", coordinates: coords },
                        properties: {},
                    },
                });
                map.addLayer({
                    id: REROUTE_NEW_LINE,
                    type: "line",
                    source: REROUTE_NEW_SRC,
                    layout: { "line-join": "round", "line-cap": "round" },
                    paint: {
                        "line-color": "#10b981",      // emerald-500
                        "line-width": 4,
                        "line-opacity": 0.85,
                    },
                });
            } catch (e) { console.warn("[RerouteLayer] new route error:", e); }
        }

        // --- Hazard zone circle (red translucent) ---
        if (hazard && hazard.lat && hazard.lng) {
            // Backend returns radius_km (snake_case), client type uses radiusKm
            const radiusKm = (hazard as any).radiusKm || (hazard as any).radius_km || 100;
            try {
                // Use turf to generate a proper geodesic circle polygon
                const center = [hazard.lng, hazard.lat];
                const circle = turf.circle(center, radiusKm, {
                    steps: 64,
                    units: "kilometers",
                });

                map.addSource(REROUTE_HAZARD_SRC, {
                    type: "geojson",
                    data: circle,
                });
                map.addLayer({
                    id: REROUTE_HAZARD_FILL,
                    type: "fill",
                    source: REROUTE_HAZARD_SRC,
                    paint: {
                        "fill-color": "#ef4444",
                        "fill-opacity": 0.15,
                    },
                });
                map.addLayer({
                    id: REROUTE_HAZARD_OUTLINE,
                    type: "line",
                    source: REROUTE_HAZARD_SRC,
                    paint: {
                        "line-color": "#ef4444",
                        "line-width": 2,
                        "line-opacity": 0.6,
                        "line-dasharray": [2, 1],
                    },
                });
            } catch (e) { console.warn("[RerouteLayer] hazard zone error:", e); }
        }

        // Cleanup on unmount or re-render
        return () => {
            if (map) cleanupLayers(map);
        };
    }, [map, rerouteResult]);

    return null; // Pure side-effect component — no DOM output
}

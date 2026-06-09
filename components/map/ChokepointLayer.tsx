"use client";

/**
 * ChokepointLayer — renders maritime chokepoints on the Mapbox globe.
 *
 * Null-render component; all work happens as Mapbox side-effects.
 * Adds two layers:
 *   chokepoints-circle  — filled dot, red (primary) or amber (secondary)
 *   chokepoints-labels  — name label below each dot
 *
 * onMapInstance fires from WorldMap after map.on("load"), so by the time
 * this component mounts the style is already loaded. The style.load fallback
 * is belt-and-braces for edge cases (HMR, strict mode double-invoke, etc.).
 */

import { useEffect } from "react";
import mapboxgl from "mapbox-gl";
import { CHOKEPOINTS } from "@/data/chokepoints";

interface ChokepointLayerProps {
    map: mapboxgl.Map | null;
}

const SOURCE_ID    = "chokepoints";
const CIRCLE_LAYER = "chokepoints-circle";
const LABEL_LAYER  = "chokepoints-labels";

export function ChokepointLayer({ map }: ChokepointLayerProps) {
    useEffect(() => {
        if (!map) return;

        const addLayers = () => {
            if (map.getSource(SOURCE_ID)) return;

            map.addSource(SOURCE_ID, {
                type: "geojson",
                data: {
                    type: "FeatureCollection",
                    features: CHOKEPOINTS.map((cp) => ({
                        type: "Feature" as const,
                        properties: { name: cp.name, tier: cp.tier },
                        geometry: {
                            type: "Point" as const,
                            coordinates: cp.coordinates,
                        },
                    })),
                },
            });

            map.addLayer({
                id: CIRCLE_LAYER,
                type: "circle",
                source: SOURCE_ID,
                paint: {
                    "circle-radius": 6,
                    "circle-color": [
                        "match",
                        ["get", "tier"],
                        "primary",   "#ef4444",
                        "secondary", "#f97316",
                        "#ffffff",
                    ],
                    "circle-stroke-color": "#ffffff",
                    "circle-stroke-width": 1.5,
                    "circle-opacity": 0.9,
                },
            });

            map.addLayer({
                id: LABEL_LAYER,
                type: "symbol",
                source: SOURCE_ID,
                layout: {
                    "text-field":  ["get", "name"],
                    "text-size":   11,
                    "text-anchor": "top",
                    "text-offset": [0, 0.8],
                    "text-font":   ["DIN Offc Pro Medium", "Arial Unicode MS Bold"],
                },
                paint: {
                    "text-color":      "#ffffff",
                    "text-halo-color": "#000000",
                    "text-halo-width": 1.2,
                    "text-opacity":    0.9,
                },
            });
        };

        if (map.isStyleLoaded()) {
            addLayers();
        } else {
            map.once("style.load", addLayers);
        }

        return () => {
            map.off("style.load", addLayers);
            try { if (map.getLayer(LABEL_LAYER))  map.removeLayer(LABEL_LAYER);  } catch { /* gone */ }
            try { if (map.getLayer(CIRCLE_LAYER)) map.removeLayer(CIRCLE_LAYER); } catch { /* gone */ }
            try { if (map.getSource(SOURCE_ID))   map.removeSource(SOURCE_ID);   } catch { /* gone */ }
        };
    }, [map]);

    return null;
}

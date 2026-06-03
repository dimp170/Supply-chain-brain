/**
 * RiskZoneLayer - Visualizes weather risk zones on the map
 * 
 * Usage:
 * <RiskZoneLayer map={mapInstance} riskZones={riskZones} />
 */

import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import { RiskZone } from "@/types/weather";

interface RiskZoneLayerProps {
    map: mapboxgl.Map | null;
    riskZones: RiskZone[];
}

export function RiskZoneLayer({ map, riskZones }: RiskZoneLayerProps) {
    const sourceAdded = useRef(false);

    useEffect(() => {
        if (!map || !map.isStyleLoaded()) return;

        // Add GeoJSON source for risk zones (one-time)
        if (!sourceAdded.current) {
            if (!map.getSource("risk-zones")) {
                map.addSource("risk-zones", {
                    type: "geojson",
                    data: {
                        type: "FeatureCollection",
                        features: [],
                    },
                });

                // Add fill layer
                map.addLayer({
                    id: "risk-zones-fill",
                    type: "fill",
                    source: "risk-zones",
                    paint: {
                        "fill-color": [
                            "match",
                            ["get", "severity"],
                            "CRITICAL",
                            "#dc2626", // red
                            "HIGH",
                            "#f97316", // orange
                            "MEDIUM",
                            "#eab308", // yellow
                            "LOW",
                            "#22c55e", // green
                            "#999999", // gray fallback
                        ],
                        "fill-opacity": 0.3,
                    },
                });

                // Add border layer
                map.addLayer({
                    id: "risk-zones-border",
                    type: "line",
                    source: "risk-zones",
                    paint: {
                        "line-color": [
                            "match",
                            ["get", "severity"],
                            "CRITICAL",
                            "#991b1b",
                            "HIGH",
                            "#92400e",
                            "MEDIUM",
                            "#713f12",
                            "LOW",
                            "#166534",
                            "#333333",
                        ],
                        "line-width": 2,
                    },
                });

                // Add labels
                map.addLayer({
                    id: "risk-zones-label",
                    type: "symbol",
                    source: "risk-zones",
                    layout: {
                        "text-field": ["get", "description"],
                        "text-size": 12,
                        "text-offset": [0, 0],
                    },
                    paint: {
                        "text-color": "#000000",
                        "text-halo-color": "#ffffff",
                        "text-halo-width": 1,
                    },
                });

                sourceAdded.current = true;
            }
        }

        // Update source data with current risk zones
        if (map.getSource("risk-zones")) {
            const features = riskZones.map((zone) => {
                // Create circle as polygon (approximation with 64 points)
                const points = 64;
                const center = zone.center;
                const radiusInDegrees = zone.radius / 111; // Very rough approximation

                const coords = [];
                for (let i = 0; i < points + 1; i++) {
                    const angle = (i / points) * (Math.PI * 2);
                    coords.push([
                        center[1] + radiusInDegrees * Math.cos(angle),
                        center[0] + radiusInDegrees * Math.sin(angle),
                    ]);
                }

                return {
                    type: "Feature" as const,
                    properties: {
                        id: zone.id,
                        severity: zone.severity,
                        type: zone.type,
                        description: zone.description,
                    },
                    geometry: {
                        type: "Polygon" as const,
                        coordinates: [coords],
                    },
                };
            });

            (map.getSource("risk-zones") as mapboxgl.GeoJSONSource).setData({
                type: "FeatureCollection",
                features: features,
            });
        }
    }, [map, riskZones]);

    return null; // This is a layer, not a visual component
}

/**
 * RiskBadge - Shows risk score for a vehicle
 */
interface RiskBadgeProps {
    riskScore: number; // 0-100
}

export function RiskBadge({ riskScore }: RiskBadgeProps) {
    if (riskScore === 0) return null;

    let severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    let bgColor: string;
    let textColor: string;

    if (riskScore >= 75) {
        severity = "CRITICAL";
        bgColor = "bg-red-600";
        textColor = "text-white";
    } else if (riskScore >= 50) {
        severity = "HIGH";
        bgColor = "bg-orange-500";
        textColor = "text-white";
    } else if (riskScore >= 25) {
        severity = "MEDIUM";
        bgColor = "bg-yellow-500";
        textColor = "text-black";
    } else {
        severity = "LOW";
        bgColor = "bg-green-500";
        textColor = "text-white";
    }

    return (
        <div className={`${bgColor} ${textColor} px-2 py-1 rounded text-xs font-bold`}>
            ⚠️ Risk: {Math.round(riskScore)}/100 ({severity})
        </div>
    );
}

/**
 * RiskAlert - Shows details for a specific risk zone
 */
interface RiskAlertProps {
    zone: RiskZone;
}

export function RiskAlert({ zone }: RiskAlertProps) {
    const severityColors = {
        LOW: "bg-green-100 border-green-400 text-green-800",
        MEDIUM: "bg-yellow-100 border-yellow-400 text-yellow-800",
        HIGH: "bg-orange-100 border-orange-400 text-orange-800",
        CRITICAL: "bg-red-100 border-red-400 text-red-800",
    };

    return (
        <div className={`border-l-4 p-4 mb-2 ${severityColors[zone.severity]}`}>
            <div className="font-bold">{zone.description}</div>
            <div className="text-sm mt-1">{zone.type.replace("_", " ").toUpperCase()}</div>
            {zone.recommendations && zone.recommendations.length > 0 && (
                <ul className="text-sm mt-2 ml-4 list-disc">
                    {zone.recommendations.map((rec, i) => (
                        <li key={i}>{rec}</li>
                    ))}
                </ul>
            )}
        </div>
    );
}

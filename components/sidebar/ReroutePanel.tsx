"use client";

import { useState, useMemo } from "react";
import { fetchReroute, RerouteResponse, HazardInput } from "@/services/rerouteClient";
import { useVehicleStore } from "@/stores/vehicleStore";
import type { Vehicle } from "@/types/vehicle";
import { RotateCcw, Zap, AlertTriangle, Brain, Loader2 } from "lucide-react";

// Hazard reason templates — the actual lat/lng will be computed dynamically
// along the truck's real route so the reroute always makes geographic sense.
const HAZARD_TEMPLATES: Record<string, { reason: "weather" | "geopolitical" | "traffic"; description: string; radiusKm: number }> = {
    "weather": {
        reason: "weather",
        description: "Severe thunderstorm with tornado warning and flash flooding",
        radiusKm: 100,
    },
    "geopolitical": {
        reason: "geopolitical",
        description: "Major highway closure due to civil unrest and road blockades",
        radiusKm: 70,
    },
    "traffic": {
        reason: "traffic",
        description: "Multi-vehicle accident causing indefinite freeway closure",
        radiusKm: 50,
    },
};

/**
 * Pick a point ~40-60% along the truck's remaining route to place the hazard.
 * This ensures the hazard is always realistically in the truck's path.
 */
function computeHazardAlongRoute(vehicle: Vehicle): { lat: number; lng: number } | null {
    if (vehicle.route.length < 4) return null;

    // Find the truck's current position on the route (closest point)
    let startIdx = 0;
    let minDist = Infinity;
    for (let i = 0; i < vehicle.route.length; i++) {
        const dlat = vehicle.route[i].lat - vehicle.latitude;
        const dlng = vehicle.route[i].lng - vehicle.longitude;
        const d = dlat * dlat + dlng * dlng;
        if (d < minDist) { minDist = d; startIdx = i; }
    }

    // Pick a point 40-60% along the REMAINING route
    const remaining = vehicle.route.slice(startIdx);
    if (remaining.length < 3) return null;
    const targetIdx = Math.floor(remaining.length * 0.5);
    const pt = remaining[targetIdx];
    return { lat: pt.lat, lng: pt.lng };
}

interface Props {
    vehicle: Vehicle;
}

export function ReroutePanel({ vehicle }: Props) {
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<RerouteResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [selectedHazard, setSelectedHazard] = useState<string>("weather");
    const setRerouteResult = useVehicleStore((s) => s.setRerouteResult);

    // Compute the hazard location dynamically based on the truck's actual route
    const hazardLocation = useMemo(() => computeHazardAlongRoute(vehicle), [vehicle.id, vehicle.route.length]);

    const handleReroute = async () => {
        setLoading(true);
        setError(null);
        setResult(null);
        setRerouteResult(null);

        const template = HAZARD_TEMPLATES[selectedHazard];

        // Use dynamic hazard location along the truck's actual route
        if (!hazardLocation) {
            setError("Truck has no route data — cannot compute hazard placement");
            setLoading(false);
            return;
        }

        const hazard: HazardInput = {
            lat: hazardLocation.lat,
            lng: hazardLocation.lng,
            radiusKm: template.radiusKm,
            reason: template.reason,
            description: template.description,
        };
        
        try {
            const res = await fetchReroute({
                vehicleName: vehicle.name,
                origin: [vehicle.latitude, vehicle.longitude],
                destination: [vehicle.destination[1], vehicle.destination[0]], // flip lng,lat → lat,lng
                hazard,
            });
            setResult(res);
            setRerouteResult(res); // Push to store so the map can render it
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Reroute failed");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="mx-4 mb-3">
            {/* Trigger card */}
            {!result && (
                <div className="bg-zinc-900/50 border border-zinc-800/60 rounded-lg px-4 py-3">
                    <div className="text-[9px] font-mono tracking-[0.2em] text-zinc-500 mb-2 flex items-center gap-1.5">
                        <Brain size={10} />
                        AI ROUTE OPTIMIZATION
                    </div>

                    {/* Hazard type selector */}
                    <div className="flex gap-1.5 mb-3">
                        {Object.entries(HAZARD_TEMPLATES).map(([key, h]) => (
                            <button
                                key={key}
                                onClick={() => setSelectedHazard(key)}
                                className={`flex-1 text-[9px] font-mono tracking-wider py-1.5 px-2 rounded border transition-all ${
                                    selectedHazard === key
                                        ? key === "weather"
                                            ? "border-sky-500/50 bg-sky-500/10 text-sky-400"
                                            : key === "geopolitical"
                                            ? "border-red-500/50 bg-red-500/10 text-red-400"
                                            : "border-amber-500/50 bg-amber-500/10 text-amber-400"
                                        : "border-zinc-700/50 text-zinc-500 hover:text-zinc-300"
                                }`}
                            >
                                {key.toUpperCase()}
                            </button>
                        ))}
                    </div>

                    {/* Hazard description */}
                    <div className="text-[10px] text-zinc-400 mb-3 leading-relaxed">
                        <AlertTriangle size={10} className="inline mr-1 text-amber-400" />
                        {HAZARD_TEMPLATES[selectedHazard].description}
                        {hazardLocation && (
                            <span className="text-zinc-500 ml-1">
                                — placed at ({hazardLocation.lat.toFixed(1)}°, {hazardLocation.lng.toFixed(1)}°) along route
                            </span>
                        )}
                    </div>

                    {/* Optimize button */}
                    <button
                        onClick={handleReroute}
                        disabled={loading}
                        className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg font-mono text-[11px] tracking-wider transition-all
                            bg-gradient-to-r from-emerald-600/80 to-cyan-600/80 hover:from-emerald-500 hover:to-cyan-500
                            text-white border border-emerald-500/30 hover:border-emerald-400/50
                            disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {loading ? (
                            <>
                                <Loader2 size={13} className="animate-spin" />
                                COMPUTING OPTIMAL ROUTE...
                            </>
                        ) : (
                            <>
                                <Zap size={13} />
                                OPTIMIZE ROUTE
                            </>
                        )}
                    </button>
                </div>
            )}

            {/* Error state */}
            {error && (
                <div className="bg-red-500/[0.08] border border-red-500/30 rounded-lg px-4 py-3 mt-2">
                    <div className="text-[10px] text-red-400 font-mono">{error}</div>
                </div>
            )}

            {/* Result card */}
            {result && (
                <div className="space-y-2">
                    {/* Header */}
                    <div className="bg-zinc-900/50 border border-emerald-500/20 rounded-lg px-4 py-3">
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-[9px] font-mono tracking-[0.2em] text-emerald-400 flex items-center gap-1.5">
                                <Zap size={10} />
                                ROUTE OPTIMIZED
                            </span>
                            {result.aiPowered && (
                                <span className="text-[8px] font-mono tracking-wider text-cyan-400 bg-cyan-500/10 border border-cyan-500/30 px-1.5 py-0.5 rounded">
                                    NVIDIA NIM
                                </span>
                            )}
                            {!result.aiPowered && (
                                <span className="text-[8px] font-mono tracking-wider text-zinc-400 bg-zinc-700/30 border border-zinc-600/30 px-1.5 py-0.5 rounded">
                                    LOCAL
                                </span>
                            )}
                        </div>

                        {/* Metrics */}
                        <div className="grid grid-cols-3 gap-3 mb-3">
                            <div>
                                <div className="text-[8px] font-mono text-zinc-500 mb-0.5">DELAY</div>
                                <div className="text-lg font-medium tabular-nums text-amber-400">
                                    +{result.delayHrs.toFixed(1)}h
                                </div>
                            </div>
                            <div>
                                <div className="text-[8px] font-mono text-zinc-500 mb-0.5">NEW DIST</div>
                                <div className="text-lg font-medium tabular-nums text-white">
                                    {result.newDistanceKm.toFixed(0)}
                                    <span className="text-[9px] text-zinc-500 ml-0.5">km</span>
                                </div>
                            </div>
                            <div>
                                <div className="text-[8px] font-mono text-zinc-500 mb-0.5">DELTA</div>
                                <div className="text-lg font-medium tabular-nums text-zinc-300">
                                    +{(result.newDistanceKm - result.originalDistanceKm).toFixed(0)}
                                    <span className="text-[9px] text-zinc-500 ml-0.5">km</span>
                                </div>
                            </div>
                        </div>

                        {/* Comparison bar */}
                        <div className="space-y-1.5">
                            <div className="flex items-center gap-2">
                                <span className="text-[8px] font-mono text-zinc-500 w-12">ORIG</span>
                                <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                                    <div
                                        className="h-full bg-zinc-500 rounded-full"
                                        style={{ width: "100%" }}
                                    />
                                </div>
                                <span className="text-[9px] font-mono text-zinc-400 tabular-nums w-14 text-right">
                                    {result.originalTimeHrs.toFixed(1)}h
                                </span>
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="text-[8px] font-mono text-emerald-400 w-12">NEW</span>
                                <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                                    <div
                                        className="h-full bg-gradient-to-r from-emerald-500 to-cyan-500 rounded-full"
                                        style={{
                                            width: result.originalTimeHrs > 0
                                                ? `${Math.min(100, (result.newTimeHrs / result.originalTimeHrs) * 100)}%`
                                                : "100%"
                                        }}
                                    />
                                </div>
                                <span className="text-[9px] font-mono text-emerald-400 tabular-nums w-14 text-right">
                                    {result.newTimeHrs.toFixed(1)}h
                                </span>
                            </div>
                        </div>
                    </div>

                    {/* AI Explanation */}
                    <div className="bg-zinc-900/50 border border-zinc-800/60 rounded-lg px-4 py-3">
                        <div className="text-[9px] font-mono tracking-[0.2em] text-zinc-500 mb-2 flex items-center gap-1.5">
                            <Brain size={10} />
                            AI ANALYSIS
                        </div>
                        <p className="text-[11px] text-zinc-300 leading-relaxed">
                            {result.explanation}
                        </p>
                    </div>

                    {/* Reset button */}
                    <button
                        onClick={() => { setResult(null); setRerouteResult(null); }}
                        className="w-full flex items-center justify-center gap-2 py-2 px-4 rounded-lg font-mono text-[10px] tracking-wider
                            text-zinc-400 border border-zinc-700/50 hover:text-white hover:border-zinc-600 transition-all"
                    >
                        <RotateCcw size={11} />
                        RUN ANOTHER SCENARIO
                    </button>
                </div>
            )}
        </div>
    );
}

/**
 * WeatherCard — single source of truth for weather rendering in the sidebar
 * detail drawer.
 *
 * Visual style mirrors `DetailCard` / `DetailRow` in VehicleSidebar.tsx so it
 * sits flush with the surrounding cards (operator chip, speed, status,
 * route, vessel/flight, position).
 *
 * Data path:
 *   1. Reads conditions + riskZones from useWeatherStore (populated by the
 *      hourly global hook AND by this component's own on-demand fetches).
 *   2. If no condition is within MAX_WEATHER_RADIUS_KM (400 km), triggers an
 *      on-demand POST /api/weather for this vehicle's section.
 *   3. Backend dedups by 2°×2° grid; this component dedups via two
 *      module-level Sets so a section is never fetched twice in a session
 *      (`attemptedFetches`) and never fetched concurrently (`inflightFetches`).
 *      Refresh the page to retry a previously-failed section.
 */

import { useEffect } from "react";
import { useWeatherStore } from "@/stores/weatherStore";
import { Cloud, Droplets, Wind, Thermometer, Compass, Gauge, AlertTriangle, Loader } from "lucide-react";

interface WeatherCardProps {
    latitude: number;
    longitude: number;
}

const inflightFetches = new Set<string>();
const attemptedFetches = new Set<string>();

function sectionKey(lat: number, lng: number): string {
    return `${Math.floor(lat / 2) * 2},${Math.floor(lng / 2) * 2}`;
}

// Compass octant from a heading in degrees. Used to render "315° (NW)" so
// the wind direction is human-readable at a glance without losing precision.
function compassOctant(deg: number): string {
    const points = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return points[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

export function WeatherCard({ latitude, longitude }: WeatherCardProps) {
    const riskZones = useWeatherStore((state) => state.riskZones);
    const weatherData = useWeatherStore((state) => state.weatherData);

    const MAX_WEATHER_RADIUS_KM = 400;
    let closestCondition: any = null;
    if (weatherData?.conditions && weatherData.conditions.length > 0) {
        const sorted = [...weatherData.conditions].sort((a, b) => {
            const distA = Math.abs(a.latitude - latitude) + Math.abs(a.longitude - longitude);
            const distB = Math.abs(b.latitude - latitude) + Math.abs(b.longitude - longitude);
            return distA - distB;
        });
        const best = sorted[0];
        const approxKm = Math.sqrt(
            Math.pow((best.latitude - latitude) * 111, 2) +
            Math.pow((best.longitude - longitude) * 111 * Math.cos((latitude * Math.PI) / 180), 2),
        );
        if (approxKm <= MAX_WEATHER_RADIUS_KM) {
            closestCondition = best;
        }
    }

    useEffect(() => {
        if (closestCondition) return;
        const key = sectionKey(latitude, longitude);
        if (attemptedFetches.has(key) || inflightFetches.has(key)) return;

        inflightFetches.add(key);
        attemptedFetches.add(key);
        const apiBase = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";

        (async () => {
            try {
                const response = await fetch(`${apiBase}/api/weather`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ locations: [[latitude, longitude]] }),
                });
                if (!response.ok) {
                    console.warn(`[weather] backend returned ${response.status} for section ${key}`);
                    return;
                }
                const data = await response.json();

                const store = useWeatherStore.getState();
                const existing = store.weatherData;
                store.setWeatherData({
                    alerts: existing?.alerts ?? [],
                    conditions: [...(existing?.conditions ?? []), ...(data.conditions ?? [])],
                    riskZones: [...(existing?.riskZones ?? []), ...(data.riskZones ?? [])],
                    lastUpdated: data.lastUpdated || new Date().toISOString(),
                });
                if (data.riskZones?.length) {
                    store.setRiskZones([...store.riskZones, ...data.riskZones]);
                }
            } catch (err) {
                console.error(`[weather] on-demand fetch failed for section ${key}:`, err);
            } finally {
                inflightFetches.delete(key);
            }
        })();
    }, [latitude, longitude, closestCondition]);

    const affectingRisks = riskZones.filter((zone) => {
        const dlat = zone.center[0] - latitude;
        const dlon = zone.center[1] - longitude;
        const distKm = Math.sqrt(dlat * dlat + dlon * dlon) * 111;
        return distKm <= zone.radius;
    });

    return (
        <div className="mx-4 mb-3 bg-zinc-900/50 border border-zinc-800/60 rounded-lg px-4 py-3">
            <div className="flex items-center justify-between text-[9px] font-mono tracking-[0.2em] text-zinc-500 mb-2">
                <span className="flex items-center gap-1.5">
                    <Cloud size={11} />
                    WEATHER
                </span>
                {closestCondition?.source && (
                    <span className="text-zinc-600">
                        {closestCondition.source === "open-meteo" ? "REAL-TIME" : "SIMULATED"}
                    </span>
                )}
            </div>

            {closestCondition ? (
                <div className="space-y-1.5">
                    <Row
                        icon={<Thermometer size={11} />}
                        label="Temperature"
                        value={`${Math.round(closestCondition.temperature)}°C`}
                    />
                    <Row
                        icon={<Wind size={11} />}
                        label="Wind"
                        value={`${Math.round(closestCondition.windSpeed)} km/h`}
                    />
                    {closestCondition.windDirection != null && (
                        <Row
                            icon={<Compass size={11} />}
                            label="Direction"
                            value={`${Math.round(closestCondition.windDirection)}° ${compassOctant(closestCondition.windDirection)}`}
                        />
                    )}
                    <Row
                        icon={<Droplets size={11} />}
                        label="Precipitation"
                        value={`${closestCondition.precipitation.toFixed(1)} mm`}
                    />
                    {closestCondition.humidity != null && (
                        <Row
                            icon={<Gauge size={11} />}
                            label="Humidity"
                            value={`${Math.round(closestCondition.humidity)}%`}
                        />
                    )}
                    {closestCondition.description && (
                        <Row label="Condition" value={closestCondition.description} mono={false} />
                    )}
                </div>
            ) : (
                <div className="flex items-center gap-2 text-xs text-zinc-500">
                    <Loader size={12} className="animate-spin" />
                    Fetching weather for this location…
                </div>
            )}

            {affectingRisks.length > 0 && (
                <div className="space-y-2 mt-3 pt-2 border-t border-zinc-800">
                    {affectingRisks.map((zone) => {
                        const severityColor =
                            zone.severity === "CRITICAL" ? "text-red-400 border-red-500/40 bg-red-500/[0.08]" :
                            zone.severity === "HIGH"     ? "text-orange-300 border-orange-500/40 bg-orange-500/[0.08]" :
                            zone.severity === "MEDIUM"   ? "text-amber-300 border-amber-500/40 bg-amber-500/[0.08]" :
                                                            "text-emerald-300 border-emerald-500/40 bg-emerald-500/[0.08]";
                        return (
                            <div key={zone.id} className={`p-2 rounded border text-[11px] ${severityColor}`}>
                                <div className="flex items-center gap-1 font-mono tracking-wider text-[10px]">
                                    <AlertTriangle size={11} />
                                    {zone.severity}
                                </div>
                                <div className="text-[10px] opacity-80 mt-0.5">{zone.description}</div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// Local row mimicking DetailRow over in VehicleSidebar so weather lines up
// with the rest of the drawer's design language without a cross-file import.
function Row({
    label, value, icon, mono = true,
}: {
    label: string;
    value: React.ReactNode;
    icon?: React.ReactNode;
    mono?: boolean;
}) {
    return (
        <div className="flex items-start justify-between gap-3 min-w-0">
            <span className="flex items-center gap-1.5 text-zinc-500 text-[11px] shrink-0 mt-0.5">
                {icon}
                {label}
            </span>
            <span className={`text-[12px] text-right truncate ${mono ? "font-mono tabular-nums text-zinc-200" : "text-white"}`}>
                {value}
            </span>
        </div>
    );
}

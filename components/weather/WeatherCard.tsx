/**
 * WeatherCard - Displays current weather conditions and risk information
 * Shows for selected vehicle location
 */

import { useWeatherStore } from "@/stores/weatherStore";
import { Cloud, Droplets, Wind, Thermometer, AlertCircle, Loader } from "lucide-react";

interface WeatherCardProps {
    latitude: number;
    longitude: number;
}

export function WeatherCard({ latitude, longitude }: WeatherCardProps) {
    const riskZones = useWeatherStore((state) => state.riskZones);
    const weatherData = useWeatherStore((state) => state.weatherData);
    const isLoading = useWeatherStore((state) => state.isLoading);

    // Find weather conditions closest to this location (check entire globe if needed)
    let closestCondition = null;
    if (weatherData?.conditions && weatherData.conditions.length > 0) {
        // Sort by distance and pick the closest
        const sorted = [...weatherData.conditions].sort((a, b) => {
            const distA = Math.abs(a.latitude - latitude) + Math.abs(a.longitude - longitude);
            const distB = Math.abs(b.latitude - latitude) + Math.abs(b.longitude - longitude);
            return distA - distB;
        });
        closestCondition = sorted[0]; // Always use the closest, even if far
    }

    // Find risk zones affecting this location
    const affectingRisks = riskZones.filter((zone) => {
        const dlat = zone.center[0] - latitude;
        const dlon = zone.center[1] - longitude;
        const distKm = Math.sqrt(dlat * dlat + dlon * dlon) * 111;
        return distKm <= zone.radius;
    });

    // Always show the card - either with data, loading state, or empty state
    return (
        <div className="mt-4 p-3 bg-zinc-900/50 rounded border border-zinc-800">
            <div className="text-xs font-semibold text-zinc-400 mb-2 flex items-center gap-2">
                <Cloud size={14} />
                WEATHER
                {isLoading && <Loader size={12} className="animate-spin ml-auto" />}
            </div>

            {closestCondition ? (
                <>
                    <div className="grid grid-cols-2 gap-2 text-xs mb-3">
                        <div className="flex items-center gap-1">
                            <Thermometer size={12} className="text-amber-500" />
                            <span className="text-zinc-300">
                                {Math.round(closestCondition.temperature)}°C
                            </span>
                        </div>
                        <div className="flex items-center gap-1">
                            <Wind size={12} className="text-blue-500" />
                            <span className="text-zinc-300">
                                {Math.round(closestCondition.windSpeed)} km/h
                            </span>
                        </div>
                        <div className="flex items-center gap-1">
                            <Droplets size={12} className="text-cyan-500" />
                            <span className="text-zinc-300">
                                {closestCondition.precipitation.toFixed(1)} mm
                            </span>
                        </div>
                        <div className="text-zinc-400 text-xs">
                            {closestCondition.description}
                        </div>
                    </div>

                    {/* Show which source the data came from */}
                    {closestCondition.source && (
                        <div className="text-[9px] text-zinc-500 mb-2">
                            Source: {closestCondition.source === "open-meteo" ? "Real-time" : "Simulated"}
                        </div>
                    )}
                </>
            ) : (
                <div className="text-xs text-zinc-500 mb-2">
                    {isLoading ? "Fetching weather..." : "Weather data loading..."}
                </div>
            )}

            {affectingRisks.length > 0 && (
                <div className="space-y-2 border-t border-zinc-800 pt-2">
                    {affectingRisks.map((zone) => {
                        const severityColor =
                            zone.severity === "CRITICAL"
                                ? "text-red-500 bg-red-500/10"
                                : zone.severity === "HIGH"
                                    ? "text-orange-500 bg-orange-500/10"
                                    : zone.severity === "MEDIUM"
                                        ? "text-yellow-500 bg-yellow-500/10"
                                        : "text-green-500 bg-green-500/10";

                        return (
                            <div
                                key={zone.id}
                                className={`p-2 rounded text-xs ${severityColor}`}
                            >
                                <div className="flex items-center gap-1 font-semibold">
                                    <AlertCircle size={12} />
                                    {zone.severity}
                                </div>
                                <div className="text-xs opacity-75 mt-0.5">
                                    {zone.description}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

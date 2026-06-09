/**
 * Example hook for fetching and managing weather data
 * Integrate this into your main page.tsx
 */

import { useEffect } from "react";
import { useWeatherStore } from "@/stores/weatherStore";
import { useVehicleStore } from "@/stores/vehicleStore";
import { generateMockWeatherAlerts } from "@/api/weatherService";
import {
    getVehicleAffectedRisks,
    calculateVehicleRiskScore,
} from "@/lib/riskCalculations";

/**
 * Hook that fetches weather data from the FastAPI backend.
 *
 * Only fetches for mock/sim vehicles — live vehicle locations change too
 * frequently and would exhaust Open-Meteo rate limits.
 *
 * IMPORTANT: this effect mounts ONCE and runs on its own 60-minute interval.
 * We deliberately do NOT depend on the live `vehicles` array because the
 * truck simulator mutates it every 50ms; if `vehicles` were in the deps
 * array the effect would tear down + re-mount continuously and
 * `updateWeather()` (the "initial update" call) would fire ~20×/sec,
 * spamming the backend and the Open-Meteo rate limiter. Instead we read
 * the latest vehicle list directly from the store via getState() inside
 * `updateWeather`, so each tick of the 60-min interval sees fresh data
 * without re-creating the effect on every vehicle mutation.
 *
 * The zustand setter selectors are stable references, so they're safe in
 * the deps array.
 */
export function useWeatherUpdate() {
    const setWeatherData = useWeatherStore((state) => state.setWeatherData);
    const setRiskZones = useWeatherStore((state) => state.setRiskZones);
    const setLoading = useWeatherStore((state) => state.setLoading);
    const setError = useWeatherStore((state) => state.setError);

    useEffect(() => {
        let cancelled = false;

        const updateWeather = async () => {
            if (cancelled) return;

            // Read the freshest vehicle list each tick — avoids stale closure
            // and keeps the effect itself stable (no re-mount on vehicle ticks).
            const mockVehicles = useVehicleStore
                .getState()
                .vehicles.filter((v) => v.dataSource === "mock");

            if (mockVehicles.length === 0) {
                setWeatherData(null);
                setRiskZones([]);
                return;
            }

            try {
                setLoading(true);
                setError(null);

                // Deduplicate locations; cap at 5 to stay within Open-Meteo rate limits.
                const locationMap = new Map<string, [number, number]>();

                mockVehicles.slice(0, 5).forEach((v) => {
                    const key = `${Math.round(v.latitude * 100)},${Math.round(v.longitude * 100)}`;
                    if (!locationMap.has(key)) {
                        locationMap.set(key, [v.latitude, v.longitude]);
                    }
                });

                // Add destination locations for route-ahead awareness.
                mockVehicles.slice(0, 3).forEach((v) => {
                    const key = `${Math.round(v.destination[0] * 100)},${Math.round(v.destination[1] * 100)}`;
                    if (!locationMap.has(key)) {
                        locationMap.set(key, [v.destination[0], v.destination[1]]);
                    }
                });

                const locations = Array.from(locationMap.values());

                // Call the FastAPI backend weather endpoint
                const apiBase = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";
                const response = await fetch(`${apiBase}/api/weather`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({ locations }),
                });

                if (cancelled) return;

                if (!response.ok) {
                    throw new Error(`Weather API error: ${response.status} ${response.statusText}`);
                }

                const weatherData = await response.json();
                if (cancelled) return;

                // Mix in mock alerts
                weatherData.alerts = generateMockWeatherAlerts();

                setWeatherData(weatherData);
                setRiskZones(weatherData.riskZones || []);
                setLoading(false);
            } catch (err) {
                if (cancelled) return;
                const message = err instanceof Error ? err.message : "Unknown error";
                setError(message);
                console.error("Weather update failed:", message);
                setLoading(false);

                setWeatherData({
                    alerts: [],
                    conditions: [],
                    riskZones: [],
                    lastUpdated: new Date().toISOString(),
                });
            }
        };

        // Initial update — runs ONCE on mount.
        updateWeather();

        // Refresh every 60 minutes.
        const interval = setInterval(updateWeather, 60 * 60 * 1000);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [setWeatherData, setRiskZones, setLoading, setError]);
}

/**
 * Hook that matches vehicles to risk zones
 * Updates vehicle cards/sidebar with risk info
 */
export function useVehicleRiskAssessment() {
    const vehicles = useVehicleStore((state) => state.vehicles);
    const riskZones = useWeatherStore((state) => state.riskZones);

    // Map vehicle ID to affected risk zones
    const vehicleRisks = new Map<string, ReturnType<typeof getVehicleAffectedRisks>>();
    const vehicleRiskScores = new Map<string, number>();

    vehicles.forEach((vehicle) => {
        const affectedRisks = getVehicleAffectedRisks(vehicle, riskZones);
        const riskScore = calculateVehicleRiskScore(affectedRisks);

        vehicleRisks.set(vehicle.id, affectedRisks);
        vehicleRiskScores.set(vehicle.id, riskScore);
    });

    return {
        vehicleRisks,
        vehicleRiskScores,
    };
}

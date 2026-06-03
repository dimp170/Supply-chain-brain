/**
 * Example hook for fetching and managing weather data
 * Integrate this into your main page.tsx
 */

import { useEffect } from "react";
import { useWeatherStore } from "@/stores/weatherStore";
import { useVehicleStore } from "@/stores/vehicleStore";
import { generateMockWeatherAlerts } from "@/services/weatherService";
import {
    getVehicleAffectedRisks,
    calculateVehicleRiskScore,
} from "@/lib/riskCalculations";

/**
 * Hook that fetches weather data from the FastAPI backend
 * Fetches weather for mock/sim vehicles only, regardless of live/sim mode
 */
export function useWeatherUpdate() {
    const vehicles = useVehicleStore((state) => state.vehicles);
    const setWeatherData = useWeatherStore((state) => state.setWeatherData);
    const setRiskZones = useWeatherStore((state) => state.setRiskZones);
    const setLoading = useWeatherStore((state) => state.setLoading);
    const setError = useWeatherStore((state) => state.setError);

    useEffect(() => {
        // Filter to only mock vehicles (present in both sim and live modes)
        const mockVehicles = vehicles.filter((v) => v.dataSource === "mock");
        
        if (mockVehicles.length === 0) {
            setWeatherData(null);
            setRiskZones([]);
            return;
        }

        const updateWeather = async () => {
            try {
                setLoading(true);
                setError(null);

                // Extract unique locations from mock vehicles only
                const locationMap = new Map<string, [number, number]>();
                
                mockVehicles.slice(0, 5).forEach((v) => {
                    const key = `${Math.round(v.latitude * 100)},${Math.round(v.longitude * 100)}`;
                    if (!locationMap.has(key)) {
                        locationMap.set(key, [v.latitude, v.longitude]);
                    }
                });

                // Add some destination locations too
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

                if (!response.ok) {
                    throw new Error(`Weather API error: ${response.status} ${response.statusText}`);
                }

                const weatherData = await response.json();
                
                // Mix in mock alerts
                weatherData.alerts = generateMockWeatherAlerts();

                setWeatherData(weatherData);
                setRiskZones(weatherData.riskZones || []);
                setLoading(false);
            } catch (err) {
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

        // Initial update
        updateWeather();

        // Refresh every 60 minutes
        const interval = setInterval(updateWeather, 60 * 60 * 1000);
        return () => clearInterval(interval);
    }, [vehicles, setWeatherData, setRiskZones, setLoading, setError]);
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

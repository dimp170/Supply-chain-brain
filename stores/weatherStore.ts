/**
 * Weather state management
 * Stores current weather conditions and risk zones
 */

import { create } from "zustand";
import { WeatherData, RiskZone } from "@/types/weather";

interface WeatherState {
    weatherData: WeatherData | null;
    riskZones: RiskZone[];
    isLoading: boolean;
    error: string | null;

    setWeatherData: (data: WeatherData) => void;
    setRiskZones: (zones: RiskZone[]) => void;
    setLoading: (loading: boolean) => void;
    setError: (error: string | null) => void;
}

export const useWeatherStore = create<WeatherState>((set) => ({
    weatherData: null,
    riskZones: [],
    isLoading: false,
    error: null,

    setWeatherData: (data) => set({ weatherData: data }),
    setRiskZones: (zones) => set({ riskZones: zones }),
    setLoading: (loading) => set({ isLoading: loading }),
    setError: (error) => set({ error }),
}));

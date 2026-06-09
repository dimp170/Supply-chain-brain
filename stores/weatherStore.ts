/**
 * Weather state management
 * Stores current weather conditions and risk zones.
 *
 * Risk zones come from TWO independent producers:
 *   - `riskZones`           — mock/live weather alerts from useWeatherUpdate
 *   - `scenarioRiskZones`   — geographic zones from the active DEMO scenario
 *                              (typhoon eye, advisory cone, etc.)
 *
 * Both are rendered together when `riskZonesVisible` is true; the TopBar
 * weather pill toggles it. Default OFF so the map stays uncluttered until
 * the user opts in.
 */

import { create } from "zustand";
import { WeatherData, RiskZone } from "@/types/weather";

interface WeatherState {
    weatherData: WeatherData | null;
    /** Mock / live weather alerts from useWeatherUpdate. */
    riskZones: RiskZone[];
    /** Zones contributed by the active DEMO scenario (e.g. typhoon eye). */
    scenarioRiskZones: RiskZone[];
    /** UI toggle gating display of any risk zone. Pill in TopBar drives this. */
    riskZonesVisible: boolean;
    isLoading: boolean;
    error: string | null;

    setWeatherData: (data: WeatherData) => void;
    setRiskZones: (zones: RiskZone[]) => void;
    setScenarioRiskZones: (zones: RiskZone[]) => void;
    setRiskZonesVisible: (visible: boolean) => void;
    toggleRiskZonesVisible: () => void;
    setLoading: (loading: boolean) => void;
    setError: (error: string | null) => void;
}

export const useWeatherStore = create<WeatherState>((set) => ({
    weatherData: null,
    riskZones: [],
    scenarioRiskZones: [],
    riskZonesVisible: false,
    isLoading: false,
    error: null,

    setWeatherData: (data) => set({ weatherData: data }),
    setRiskZones: (zones) => set({ riskZones: zones }),
    setScenarioRiskZones: (zones) => set({ scenarioRiskZones: zones }),
    setRiskZonesVisible: (visible) => set({ riskZonesVisible: visible }),
    toggleRiskZonesVisible: () =>
        set((state) => ({ riskZonesVisible: !state.riskZonesVisible })),
    setLoading: (loading) => set({ isLoading: loading }),
    setError: (error) => set({ error }),
}));

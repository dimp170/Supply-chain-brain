/**
 * Weather risk zones and alerts for supply chain logistics
 * Data sourced from free APIs: Open-Meteo, NOAA, etc.
 */

export interface WeatherAlert {
    id: string;
    type: "hurricane" | "storm" | "snow" | "ice" | "flood" | "heat" | "cold" | "wind";
    severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    latitude: number;
    longitude: number;
    radius: number; // kilometers
    description: string;
    validFrom: string; // ISO date
    validUntil: string; // ISO date
    affectedRoutes?: string[]; // route IDs this affects
}

export interface WeatherCondition {
    latitude: number;
    longitude: number;
    temperature: number; // Celsius
    humidity: number; // percentage
    windSpeed: number; // km/h
    windDirection: number; // degrees
    precipitation: number; // mm
    weatherCode: number; // WMO code
    description: string; // human readable
    timestamp: string; // ISO date
}

export interface RiskZone {
    id: string;
    type: "weather_alert" | "geopolitical" | "infrastructure";
    severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    center: [number, number]; // [lat, lon]
    radius: number; // kilometers
    affectedVehicles: string[]; // vehicle IDs
    description: string;
    recommendations: string[];
    validFrom: string;
    validUntil: string;
}

export interface WeatherData {
    alerts: WeatherAlert[];
    conditions: WeatherCondition[];
    riskZones: RiskZone[];
    lastUpdated: string;
}

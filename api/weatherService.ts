/**
 * Weather Service - Fetches weather data from free APIs
 * 
 * Using Open-Meteo API (free, no key required)
 * Docs: https://open-meteo.com/en/docs
 * 
 * Future: Add NOAA alerts, GFS forecasts for hurricane tracking
 */

import { WeatherAlert, WeatherCondition, RiskZone, WeatherData } from "@/types/weather";

const OPEN_METEO_BASE = "https://api.open-meteo.com/v1";

interface OpenMeteoWeatherResponse {
    latitude: number;
    longitude: number;
    timezone: string;
    current: {
        temperature: number;
        relative_humidity: number;
        weather_code: number;
        wind_speed_10m: number;
        wind_direction_10m: number;
        precipitation: number;
        time: string;
    };
}

// WMO Weather interpretation codes
const WMO_CODES: Record<number, string> = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Foggy",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    61: "Slight rain",
    63: "Moderate rain",
    65: "Heavy rain",
    71: "Slight snow",
    73: "Moderate snow",
    75: "Heavy snow",
    77: "Snow grains",
    80: "Slight rain showers",
    81: "Moderate rain showers",
    82: "Violent rain showers",
    85: "Slight snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with slight hail",
    99: "Thunderstorm with heavy hail",
};

/**
 * Fetch current weather for a specific location
 */
export async function getWeatherAtLocation(
    latitude: number,
    longitude: number
): Promise<WeatherCondition | null> {
    try {
        const params = new URLSearchParams({
            latitude: latitude.toString(),
            longitude: longitude.toString(),
            current: "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,precipitation",
            timezone: "auto",
        });

        const response = await fetch(`${OPEN_METEO_BASE}/forecast?${params}`);
        if (!response.ok) throw new Error(`Weather API error: ${response.status}`);

        const data: OpenMeteoWeatherResponse = await response.json();

        return {
            latitude: data.latitude,
            longitude: data.longitude,
            temperature: data.current.temperature,
            humidity: data.current.relative_humidity,
            windSpeed: data.current.wind_speed_10m,
            windDirection: data.current.wind_direction_10m,
            precipitation: data.current.precipitation,
            weatherCode: data.current.weather_code,
            description: WMO_CODES[data.current.weather_code] || "Unknown",
            timestamp: data.current.time,
        };
    } catch (error) {
        console.error("Failed to fetch weather:", error);
        return null;
    }
}

/**
 * Detect weather-based risk zones (simplified logic)
 * In production, integrate with NOAA alerts, GFS forecasts, etc.
 */
export function generateRiskZones(conditions: WeatherCondition[]): RiskZone[] {
    const zones: RiskZone[] = [];

    conditions.forEach((condition, idx) => {
        // Temperature extremes
        if (condition.temperature > 35) {
            zones.push({
                id: `heat-${idx}`,
                type: "weather_alert",
                severity: condition.temperature > 40 ? "CRITICAL" : "HIGH",
                center: [condition.latitude, condition.longitude],
                radius: 50,
                affectedVehicles: [],
                description: `Extreme heat: ${condition.temperature}°C`,
                recommendations: [
                    "Reduce speed for refrigerated cargo",
                    "Add cooling stops every 2 hours",
                    "Monitor temperature closely",
                ],
                validFrom: new Date().toISOString(),
                validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            });
        }

        // Strong winds
        if (condition.windSpeed > 50) {
            zones.push({
                id: `wind-${idx}`,
                type: "weather_alert",
                severity: condition.windSpeed > 70 ? "CRITICAL" : "HIGH",
                center: [condition.latitude, condition.longitude],
                radius: 100,
                affectedVehicles: [],
                description: `Strong winds: ${condition.windSpeed} km/h`,
                recommendations: [
                    "Reduce speed for high-profile cargo",
                    "Consider delay until conditions improve",
                    "Monitor for vehicle instability",
                ],
                validFrom: new Date().toISOString(),
                validUntil: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
            });
        }

        // Heavy precipitation
        if (condition.precipitation > 10) {
            zones.push({
                id: `rain-${idx}`,
                type: "weather_alert",
                severity: condition.precipitation > 25 ? "HIGH" : "MEDIUM",
                center: [condition.latitude, condition.longitude],
                radius: 50,
                affectedVehicles: [],
                description: `Heavy precipitation: ${condition.precipitation} mm`,
                recommendations: [
                    "Reduce speed",
                    "Increase following distance",
                    "Monitor for flooding on roads",
                ],
                validFrom: new Date().toISOString(),
                validUntil: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
            });
        }

        // Snow (weather code 71-77, 85-86)
        const isSnow = [71, 73, 75, 77, 85, 86].includes(condition.weatherCode);
        if (isSnow) {
            zones.push({
                id: `snow-${idx}`,
                type: "weather_alert",
                severity: condition.weatherCode >= 75 ? "HIGH" : "MEDIUM",
                center: [condition.latitude, condition.longitude],
                radius: 100,
                affectedVehicles: [],
                description: `Snow: ${condition.description}`,
                recommendations: [
                    "Ensure winter tires",
                    "Reduce speed significantly",
                    "Plan for delays",
                    "Have emergency supplies",
                ],
                validFrom: new Date().toISOString(),
                validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            });
        }
    });

    return zones;
}

/**
 * Fetch weather data for multiple routes/locations
 * Returns aggregated weather alerts
 */
export async function getWeatherForLocations(
    locations: [number, number][]
): Promise<WeatherData> {
    const conditions = await Promise.all(
        locations.map((loc) => getWeatherAtLocation(loc[0], loc[1]))
    );

    const validConditions = conditions.filter((c): c is WeatherCondition => c !== null);
    const riskZones = generateRiskZones(validConditions);

    return {
        alerts: [],
        conditions: validConditions,
        riskZones,
        lastUpdated: new Date().toISOString(),
    };
}

/**
 * Mock weather alerts for development
 * Replace with real NOAA alerts, aviation hazards, etc.
 */
export function generateMockWeatherAlerts(): WeatherAlert[] {
    return [
        {
            id: "hurricane-001",
            type: "hurricane",
            severity: "CRITICAL",
            latitude: 20.5,
            longitude: -70.0,
            radius: 200,
            description: "Hurricane approaching Caribbean",
            validFrom: new Date().toISOString(),
            validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        },
        {
            id: "storm-001",
            type: "storm",
            severity: "HIGH",
            latitude: 48.0,
            longitude: 10.0,
            radius: 150,
            description: "Severe thunderstorms over Central Europe",
            validFrom: new Date().toISOString(),
            validUntil: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
        },
    ];
}

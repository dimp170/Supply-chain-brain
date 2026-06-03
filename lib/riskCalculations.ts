/**
 * Risk calculation utilities
 * Determines if vehicles are in risk zones
 */

import { Vehicle } from "@/types/vehicle";
import { RiskZone } from "@/types/weather";

/**
 * Calculate distance between two points in km (Haversine formula)
 */
export function calculateDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
): number {
    const R = 6371; // Earth's radius in km
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos((lat1 * Math.PI) / 180) *
            Math.cos((lat2 * Math.PI) / 180) *
            Math.sin(dLon / 2) *
            Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

/**
 * Check if vehicle is in a risk zone
 */
export function isVehicleInRiskZone(vehicle: Vehicle, zone: RiskZone): boolean {
    const distance = calculateDistance(
        vehicle.latitude,
        vehicle.longitude,
        zone.center[0],
        zone.center[1]
    );
    return distance <= zone.radius;
}

/**
 * Get all risk zones affecting a vehicle
 */
export function getVehicleAffectedRisks(vehicle: Vehicle, zones: RiskZone[]): RiskZone[] {
    return zones.filter((zone) => isVehicleInRiskZone(vehicle, zone));
}

/**
 * Calculate overall risk score for a vehicle (0-100)
 */
export function calculateVehicleRiskScore(affectedZones: RiskZone[]): number {
    if (affectedZones.length === 0) return 0;

    const severityScores: Record<string, number> = {
        LOW: 20,
        MEDIUM: 50,
        HIGH: 75,
        CRITICAL: 100,
    };

    // Use the highest severity zone
    const maxScore = Math.max(...affectedZones.map((z) => severityScores[z.severity] || 0));

    // Slightly boost score if multiple zones
    const multiZoneBonus = Math.min(affectedZones.length * 5, 15);

    return Math.min(maxScore + multiZoneBonus, 100);
}

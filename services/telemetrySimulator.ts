import { Vehicle } from "@/types/vehicle";
import * as turf from "@turf/turf";
export const mockVehicles: Vehicle[] = [
    {
        id: "truck-001",
        name: "Truck 001",
        type: "truck",
        latitude: 51.5074,
        longitude: -0.1278,
        currentSpeed: 60,
        heading: 90,
        status: "moving",
        
        cargo: "Electronics",
        temperature: 4,
        lastUpdated: new Date().toISOString(),
        route: [], 
        destination: [2.3522, 48.8566],       
        
    },

    {
        id: "ship-001",
        name: "Cargo Vessel Petros",
        type: "ship",
        latitude: 25.276987,
        longitude: 55.296249,
        
        heading: 120,
        status: "moving",
        
        cargo: "Containers",
        lastUpdated: new Date().toISOString(),
        route: [], 
        currentSpeed: 40, // km/h
        speedLimit: 50, // km/h
        destination: [32.0, 30.0],       
        
    },

    {
        id: "plane-001",
        name: "Petros Air Cargo 123",
        type: "plane",
        latitude: 40.7128,
        longitude: -74.0060,
        heading: 45,
        status: "moving",
        cargo: "Perishables",
        lastUpdated: new Date().toISOString(),
        route: [], 
        currentSpeed: 850, // km/h
        speedLimit: 900, // km/h
        destination: [28.978, 41.0082],
        
    }
];

export function moveVehicle(vehicle: Vehicle): Vehicle {
    if (!vehicle.route || vehicle.route.length < 2) return vehicle; // No movement if no route
    const line = turf.lineString(vehicle.route.map((point) => [point.lng, point.lat]));
    const totalLength = turf.length(line, { units: "kilometers" });
    const deltaHours = 0.05 / 3600;
    const currentRoutePoint = vehicle.route.find(
        (point) => (point.cumulativeDistance ?? 0) >= (vehicle.distanceTravelled || 0)
    ) || vehicle.route[vehicle.route.length - 1];
    const roadSpeed = currentRoutePoint?.speedLimit ?? 30;
    const speed = Math.max(roadSpeed - 5, 10);
    const distanceStep = speed * deltaHours;
    const newDistance = (vehicle.distanceTravelled || 0) + distanceStep;
    const finalDistance = Math.min(newDistance, totalLength);
    const point = turf.along(line, finalDistance, { units: "kilometers" });
    const [lng, lat] = point.geometry.coordinates;
    const remainingDistance = totalLength - finalDistance;
    const remainingTime = (remainingDistance / roadSpeed) * 60; // in minutes
    return {
        ...vehicle,
        longitude: lng,
        latitude: lat,
        currentSpeed: speed,
        speedLimit: roadSpeed,
        distanceTravelled: finalDistance,
        remainingDistance,
        remainingTime,
        lastUpdated: new Date().toISOString()
        
        }
    };

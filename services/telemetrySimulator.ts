import { Vehicle } from "@/types/vehicle";
export const mockVehicles: Vehicle[] = [
    {
        id: "truck-001",
        name: "Truck 001",
        type: "truck",
        latitude: 51.5074,
        longitude: -0.1278,
        speed: 60,
        heading: 90,
        status: "moving",
        eta: "14:35",
        cargo: "Electronics",
        temperature: 4,
        lastUpdated: new Date().toISOString()
    },

    {
        id: "ship-001",
        name: "Cargo Vessel Petros",
        type: "ship",
        latitude: 25.276987,
        longitude: 55.296249,
        speed: 18,
        heading: 120,
        status: "moving",
        eta: "Tomorrow 08:20",
        cargo: "Containers",
        lastUpdated: new Date().toISOString()
    },

    {
        id: "plane-001",
        name: "Petros Air Cargo 123",
        type: "plane",
        latitude: 40.7128,
        longitude: -74.0060,
        speed: 780,
        heading: 45,
        status: "moving",
        eta: "09:10",
        cargo: "Perishables",
        lastUpdated: new Date().toISOString()
    }
];

export function moveVehicle(vehicle: Vehicle): Vehicle {
    return {
        ...vehicle,
        latitude: vehicle.latitude + (Math.random() - 0.5) * 0.2,
        longitude: vehicle.longitude + (Math.random() - 0.5) * 0.2,
        lastUpdated: new Date().toISOString()
    };
}
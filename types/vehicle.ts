export type VehicleType =
    | "truck"
    | "ship"
    | "plane";

export interface Vehicle {
    id: string;
    name: string;
    type: VehicleType;
    latitude: number;
    longitude: number;
    speed: number; // in km/h
    heading: number; // in degrees
    status:
        | "moving"
        | "delayed"
        | "stopped";
    eta: string; // ISO date string
    cargo: string;
    temperature?: number; // in Celsius
    lastUpdated: string; // ISO date string
}
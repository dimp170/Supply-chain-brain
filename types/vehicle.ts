import { RoutePoint } from "./routePoint";

interface BaseVehicle {
    id: string;
    name: string;
    latitude: number;
    longitude: number;
    heading: number; // degrees
    status: "moving" | "delayed" | "stopped";
    cargo: string;
    temperature?: number; // Celsius
    lastUpdated: string; // ISO date string
    route: RoutePoint[];
    destination: [number, number];
    distanceTravelled?: number; // km
    currentSpeed: number; // km/h
    speedLimit?: number; // km/h
    remainingDistance?: number; // km
    remainingTime?: number; // minutes
    nextRoad?: string;
    cumulativeDistance?: number;
    dataSource?: "live" | "mock";
    company?: string;
}

export interface Truck extends BaseVehicle {
    type: "truck";
}

export interface Ship extends BaseVehicle {
    type: "ship";
    destinationPort?: string;  // AIS destination text (e.g. "ROTTERDAM")
    callSign?: string;
    imoNumber?: number;
    draught?: number;          // metres
    vesselLength?: number;     // metres (bow + stern)
    // Port risk fields populated by the backend RSS scraper
    // (backend/services/risk_engine.py → port_alerts table).
    destinationRisk?: "NONE" | "WARNING" | "CRITICAL";
    destinationIncident?: string;
}

export interface Plane extends BaseVehicle {
    type: "plane";
    flightNumber?: string;     // IATA flight code (e.g. "BA123")
    airline?: string;
    departureAirport?: string;
    arrivalAirport?: string;
    altitude?: number;         // metres
}

export type Vehicle = Truck | Ship | Plane;
export type VehicleType = Vehicle["type"];

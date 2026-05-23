import { create } from "zustand";
import { Vehicle } from "@/types/vehicle";

interface VehicleState {
    vehicles: Vehicle[];
    selectedVehicle: Vehicle | null;
    setVehicles: (vehicles: Vehicle[]) => void;
    updateVehicle: (id: string, updates: Partial<Vehicle>) => void;
    selectVehicle: (vehicle: Vehicle | null) => void;
}

export const useVehicleStore = create<VehicleState>((set) => ({
    vehicles: [],
    selectedVehicle: null,
    setVehicles: (vehicles) => set({ vehicles }),
    updateVehicle: (id, updates) => set((state) => ({
        vehicles: state.vehicles.map((vehicle) => vehicle.id === id ? { ...vehicle, ...updates } : vehicle)
    })),
    selectVehicle: (vehicle) => set({ selectedVehicle: vehicle })
}));
import { create } from "zustand";
import { Vehicle, VehicleType } from "@/types/vehicle";
import { AISStatus } from "@/services/shipsClient";

interface VehicleState {
    vehicles: Vehicle[];
    selectedVehicleId: string | null;
    selectedContinent: string | null;
    dataMode: "live" | "mock";
    aisStatus: AISStatus | null;
    visibleTypes: Set<VehicleType>;
    currentZoom: number;
    setVehicles: (vehicles: Vehicle[]) => void;
    selectVehicle: (id: string | null) => void;
    setDataMode: (mode: "live" | "mock") => void;
    setAisStatus: (status: AISStatus | null) => void;
    toggleType: (type: VehicleType) => void;
    selectContinent: (name: string | null) => void;
    setCurrentZoom: (zoom: number) => void;
}

export const useVehicleStore = create<VehicleState>((set) => ({
    vehicles: [],
    selectedVehicleId: null,
    selectedContinent: null,
    currentZoom: 1.5,
    // UI defaults. The app boots in mock mode so the live-data effect in
    // app/page.tsx doesn't open a poll on first mount; users opt in to live
    // via the SIM/LIVE pill in the top bar or the DATA SOURCE section of
    // the filter popover.
    dataMode: "mock",
    aisStatus: null,
    visibleTypes: new Set<VehicleType>(["truck", "ship", "plane"]),
    setVehicles:  (vehicles)  => set({ vehicles }),
    selectVehicle: (id)       => set({ selectedVehicleId: id }),
    setDataMode:  (mode)      => set({ dataMode: mode }),
    setAisStatus: (aisStatus) => set({ aisStatus }),
    selectContinent: (name) => set ({ selectedContinent: name }),
    setCurrentZoom: (zoom) => set({ currentZoom: zoom }),
    toggleType: (type) =>
        set((state) => {
            const next = new Set(state.visibleTypes);
            if (next.has(type)) {
                if (next.size > 1) next.delete(type); // keep at least one type visible
            } else {
                next.add(type);
            }
            return { visibleTypes: next };
        }),
}));

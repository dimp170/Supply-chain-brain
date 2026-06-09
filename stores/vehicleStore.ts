import { create } from "zustand";
import { Vehicle, VehicleType } from "@/types/vehicle";
import { AISStatus } from "@/api/shipsClient";

/** Legacy data-mode shape retained as a derived value so downstream code
 *  (WorldMap, ChatPanel, BootOverlay, backend NIM context) can keep reading
 *  a single string instead of branching on the two booleans. */
export type DataMode = "live" | "mock" | "demo" | "live+demo";

interface VehicleState {
    vehicles: Vehicle[];
    selectedVehicleId: string | null;
    selectedContinent: string | null;
    /** Two independent toggles. SIM is the implicit state when both are off.
     *  Both can be on at once (combined mode): live AIS/flight data on top of
     *  Petros + active scenario disruptions. */
    demoEnabled: boolean;
    liveEnabled: boolean;
    /** Derived from the two booleans. Kept on state for ergonomic reading by
     *  downstream code (selectors below derive it on writes). */
    dataMode: DataMode;
    aisStatus: AISStatus | null;
    visibleTypes: Set<VehicleType>;
    currentZoom: number;
    /** Demo mode only — id of the active pre-baked scenario (see data/scenarios.ts).
     *  null means the user is in demo mode but hasn't picked a scenario yet,
     *  so the fleet renders untouched (no disruption metadata). */
    activeScenario: string | null;
    /** True when the global AI chat panel is open. UI-only state — sits here
     *  so the TopBar trigger and the page-level panel mount can share it
     *  without prop drilling. */
    chatOpen: boolean;
    setVehicles: (vehicles: Vehicle[]) => void;
    selectVehicle: (id: string | null) => void;
    setDemoEnabled: (on: boolean) => void;
    setLiveEnabled: (on: boolean) => void;
    toggleDemo: () => void;
    toggleLive: () => void;
    setAisStatus: (status: AISStatus | null) => void;
    toggleType: (type: VehicleType) => void;
    selectContinent: (name: string | null) => void;
    setCurrentZoom: (zoom: number) => void;
    setActiveScenario: (id: string | null) => void;
    setChatOpen: (open: boolean) => void;
}

/** Derive the legacy dataMode string from the two independent toggles. */
function deriveDataMode(demoEnabled: boolean, liveEnabled: boolean): DataMode {
    if (demoEnabled && liveEnabled) return "live+demo";
    if (liveEnabled) return "live";
    if (demoEnabled) return "demo";
    return "mock";
}

export const useVehicleStore = create<VehicleState>((set) => ({
    vehicles: [],
    selectedVehicleId: null,
    selectedContinent: null,
    currentZoom: 1.5,
    // UI defaults. The app boots in SIM mode (both toggles off) so the
    // live-data effect in app/page.tsx doesn't open a poll on first mount;
    // users opt in to DEMO or LIVE via the TopBar pills.
    demoEnabled: false,
    liveEnabled: false,
    dataMode: "mock",
    aisStatus: null,
    visibleTypes: new Set<VehicleType>(["truck", "ship", "plane"]),
    activeScenario: null,
    chatOpen: false,
    setVehicles:  (vehicles)  => set({ vehicles }),
    selectVehicle: (id)       => set({ selectedVehicleId: id }),
    setDemoEnabled: (on) =>
        set((state) => ({
            demoEnabled: on,
            dataMode: deriveDataMode(on, state.liveEnabled),
            // Leaving demo clears scenario so disruptions don't linger.
            ...(on ? {} : { activeScenario: null }),
        })),
    setLiveEnabled: (on) =>
        set((state) => ({
            liveEnabled: on,
            dataMode: deriveDataMode(state.demoEnabled, on),
        })),
    toggleDemo: () =>
        set((state) => ({
            demoEnabled: !state.demoEnabled,
            dataMode: deriveDataMode(!state.demoEnabled, state.liveEnabled),
            ...(state.demoEnabled ? { activeScenario: null } : {}),
        })),
    toggleLive: () =>
        set((state) => ({
            liveEnabled: !state.liveEnabled,
            dataMode: deriveDataMode(state.demoEnabled, !state.liveEnabled),
        })),
    setAisStatus: (aisStatus) => set({ aisStatus }),
    selectContinent: (name) => set ({ selectedContinent: name }),
    setCurrentZoom: (zoom) => set({ currentZoom: zoom }),
    setActiveScenario: (id) => set({ activeScenario: id }),
    setChatOpen: (open) => set({ chatOpen: open }),
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

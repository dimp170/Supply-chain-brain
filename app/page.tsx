"use client";

import { useCallback, useEffect, useState } from "react";
import WorldMap from "@/components/map/WorldMap";
import VehicleSidebar from "@/components/sidebar/VehicleSidebar";
import TopBar from "@/components/shell/TopBar";
import SystemStrip from "@/components/shell/SystemStrip";
import BootOverlay from "@/components/boot/BootOverlay";
import { useVehicleStore } from "@/stores/vehicleStore";
import { mockVehicles, moveVehicle } from "@/services/telemetrySimulator";
import { fetchPetrosFleet } from "@/services/petrosFleet";
import { fetchTruckRoute } from "@/services/routingClient";
import { ShipPoller } from "@/services/shipsClient";
import { fetchLivePlanes } from "@/services/planesClient";
import { Vehicle } from "@/types/vehicle";

export default function HomePage() {
    const setVehicles        = useVehicleStore((state) => state.setVehicles);
    const setAisStatus       = useVehicleStore((state) => state.setAisStatus);
    const dataMode           = useVehicleStore((state) => state.dataMode);
    const selectedVehicleId  = useVehicleStore((state) => state.selectedVehicleId);
    const selectContinent    = useVehicleStore((state) => state.selectContinent);
    const selectVehicle      = useVehicleStore((state) => state.selectVehicle);
    // Petros fleet now arrives over HTTP from FastAPI's /api/fleet/petros.
    // We stash it in state so the later mode-switch effect can re-seed it
    // when toggling SIM ↔ LIVE without re-hitting the network.
    const [petrosFleet, setPetrosFleet] = useState<{
        trucks: Vehicle[];
        ships:  Vehicle[];
        planes: Vehicle[];
    }>({ trucks: [], ships: [], planes: [] });

    // UI-only state — drives the cinematic boot overlay. WorldMap signals when
    // Mapbox style.load completes (mapReady) and again when the camera ease
    // finishes (cameraSettled). BootOverlay watches the zustand store for every
    // other readiness signal (AIS, planes, routes, fleet hydration) and only
    // dissolves once the globe is at rest.
    //
    // `bootComplete` flips true after BootOverlay's dissolve animation finishes —
    // we gate the sidebar + system strip reveal on this (NOT cameraSettled),
    // so the right-hand chrome stays invisible during the entire cold-open
    // including the post-camera-settle window where the overlay lingers.
    const [mapReady, setMapReady] = useState(false);
    const [cameraSettled, setCameraSettled] = useState(false);
    const [bootComplete, setBootComplete] = useState(false);

    // Drive bootComplete deterministically off the camera-settled signal rather
    // than threading a callback through BootOverlay. BootOverlay's own dissolve
    // takes ~600ms after its internal trigger fires; we add 800ms here so the
    // sidebar/strip reveal arrives just AFTER the wordmark has finished fading.
    // This avoids a callback round-trip whose dep array kept resetting when
    // page.tsx re-rendered (caused the gate to fire at unpredictable times).
    useEffect(() => {
        if (!cameraSettled) return;
        const t = setTimeout(() => setBootComplete(true), 800);
        return () => clearTimeout(t);
    }, [cameraSettled]);

    // Stable handlers for child components — prevents prop reference churn on
    // every re-render, which was causing BootOverlay's internal effects to
    // cancel/restart and produce flaky timing.
    const handleMapReady       = useCallback(() => setMapReady(true), []);
    const handleCameraSettled  = useCallback(() => setCameraSettled(true), []);

    // Effect 1: Hydrate the initial vehicle fleet. The Petros fleet comes from
    // the FastAPI backend (data/petros_fleet.json). mockVehicles are local
    // simulation seed data for the "ambient" non-Petros world.
    //
    // Truck routes are PRE-LOADED in parallel as soon as the fleet is set, so
    // clicking a truck never waits on a HERE API round-trip. Each route
    // streams into the store as it arrives — effect 1b (lazy) stays as a
    // safety net for trucks whose preload failed.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const fleet = await fetchPetrosFleet();
            if (cancelled) return;
            setPetrosFleet(fleet);
            const initial: Vehicle[] = [
                ...mockVehicles.map((v) => ({ ...v, dataSource: "mock" as const })),
                ...fleet.trucks,
                ...fleet.ships,
                ...fleet.planes,
            ];
            setVehicles(initial);

            // Fire all Petros truck route fetches in parallel. As each one
            // resolves, patch that truck's record in the store. We don't
            // await the whole batch — vehicles are already displayed at
            // their starting positions; routes light up progressively.
            for (const truck of fleet.trucks) {
                (async () => {
                    try {
                        const resp = await fetchTruckRoute(
                            [truck.longitude, truck.latitude],
                            truck.destination,
                        );
                        if (cancelled) return;
                        const store = useVehicleStore.getState();
                        const updated = store.vehicles.map((v) =>
                            v.id === truck.id
                                ? {
                                      ...v,
                                      route: resp.route,
                                      distanceTravelled: 0,
                                      speedLimit: resp.route[0]?.speedLimit ?? 30,
                                  }
                                : v,
                        );
                        store.setVehicles(updated);
                    } catch (err) {
                        console.error(`Failed to preload route for ${truck.id}:`, err);
                    }
                })();
            }
        })();
        return () => { cancelled = true; };
    }, [setVehicles]);

    // Effect 1b: Fetch a truck's route from FastAPI when it's first selected.
    // The backend already decodes the HERE polyline and computes cumulative
    // distance, so we just hand the response straight to the store.
    useEffect(() => {
        if (!selectedVehicleId) return;
        const vehicle = useVehicleStore.getState().vehicles.find((v) => v.id === selectedVehicleId);
        if (!vehicle || vehicle.type !== "truck") return;
        if (vehicle.route.length > 1) return; // already loaded

        let cancelled = false;
        (async () => {
            let routeResp: Awaited<ReturnType<typeof fetchTruckRoute>>;
            try {
                routeResp = await fetchTruckRoute(
                    [vehicle.longitude, vehicle.latitude],
                    vehicle.destination,
                );
            } catch (err) {
                console.error(`Failed to fetch route for ${vehicle.id}:`, err);
                return;
            }
            if (cancelled) return;

            const enrichedRoute = routeResp.route;
            const store = useVehicleStore.getState();
            const updated = store.vehicles.map((v) =>
                v.id === vehicle.id
                    ? {
                          ...v,
                          route: enrichedRoute,
                          distanceTravelled: 0,
                          speedLimit: enrichedRoute[0]?.speedLimit ?? 30,
                      }
                    : v,
            );
            store.setVehicles(updated);
        })();

        return () => { cancelled = true; };
    }, [selectedVehicleId]);

    // Effect 2: Simulate mock truck movement at 50ms intervals.
    useEffect(() => {
        const interval = setInterval(() => {
            const store = useVehicleStore.getState();
            const updated = store.vehicles.map((vehicle) => {
                if (vehicle.type !== "truck" || vehicle.dataSource === "live") return vehicle;
                return moveVehicle(vehicle);
            });
            store.setVehicles(updated);
        }, 50);
        return () => clearInterval(interval);
    }, []);

    // Effect 3: Pull live ships + planes from the FastAPI backend.
    //
    // `ShipPoller` polls /api/vessels and /api/ingestor/status on a 5s interval;
    // the Python ingestor (backend/services/ingestor.py) owns the actual AIS
    // WebSocket subscription. SystemStrip + BootOverlay read AISStatus from
    // the store — same shape as before.
    useEffect(() => {
        if (dataMode !== "live") {
            setAisStatus(null);
            const mockNonTrucks = mockVehicles
                .filter((v) => v.type !== "truck")
                .map((v) => ({ ...v, dataSource: "mock" as const }));
            const trucks = useVehicleStore.getState().vehicles.filter((v) => v.type === "truck");
            // Restore Petros ships & planes so toggling SIM ↔ LIVE doesn't strip
            // them from the store. Live branches already keep them in scope.
            setVehicles([...trucks, ...mockNonTrucks, ...petrosFleet.ships, ...petrosFleet.planes]);
            return;
        }

        const ships = new ShipPoller(
            (liveShips) => {
                const store = useVehicleStore.getState();
                const trucks = store.vehicles.filter((v) => v.type === "truck");
                const planes = store.vehicles.filter((v) => v.type === "plane" && v.dataSource === "live");
                store.setVehicles([...trucks, ...liveShips, ...planes, ...petrosFleet.ships, ...petrosFleet.planes]);
            },
            (status) => setAisStatus(status),
        );
        ships.start();

        // Plane poller — refreshes every 60s.
        const pollPlanes = async () => {
            try {
                const livePlanes = await fetchLivePlanes();
                const store = useVehicleStore.getState();
                const trucks = store.vehicles.filter((v) => v.type === "truck");
                const liveShips = store.vehicles.filter((v) => v.type === "ship" && v.dataSource === "live");
                store.setVehicles([...trucks, ...liveShips, ...livePlanes, ...petrosFleet.ships, ...petrosFleet.planes]);
            } catch (err) {
                console.error("[page] Plane fetch failed:", err);
            }
        };

        pollPlanes();
        const planesInterval = setInterval(pollPlanes, 60_000);

        return () => {
            ships.stop();
            clearInterval(planesInterval);
        };
    }, [dataMode, setVehicles, setAisStatus, petrosFleet]);

    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                selectContinent(null);
                selectVehicle(null);
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [selectContinent, selectVehicle]);

    return (
        <main className="w-screen h-screen flex flex-col bg-black overflow-hidden">
            <TopBar />

            <div className="relative flex-1 flex min-h-0">
                {/* Map canvas — full bleed; the boot overlay sits on top of it. */}
                <div className="relative flex-1 min-w-0">
                    <WorldMap
                        onMapReady={handleMapReady}
                        onCameraSettled={handleCameraSettled}
                    />
                    <BootOverlay
                        mapReady={mapReady}
                        cameraSettled={cameraSettled}
                    />
                </div>

                {/* Right panel — preserved component, sits flush with the canvas.
                 * Gated on bootComplete (not cameraSettled) so the sidebar stays
                 * hidden for the entire cold-open including the window where the
                 * camera has settled but the boot overlay is still on screen
                 * waiting on slower signals (HERE routes, etc.). The sidebar and
                 * SystemStrip both reveal in sync after the wordmark dissolves.
                 * `pointer-events-none` during the hidden phase prevents
                 * accidental clicks landing on an invisible sidebar mid-boot. */}
                <aside
                    className={`w-[360px] shrink-0 border-l border-zinc-800/80 bg-zinc-950 transition-opacity duration-700 ease-out ${
                        bootComplete ? "opacity-100" : "opacity-0 pointer-events-none"
                    }`}
                >
                    <VehicleSidebar />
                </aside>
            </div>

            <SystemStrip visible={bootComplete} />
        </main>
    );
}

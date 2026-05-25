"use client";

import { useEffect, useState } from "react";
import WorldMap from "@/components/map//WorldMap";
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
    const [mapReady, setMapReady] = useState(false);
    const [cameraSettled, setCameraSettled] = useState(false);

    // Effect 1: Hydrate the initial vehicle fleet. The Petros fleet comes from
    // the FastAPI backend (data/petros_fleet.json). mockVehicles are local
    // simulation seed data for the "ambient" non-Petros world. Truck routes
    // are still loaded lazily on selection — see effect 1b below.
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

    return (
        <main className="w-screen h-screen flex flex-col bg-black overflow-hidden">
            <TopBar />

            <div className="relative flex-1 flex min-h-0">
                {/* Map canvas — full bleed; the boot overlay sits on top of it. */}
                <div className="relative flex-1 min-w-0">
                    <WorldMap
                        onMapReady={() => setMapReady(true)}
                        onCameraSettled={() => setCameraSettled(true)}
                    />
                    <BootOverlay mapReady={mapReady} cameraSettled={cameraSettled} />
                </div>

                {/* Right panel — preserved component, sits flush with the canvas. */}
                <aside className="w-[360px] shrink-0 border-l border-zinc-800/80 bg-zinc-950">
                    <VehicleSidebar />
                </aside>
            </div>

            <SystemStrip />
        </main>
    );
}

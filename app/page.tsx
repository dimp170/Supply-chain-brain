"use client";

import { useCallback, useEffect, useState } from "react";
import WorldMap from "@/components/map/WorldMap";
import VehicleSidebar from "@/components/sidebar/VehicleSidebar";
import TopBar from "@/components/shell/TopBar";
import SystemStrip from "@/components/shell/SystemStrip";
import ScenarioStrip from "@/components/shell/ScenarioStrip";
import ChatPanel from "@/components/ai/ChatPanel";
import BootOverlay from "@/components/boot/BootOverlay";
import { useVehicleStore } from "@/stores/vehicleStore";
import { useWeatherStore } from "@/stores/weatherStore";
import { mockVehicles, moveVehicle } from "@/lib/telemetrySimulator";
import { fetchPetrosFleet } from "@/api/petrosFleet";
import { fetchTruckRoute } from "@/api/routingClient";
import { ShipPoller } from "@/api/shipsClient";
import { fetchLivePlanes } from "@/api/planesClient";
import { applyScenario } from "@/lib/applyScenario";
import { SCENARIO_BY_ID } from "@/data/scenarios";
import { Vehicle } from "@/types/vehicle";
import { useWeatherUpdate, useVehicleRiskAssessment } from "@/hooks/useWeatherUpdate";
import { RiskZoneLayer } from "@/components/weather/RiskZoneLayer";
import { ChokepointLayer } from "@/components/map/ChokepointLayer";
import { RerouteLayer } from "@/components/map/RerouteLayer";

export default function HomePage() {
    const setVehicles        = useVehicleStore((state) => state.setVehicles);
    const setAisStatus       = useVehicleStore((state) => state.setAisStatus);
    const demoEnabled        = useVehicleStore((state) => state.demoEnabled);
    const liveEnabled        = useVehicleStore((state) => state.liveEnabled);
    const selectedVehicleId  = useVehicleStore((state) => state.selectedVehicleId);
    const selectContinent    = useVehicleStore((state) => state.selectContinent);
    const selectVehicle      = useVehicleStore((state) => state.selectVehicle);
    const activeScenario     = useVehicleStore((state) => state.activeScenario);

    // Weather state — riskZones is the mock/live source, scenarioRiskZones
    // comes from the active DEMO scenario. The TopBar pill toggles
    // riskZonesVisible; we pass [] to RiskZoneLayer when off so the user gets
    // an uncluttered globe by default.
    const riskZones          = useWeatherStore((state) => state.riskZones);
    const scenarioRiskZones  = useWeatherStore((state) => state.scenarioRiskZones);
    const riskZonesVisible   = useWeatherStore((state) => state.riskZonesVisible);
    const setScenarioRiskZones = useWeatherStore((state) => state.setScenarioRiskZones);
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
    const [mapInstance, setMapInstance] = useState<any>(null);

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
    
    // Weather integration — fetches for mock/sim vehicles only on a 60-minute interval.
    useWeatherUpdate();
    useVehicleRiskAssessment();

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

    // Sync the active scenario's risk zones into the weather store. The
    // weather pill displays them alongside mock weather zones when toggled
    // on. Clears the zones when no scenario is active so old typhoons don't
    // linger after the user changes scenarios.
    useEffect(() => {
        if (!activeScenario) {
            setScenarioRiskZones([]);
            return;
        }
        const scenario = SCENARIO_BY_ID[activeScenario];
        setScenarioRiskZones(scenario?.riskZones ?? []);
    }, [activeScenario, setScenarioRiskZones]);

    // Effect 2: Simulate mock vehicle movement at 50ms intervals — ticks
    // trucks, ships AND planes along their respective routes. Live-source
    // vehicles (real AIS / flight tracking feeds) are excluded so the
    // simulator doesn't fight their authoritative positions.
    useEffect(() => {
        const interval = setInterval(() => {
            const store = useVehicleStore.getState();
            const updated = store.vehicles.map((vehicle) => {
                if (
                    (vehicle.type !== "truck" && vehicle.type !== "ship" && vehicle.type !== "plane")
                    || vehicle.dataSource === "live"
                ) return vehicle;
                return moveVehicle(vehicle);
            });
            store.setVehicles(updated);
        }, 50);
        return () => clearInterval(interval);
    }, []);

    // Effect 3: Pull live ships + planes from the FastAPI backend when
    // liveEnabled is on. Apply scenario disruptions to the Petros fleet when
    // demoEnabled is on. Both can be on at once (combined mode).
    //
    // Critical bug fix: previously this effect set `petrosFleet.ships` /
    // `petrosFleet.planes` straight from the initial-fetch state on every
    // mode change, which RESET ship/plane positions to where they were when
    // the page first loaded. Now we read the current positions out of the
    // store first and fall back to petrosFleet only when the store doesn't
    // yet have any (first load). Trucks were already handled this way.
    useEffect(() => {
        const scenarioId = demoEnabled ? activeScenario : null;

        // Read the freshest store state when the effect fires so we don't
        // capture stale closures from earlier renders.
        const store = useVehicleStore.getState();
        const currentTrucks = store.vehicles.filter(
            (v) => v.type === "truck" && v.company === "Petros Transport",
        );
        const currentPetrosShips = store.vehicles.filter(
            (v) => v.type === "ship"
                && v.company === "Petros Transport"
                && v.dataSource !== "live",
        );
        const currentPetrosPlanes = store.vehicles.filter(
            (v) => v.type === "plane"
                && v.company === "Petros Transport"
                && v.dataSource !== "live",
        );
        // Preserve drift: keep the simulator's evolved positions across mode
        // switches; fall back to the initial fleet only on first load.
        const petrosShips  = currentPetrosShips.length  ? currentPetrosShips  : petrosFleet.ships;
        const petrosPlanes = currentPetrosPlanes.length ? currentPetrosPlanes : petrosFleet.planes;

        if (!liveEnabled) {
            setAisStatus(null);
            // SIM/DEMO (live off): no external feeds. Ambient non-Petros mock
            // ships/planes are shown only in pure SIM, not DEMO — keeps the
            // scenario stage focused on the Petros fleet during a demo.
            const mockNonTrucks = !demoEnabled
                ? mockVehicles
                    .filter((v) => v.type !== "truck")
                    .map((v) => ({ ...v, dataSource: "mock" as const }))
                : [];
            const all = [...currentTrucks, ...mockNonTrucks, ...petrosShips, ...petrosPlanes];
            setVehicles(applyScenario(all, scenarioId));
            return;
        }

        // LIVE on (with or without demo): start the AIS poller + plane poll.
        // Both pollers re-read store state in their callbacks so Petros drift
        // is preserved across each refresh, and scenario tagging is re-applied.

        // Immediate seed so the user sees Petros + scenario tagging right away,
        // before the first live tick lands.
        const initialAll = [...currentTrucks, ...petrosShips, ...petrosPlanes];
        setVehicles(applyScenario(initialAll, scenarioId));

        const ships = new ShipPoller(
            (liveShips) => {
                const s = useVehicleStore.getState();
                const trucks = s.vehicles.filter((v) => v.type === "truck");
                const livePlanes = s.vehicles.filter(
                    (v) => v.type === "plane" && v.dataSource === "live",
                );
                const ps = s.vehicles.filter(
                    (v) => v.type === "ship"
                        && v.company === "Petros Transport"
                        && v.dataSource !== "live",
                );
                const pp = s.vehicles.filter(
                    (v) => v.type === "plane"
                        && v.company === "Petros Transport"
                        && v.dataSource !== "live",
                );
                const petrosS = ps.length ? ps : petrosFleet.ships;
                const petrosP = pp.length ? pp : petrosFleet.planes;
                s.setVehicles(
                    applyScenario(
                        [...trucks, ...liveShips, ...livePlanes, ...petrosS, ...petrosP],
                        scenarioId,
                    ),
                );
            },
            (status) => setAisStatus(status),
        );
        ships.start();

        const pollPlanes = async () => {
            try {
                const livePlanes = await fetchLivePlanes();
                const s = useVehicleStore.getState();
                const trucks = s.vehicles.filter((v) => v.type === "truck");
                const liveShips = s.vehicles.filter(
                    (v) => v.type === "ship" && v.dataSource === "live",
                );
                const ps = s.vehicles.filter(
                    (v) => v.type === "ship"
                        && v.company === "Petros Transport"
                        && v.dataSource !== "live",
                );
                const pp = s.vehicles.filter(
                    (v) => v.type === "plane"
                        && v.company === "Petros Transport"
                        && v.dataSource !== "live",
                );
                const petrosS = ps.length ? ps : petrosFleet.ships;
                const petrosP = pp.length ? pp : petrosFleet.planes;
                s.setVehicles(
                    applyScenario(
                        [...trucks, ...liveShips, ...livePlanes, ...petrosS, ...petrosP],
                        scenarioId,
                    ),
                );
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
    }, [demoEnabled, liveEnabled, activeScenario, setVehicles, setAisStatus, petrosFleet]);

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

            {/* Scenario strip — only rendered in DEMO mode. Sits between the
             *  TopBar and the map canvas so it doesn't compete with the
             *  globe for vertical space when not in use. */}
            {demoEnabled && bootComplete && <ScenarioStrip />}

            <div className="relative flex-1 flex min-h-0">
                {/* Map canvas — full bleed; the boot overlay sits on top of it. */}
                <div className="relative flex-1 min-w-0">
                    <WorldMap
                        onMapReady={handleMapReady}
                        onCameraSettled={handleCameraSettled}
                        onMapInstance={setMapInstance}
                    />
                    {mapInstance && (
                        <RiskZoneLayer
                            map={mapInstance}
                            riskZones={riskZonesVisible ? [...riskZones, ...scenarioRiskZones] : []}
                        />
                    )}
                    {mapInstance && <ChokepointLayer map={mapInstance} />}
                    {mapInstance && <RerouteLayer map={mapInstance} />}
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

            {/* Global AI chat — slides in from the right edge as an overlay.
             *  Self-positioning (fixed inset-0 internally) so it doesn't
             *  consume layout space when closed. Visibility is store-driven
             *  via useVehicleStore.chatOpen; TopBar's ASK AI toggles it. */}
            <ChatPanel />
        </main>
    );
}

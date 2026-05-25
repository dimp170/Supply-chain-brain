"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import { useVehicleStore } from "@/stores/vehicleStore";
import { createVehicleMarkerElement, getVehicleColor } from "./VehicleMarker";

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!;

const R = Math.PI / 180;

// Returns cos(angular distance) between two globe points.
// Positive → front hemisphere, negative → back hemisphere.
function cosAngularDist(lat1: number, lng1: number, lat2: number, lng2: number): number {
    return (
        Math.sin(lat1 * R) * Math.sin(lat2 * R) +
        Math.cos(lat1 * R) * Math.cos(lat2 * R) * Math.cos((lng1 - lng2) * R)
    );
}

interface WorldMapProps {
    /** Fires once Mapbox style.load has completed — the boot overlay subscribes to this. */
    onMapReady?: () => void;
    /** Fires once the cinematic camera ease-in has finished — the boot overlay
     *  uses this to hold itself in place until the globe is at rest. */
    onCameraSettled?: () => void;
}

export default function WorldMap({ onMapReady, onCameraSettled }: WorldMapProps = {}) {
    const mapContainer = useRef<HTMLDivElement | null>(null);
    const mapRef       = useRef<mapboxgl.Map | null>(null);
    const markersRef   = useRef<Map<string, mapboxgl.Marker>>(new Map());

    const [mapLoaded, setMapLoaded] = useState(false);
    // True once the cinematic camera ease-in (zoom 0.3 → 1.5) has finished.
    // Marker creation is gated on this so vehicle icons never get clamped to
    // the screen edge while the globe is small and the viewport is wide.
    const [cameraSettled, setCameraSettled] = useState(false);
    const hasBootedRef = useRef(false);
    const onMapReadyRef = useRef(onMapReady);
    const onCameraSettledRef = useRef(onCameraSettled);
    useEffect(() => { onMapReadyRef.current = onMapReady; }, [onMapReady]);
    useEffect(() => { onCameraSettledRef.current = onCameraSettled; }, [onCameraSettled]);

    const vehicles          = useVehicleStore((state) => state.vehicles);
    const selectVehicle     = useVehicleStore((state) => state.selectVehicle);
    const dataMode          = useVehicleStore((state) => state.dataMode);
    const visibleTypes      = useVehicleStore((state) => state.visibleTypes);

    // The "Petros only" company filter is gone — the SIM/LIVE pill carries that
    // semantic now. Always hide third-party mock seeds (non-Petros + non-live) so
    // SIM cleanly shows the Petros fleet and LIVE shows Petros + external feeds.
    const visibleVehicles = useMemo(
        () => vehicles.filter((v) => {
            if (!visibleTypes.has(v.type)) return false;
            if (v.company !== "Petros Transport" && v.dataSource !== "live") return false;
            return true;
        }),
        [vehicles, visibleTypes]
    );

    // Changes when fleet structure, mode, or visible types change — triggers full marker redraw.
    const vehicleStructureKey = useMemo(
        () =>
            `${dataMode}:${[...visibleTypes].sort().join(",")}:` +
            visibleVehicles.map((v) => `${v.id}:${v.route.length}`).join("|"),
        [visibleVehicles, dataMode, visibleTypes]
    );

    // Init map once.
    // Boot sequence: start far out in "space" with the globe small, then ease in
    // to the operating view while the BootOverlay's checklist resolves. The
    // longitude-based marker cascade fires after the camera settles — see the
    // heavy effect below for the appearDelay math.
    useEffect(() => {
        if (!mapContainer.current || mapRef.current) return;

        // Honour reduced-motion: skip the cinematic ease and land at the home view immediately.
        const prefersReducedMotion =
            typeof window !== "undefined" &&
            window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

        const map = new mapboxgl.Map({
            container:  mapContainer.current,
            style:      "mapbox://styles/mapbox/dark-v11",
            center:     [0, 20],
            zoom:       prefersReducedMotion ? 1.5 : 0.3,
            bearing:    prefersReducedMotion ? 0   : -18,
            pitch:      0,
            projection: "globe" as any,
        });
        mapRef.current = map;

        map.on("style.load", () => {
            // Cinematic deep-space atmosphere — only meaningful with projection: "globe".
            try {
                map.setFog({
                    color:           "rgb(20, 28, 42)",   // lower atmosphere
                    "high-color":    "rgb(36, 92, 223)",  // upper atmosphere limb
                    "horizon-blend": 0.02,
                    "space-color":   "rgb(2, 4, 10)",     // deep space
                    "star-intensity": 0.65,
                });
            } catch {
                /* Older Mapbox builds may not support every fog field — non-fatal. */
            }
        });

        map.on("load", () => {
            setMapLoaded(true);
            onMapReadyRef.current?.();

            // Ease in to the operating view. Skipped under reduced-motion (already at home).
            if (!prefersReducedMotion) {
                map.easeTo({
                    center:   [0, 20],
                    zoom:     1.5,
                    bearing:  0,
                    pitch:    0,
                    duration: 1800,
                    easing:   (t: number) =>
                        // easeOutCubic — settles smoothly without overshoot
                        1 - Math.pow(1 - t, 3),
                });
                // Mark the camera settled once the ease completes — marker
                // creation is gated on this so icons don't appear clamped to
                // screen edges while the globe is still small.
                map.once("moveend", () => {
                    setCameraSettled(true);
                    onCameraSettledRef.current?.();
                });
            } else {
                // Reduced-motion users start at the home view — nothing to wait for.
                setCameraSettled(true);
                onCameraSettledRef.current?.();
            }
        });
    }, []);

    // Globe culling: on every render frame, hide markers on the back hemisphere.
    // Mapbox GL does NOT do this automatically for HTML markers.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapLoaded) return;

        const cull = () => {
            const { lat: cLat, lng: cLng } = map.getCenter();
            markersRef.current.forEach((marker) => {
                const { lat, lng } = marker.getLngLat();
                const front = cosAngularDist(lat, lng, cLat, cLng) > 0;
                marker.getElement().style.display = front ? "" : "none";
            });
        };

        map.on("render", cull);
        return () => { map.off("render", cull); };
    }, [mapLoaded]);

    // Heavy effect: recreate markers and route lines when fleet structure changes.
    // Gated on cameraSettled so markers don't render at clamped screen edges
    // while the cinematic ease-in is still in flight.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapLoaded || !cameraSettled) return;

        const SWEEP_MS = 2500;
        const isBootSequence = !hasBootedRef.current && visibleVehicles.length > 0;
        if (isBootSequence) {
            hasBootedRef.current = true;
        }

        markersRef.current.forEach((marker) => marker.remove());
        markersRef.current.clear();

        visibleVehicles.forEach((vehicle) => {
            const routeID = `route-${vehicle.id}`;

            try {
                if (map.getSource(routeID)) {
                    map.removeLayer(routeID);
                    map.removeSource(routeID);
                }
            } catch { /* already removed */ }

            if (vehicle.route.length >= 2) {
                try {
                    map.addSource(routeID, {
                        type: "geojson",
                        data: {
                            type:     "Feature",
                            geometry: {
                                type:        "LineString",
                                coordinates: vehicle.route.map((p) => [p.lng, p.lat]),
                            },
                            properties: {},
                        },
                    });
                    map.addLayer({
                        id:     routeID,
                        type:   "line",
                        source: routeID,
                        layout: { "line-join": "round", "line-cap": "round" },
                        paint:  {
                            "line-color":
                                vehicle.type === "plane" ? "#60a5fa" :
                                vehicle.type === "ship"  ? "#22c55e" :
                                "#f59e0b",
                            "line-width":   4,
                            "line-opacity": 0.4,
                        },
                    });
                } catch { /* map not ready */ }
            }

            const appearDelay = isBootSequence
                ? Math.round(((vehicle.longitude + 180) / 360) * SWEEP_MS)
                : undefined;

            const el = createVehicleMarkerElement(vehicle, appearDelay, getVehicleColor(vehicle));
            el.addEventListener("click", () => selectVehicle(vehicle.id));

            const marker = new mapboxgl.Marker(el)
                .setLngLat([vehicle.longitude, vehicle.latitude])
                .addTo(map);

            markersRef.current.set(vehicle.id, marker);
        });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mapLoaded, cameraSettled, vehicleStructureKey]);

    // Light effect: update positions every tick.
    useEffect(() => {
        visibleVehicles.forEach((vehicle) => {
            markersRef.current.get(vehicle.id)?.setLngLat([vehicle.longitude, vehicle.latitude]);
        });
    }, [visibleVehicles]);

    // Fit camera to the selected truck's route. Fires whenever the selection
    // changes OR the selected truck's route data arrives (after the lazy fetch
    // in page.tsx). Non-truck selections are no-ops — the panel handles them.
    // The trigger is a stable string key so this effect doesn't re-fire on
    // every simulator tick (which changes vehicle.longitude / .latitude).
    const selectedVehicleId = useVehicleStore((state) => state.selectedVehicleId);
    const selectedRouteSignature = useMemo(() => {
        if (!selectedVehicleId) return null;
        const v = vehicles.find((x) => x.id === selectedVehicleId);
        if (!v || v.type !== "truck") return null;
        return `${v.id}:${v.route.length >= 2 ? "ready" : "pending"}`;
    }, [vehicles, selectedVehicleId]);

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapLoaded || !cameraSettled) return;
        if (!selectedRouteSignature || !selectedRouteSignature.endsWith(":ready")) return;

        // Read the freshest vehicle data inside the effect so we don't capture
        // a stale closure (position updates every tick).
        const vehicle = useVehicleStore.getState().vehicles.find((v) => v.id === selectedVehicleId);
        if (!vehicle || vehicle.type !== "truck" || vehicle.route.length < 2) return;

        // Build the bounding box around every route point + the truck's
        // current position so the camera frames the whole journey.
        const lngs = vehicle.route.map((p) => p.lng).concat(vehicle.longitude);
        const lats = vehicle.route.map((p) => p.lat).concat(vehicle.latitude);
        const sw: [number, number] = [Math.min(...lngs), Math.min(...lats)];
        const ne: [number, number] = [Math.max(...lngs), Math.max(...lats)];

        map.fitBounds([sw, ne], {
            padding: { top: 80, right: 80, bottom: 80, left: 80 },
            duration: 1200,
            essential: true,
            maxZoom: 9,
        });
    }, [selectedRouteSignature, selectedVehicleId, mapLoaded, cameraSettled]);

    return (
        <div className="relative w-full h-full">
            <div ref={mapContainer} className="w-full h-full" />
        </div>
    );
}


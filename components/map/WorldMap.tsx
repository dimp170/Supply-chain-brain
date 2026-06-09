"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import { useVehicleStore } from "@/stores/vehicleStore";
import { createVehicleMarkerElement, getVehicleColor } from "./VehicleMarker";
import { CONTINENTS, type ContinentCode } from "@/data/continents";
import continentsBorders from "@/data/continents-borders.json";
import type { FeatureCollection, MultiPolygon } from "geojson";
const continents = continentsBorders as FeatureCollection<MultiPolygon, { CONTINENT: string }>;
mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!;
const R = Math.PI / 180;

// Cull boundary as cos(angular distance). Strictly 0 puts the cut at the
// exact horizon (90° from center), but markers right at that boundary
// project to coordinates slightly off the visible globe disk, where they
// flash briefly between render frames. 0.1 (~84°) adds a ~6° buffer so
// marginal markers are hidden consistently and don't oscillate at the rim.
const HORIZON_BUFFER = 0.2;

// Unwrap antimeridian crossings for a coordinate array so the Mapbox GeoJSON
// line renderer doesn't back-track across the globe. atan2 wraps longitude to
// [-180,180]; when a Pacific route crosses 180° the naive jump (e.g. 178°→-179°)
// draws the segment in the wrong direction. Extending past ±180 (e.g. 190° or
// -190°) is valid for Mapbox on both globe and Mercator projections.
function unwrapAntimeridian(coords: [number, number][]): [number, number][] {
    if (coords.length === 0) return coords;
    const out: [number, number][] = [coords[0]];
    for (let i = 1; i < coords.length; i++) {
        let [lng, lat] = coords[i];
        const prevLng = out[i - 1][0];
        const diff = lng - prevLng;
        if (diff > 180) lng -= 360;
        else if (diff < -180) lng += 360;
        out.push([lng, lat]);
    }
    return out;
}

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
    /** Callback to receive the map instance for integrations like weather layers. */
    onMapInstance?: (map: mapboxgl.Map) => void;
}

export default function WorldMap({ onMapReady, onCameraSettled, onMapInstance }: WorldMapProps = {}) {
    const mapContainer = useRef<HTMLDivElement | null>(null);
    const mapRef       = useRef<mapboxgl.Map | null>(null);
    const markersRef   = useRef<Map<string, mapboxgl.Marker>>(new Map());
    const prevContinentRef = useRef<string | null>(null);
    const prevVehicleRef = useRef<string | null>(null);
    const [mapLoaded, setMapLoaded] = useState(false);
    // True once the cinematic camera ease-in (zoom 0.3 → 1.5) has finished.
    // Marker creation is gated on this so vehicle icons never get clamped to
    // the screen edge while the globe is small and the viewport is wide.
    const [cameraSettled, setCameraSettled] = useState(false);
    const hasBootedRef = useRef(false);

    // Counter that bumps when we want to FORCE the marker creation effect to
    // re-run. On the initial boot pass, Mapbox's globe projection sometimes
    // isn't fully settled when addTo() fires, so markers fail to bind to
    // lng/lat and visually "float" until the next user-triggered recreation.
    // The first creation schedules a kick to bump this counter ~600ms later,
    // which re-runs the same effect under the exact conditions that work
    // post-event. Subsequent (user-triggered) recreations don't need it.
    const [recreationKick, setRecreationKick] = useState(0);

    const onMapReadyRef = useRef(onMapReady);
    const onCameraSettledRef = useRef(onCameraSettled);
    const onMapInstanceRef = useRef(onMapInstance);
    useEffect(() => { onMapReadyRef.current = onMapReady; }, [onMapReady]);
    useEffect(() => { onCameraSettledRef.current = onCameraSettled; }, [onCameraSettled]);
    useEffect(() => { onMapInstanceRef.current = onMapInstance; }, [onMapInstance]);

    const vehicles          = useVehicleStore((state) => state.vehicles);
    const selectVehicle     = useVehicleStore((state) => state.selectVehicle);
    const dataMode          = useVehicleStore((state) => state.dataMode);
    const visibleTypes      = useVehicleStore((state) => state.visibleTypes);
    const selectedContinent = useVehicleStore((state) => state.selectedContinent);
    const setCurrentZoom = useVehicleStore((state) => state.setCurrentZoom);

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
            onMapInstanceRef.current?.(map);

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

    // Globe culling: hide markers on the back hemisphere of the sphere.
    // Mapbox GL does NOT do this automatically for HTML markers, so we
    // compute angular distance from each marker to the current map center
    // and toggle `display`. Lifted into a stable callback so the marker
    // creation effect can call it synchronously after addTo() — relying on
    // map.on("render") alone was racy: the render event sometimes fired
    // before the marker had its first projection, leaving back-hemisphere
    // markers visible until the next user interaction kicked things loose.
    const cull = useCallback(() => {
        const map = mapRef.current;
        if (!map) return;
        const { lat: cLat, lng: cLng } = map.getCenter();
        markersRef.current.forEach((marker) => {
            const { lat, lng } = marker.getLngLat();
            const front = cosAngularDist(lat, lng, cLat, cLng) > HORIZON_BUFFER;
            // Use a CSS class with !important rather than inline display so
            // Mapbox's per-render style.display = "block" assignment can't
            // override us between cull passes (that override caused
            // back-hemisphere markers to briefly flash at the globe rim
            // on every recreation).
            marker.getElement().classList.toggle("marker-back-hemisphere", !front);
        });
    }, []);

    // Keep culling continuously as the user rotates / pans the globe.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapLoaded) return;
        map.on("render", cull);
        return () => { map.off("render", cull); };
    }, [mapLoaded, cull]);

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
            // Schedule a second creation pass once Mapbox has had a beat to
            // fully settle. The first pass during boot can leave markers
            // un-anchored (they "float" with the camera instead of binding
            // to lng/lat); the second pass — which runs through the exact
            // same effect under post-settled conditions — fixes them. This
            // mimics what user-triggered events do, just programmatically.
            window.setTimeout(() => setRecreationKick((n) => n + 1), 600);
        }

        markersRef.current.forEach((marker) => marker.remove());
        markersRef.current.clear();

        visibleVehicles.forEach((vehicle) => {
            // Route layers are managed by a dedicated effect below — keyed on
            // selectedVehicleId so a route only renders for the currently
            // selected truck. Keeping route logic out of this hot path also
            // means marker recreation doesn't repaint a polyline every tick.

            const appearDelay = isBootSequence
                ? Math.round(((vehicle.longitude + 180) / 360) * SWEEP_MS)
                : undefined;

            const el = createVehicleMarkerElement(vehicle, appearDelay, getVehicleColor(vehicle));
            el.addEventListener("click", () => selectVehicle(vehicle.id));

            // Pre-cull: decide visibility BEFORE addTo() so back-hemisphere
            // markers never paint visible. Uses the same !important CSS class
            // as cull() so Mapbox's per-render display:"block" can't override
            // it. Without this, recreations briefly flash back-hemisphere
            // markers at the globe's edge between addTo() and the post-loop
            // cull().
            const center = map.getCenter();
            const isFront =
                cosAngularDist(vehicle.latitude, vehicle.longitude, center.lat, center.lng) > HORIZON_BUFFER;
            if (!isFront) el.classList.add("marker-back-hemisphere");

            // Rotate ships, planes, AND trucks to face their direction of
            // travel. Truck headings now flow from moveVehicle (computed as
            // bearing from previous→new position along the HERE route),
            // making the cab point in the direction of motion.
            // rotationAlignment "viewport" keeps the icon orientation stable
            // as the user pans the globe; rotating with the map made markers
            // spin weirdly near the poles.
            const shouldRotate = vehicle.type === "ship" || vehicle.type === "plane" || vehicle.type === "truck";
            const marker = new mapboxgl.Marker({
                element: el,
                rotation: shouldRotate ? (vehicle.heading || 0) : 0,
                rotationAlignment: "viewport",
            })
                .setLngLat([vehicle.longitude, vehicle.latitude])
                .addTo(map);

            markersRef.current.set(vehicle.id, marker);
        });

        // Synchronously cull immediately after creation so back-hemisphere
        // markers are hidden before they ever paint. Previously we relied on
        // map.triggerRepaint() → "render" event → cull, but on initial mount
        // that round-trip was racy and back-hemisphere markers would remain
        // visible until the user clicked something. Calling cull() directly
        // here removes the race; triggerRepaint() stays as belt-and-suspenders
        // so anything that needs an actual paint also gets one. The map.once
        // "idle" hook is a final safety net — "idle" fires only after Mapbox
        // has finished every queued render, so by then every marker has
        // definitely had its initial _update() and the cull can read
        // authoritative positions.
        cull();
        map.triggerRepaint();
        map.once("idle", () => {
            cull();
            // Nudge a no-op camera move so Mapbox runs its full marker-update
            // pass — covers the rare case where addTo() left a marker without
            // an inline transform on the initial mount. panBy([0, 0]) fires
            // "move" + "render" without actually shifting the camera.
            map.panBy([0, 0], { duration: 0 });
        });
    // Deps intentionally exclude `visibleVehicles` — it's the per-tick object
    // reference that changes every simulator update. We key marker recreation
    // on `vehicleStructureKey` (a stable hash of {id, route.length}) instead,
    // so this heavy effect only re-runs when fleet structure actually changes.
    // The lightweight position-update effect below handles per-tick movement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mapLoaded, cameraSettled, vehicleStructureKey, cull, recreationKick]);

    // Light effect: update positions every tick. Also refresh heading-based
    // rotation for ships and planes so the icon points where the vehicle is
    // currently traveling. Heading changes are typically tiny per tick, but
    // applying every frame keeps the rotation in lockstep with position.
    useEffect(() => {
        visibleVehicles.forEach((vehicle) => {
            const m = markersRef.current.get(vehicle.id);
            if (!m) return;
            m.setLngLat([vehicle.longitude, vehicle.latitude]);
            if (vehicle.type === "ship" || vehicle.type === "plane" || vehicle.type === "truck") {
                m.setRotation(vehicle.heading || 0);
            }
        });
    }, [visibleVehicles]);

    // Fit camera to the selected truck's route. Fires whenever the selection
    // changes OR the selected truck's route data arrives (after the lazy fetch
    // in page.tsx). Non-truck selections are no-ops — the panel handles them.
    // The trigger is a stable string key so this effect doesn't re-fire on
    // every simulator tick (which changes vehicle.longitude / .latitude).
    //
    // Ships also have routes now (sea-routing via backend), but we DON'T
    // fitBounds for them — trans-oceanic routes would zoom the globe out
    // to a useless level. Ship selection keeps the existing easeTo to the
    // vessel's current position (zoom 5), and the route polyline renders
    // around it so the user can pan/scroll to follow it.
    const selectedVehicleId = useVehicleStore((state) => state.selectedVehicleId);
    const selectedRouteSignature = useMemo(() => {
        if (!selectedVehicleId) return null;
        const v = vehicles.find((x) => x.id === selectedVehicleId);
        if (!v) return null;
        // Route-bearing types: trucks (HERE-routed), ships (sea-routed),
        // planes (great-circle). Used as a stable trigger so the route
        // layer effect re-fires when the selected vehicle's route data
        // transitions from pending -> ready.
        if (v.type !== "truck" && v.type !== "ship" && v.type !== "plane") return null;
        return `${v.id}:${v.type}:${v.route.length >= 2 ? "ready" : "pending"}`;
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

    // Ship/plane fly-to. Trucks use the fitBounds effect above (they have a
    // polyline to frame). Ships and planes are points — just ease the camera
    // to their current position at a region-ish zoom. Deps deliberately omit
    // vehicle.longitude/latitude so this fires once per selection, not on
    // every simulator tick (which would whip the camera around following
    // moving markers).
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapLoaded || !cameraSettled) return;
        if (!selectedVehicleId) return;
        const vehicle = useVehicleStore.getState().vehicles.find((v) => v.id === selectedVehicleId);
        if (!vehicle) return;
        if (vehicle.type !== "ship" && vehicle.type !== "plane") return;

        map.easeTo({
            center:   [vehicle.longitude, vehicle.latitude],
            zoom:     5,
            duration: 1200,
            essential: true,
        });
    }, [selectedVehicleId, mapLoaded, cameraSettled]);

    // Selected-vehicle highlight: toggle a `marker-selected` class on the
    // currently-selected marker so its SVG gets the white drop-shadow halo
    // defined in globals.css. Fires whenever selection changes — runs across
    // ALL current markers since selection can flip on/off any of them.
    // vehicleStructureKey is in deps so the class also re-applies after
    // marker recreation (otherwise selecting then toggling SIM/LIVE would
    // lose the halo).
    useEffect(() => {
        markersRef.current.forEach((marker, id) => {
            marker.getElement().classList.toggle("marker-selected", id === selectedVehicleId);
        });
    }, [selectedVehicleId, vehicleStructureKey]);

    // Route layer management — renders the SELECTED vehicle's route polyline.
    // Currently supports trucks (HERE-routed via FastAPI proxy) and ships
    // (sea-routed via backend services/sea_routing.py — waypoint catalog +
    // chokepoint chains so ships don't try to cross continents). Planes get
    // no route line for now; their pair of dep/arr airports + altitude is
    // enough context in the sidebar.
    //
    // Color matches the vehicle accent so a selected ship's route is cyan
    // and a selected truck's is amber — visually keyed to the marker.
    // Clears all route-* sources/layers on every run and rebuilds for the
    // current selection only so they don't persist after deselect or switch.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapLoaded) return;

        // Wipe any existing route-* sources/layers.
        const style = map.getStyle();
        const sourceIds = style && style.sources ? Object.keys(style.sources) : [];
        sourceIds.filter((id) => id.startsWith("route-")).forEach((id) => {
            try { if (map.getLayer(id))  map.removeLayer(id); } catch { /* gone */ }
            try { if (map.getSource(id)) map.removeSource(id); } catch { /* gone */ }
        });

        if (!selectedVehicleId) return;
        const vehicle = useVehicleStore
            .getState()
            .vehicles.find((v) => v.id === selectedVehicleId);
        if (!vehicle) return;
        // Trucks (HERE-routed), ships (sea-routed) and planes (great-circle)
        // all carry polyline routes. Live-source vehicles still have empty
        // routes, so the length check below is what excludes them — no
        // dataSource gate needed here.
        if (vehicle.type !== "truck" && vehicle.type !== "ship" && vehicle.type !== "plane") return;
        if (vehicle.route.length < 2) return;

        // Route line color matches the vehicle accent: cyan ships, rose
        // planes, amber trucks. Dark (already-travelled) variant is one
        // shade step down the same hue.
        const remainingColor =
            vehicle.type === "ship"  ? "#22d3ee" :
            vehicle.type === "plane" ? "#f43f5e" :
            /* truck */                "#f59e0b";
        const travelledColor =
            vehicle.type === "ship"  ? "#0e7490" :
            vehicle.type === "plane" ? "#9f1239" :
            /* truck */                "#b45309";

        // Unwrap antimeridian on the full coordinate array first, then split,
        // so longitudes stay continuous across the dateline in both segments.
        const allCoords = unwrapAntimeridian(
            vehicle.route.map((p) => [p.lng, p.lat] as [number, number])
        );

        // Find where the vehicle sits on the route by closest-point matching
        // against its current position. Position-based works for both trucks
        // (which DO move via the simulator and have non-zero distanceTravelled)
        // and ships (which don't move and would always read distanceTravelled=0
        // under the old logic — meaning no travelled segment ever rendered).
        const vehiclePos: [number, number] = [vehicle.longitude, vehicle.latitude];
        let splitIdx = 0;
        {
            const cosLat = Math.cos(vehicle.latitude * Math.PI / 180);
            let minDistSq = Infinity;
            for (let i = 0; i < allCoords.length; i++) {
                const [plng, plat] = allCoords[i];
                // Wrap-aware longitude delta — keeps closest-point math sane
                // for Pacific routes that straddle the antimeridian.
                let dlng = plng - vehicle.longitude;
                while (dlng > 180) dlng -= 360;
                while (dlng < -180) dlng += 360;
                const dlat = plat - vehicle.latitude;
                const wdlng = dlng * cosLat;
                const distSq = dlat * dlat + wdlng * wdlng;
                if (distSq < minDistSq) {
                    minDistSq = distSq;
                    splitIdx = i;
                }
            }
        }

        // Travelled segment: route start → vehicle's current position (dark, thinner).
        // Only meaningful when the vehicle is past the route origin — splitIdx > 0.
        if (splitIdx > 0) {
            // Route start → split index inclusive, then a short hop to the
            // ship's exact current position so the dark segment terminates
            // visibly at the marker (not at the nearest network node).
            const travelledCoords: [number, number][] = [
                ...allCoords.slice(0, splitIdx + 1),
                vehiclePos,
            ];
            const travelledID = `route-travelled-${vehicle.id}`;
            try {
                map.addSource(travelledID, {
                    type: "geojson",
                    data: {
                        type: "Feature",
                        geometry: { type: "LineString", coordinates: travelledCoords },
                        properties: {},
                    },
                });
                map.addLayer({
                    id: travelledID,
                    type: "line",
                    source: travelledID,
                    layout: { "line-join": "round", "line-cap": "round" },
                    paint: {
                        "line-color":   travelledColor,
                        "line-width":   3,
                        "line-opacity": 0.4,
                    },
                });
            } catch { /* map not ready */ }
        }

        // Remaining segment: vehicle's current position → route end (bright).
        // Skip the splitIdx point itself (already in the travelled segment) so
        // the two lines meet cleanly at the marker without drawing an
        // overlapping micro-segment.
        const remainingCoords: [number, number][] = [vehiclePos, ...allCoords.slice(splitIdx + 1)];
        if (remainingCoords.length >= 2) {
            const remainingID = `route-remaining-${vehicle.id}`;
            try {
                map.addSource(remainingID, {
                    type: "geojson",
                    data: {
                        type: "Feature",
                        geometry: { type: "LineString", coordinates: remainingCoords },
                        properties: {},
                    },
                });
                map.addLayer({
                    id: remainingID,
                    type: "line",
                    source: remainingID,
                    layout: { "line-join": "round", "line-cap": "round" },
                    paint: {
                        "line-color":   remainingColor,
                        "line-width":   4,
                        "line-opacity": 0.55,
                    },
                });
            } catch { /* map not ready */ }
        }
    }, [mapLoaded, selectedVehicleId, selectedRouteSignature]);

    const feature = continents.features.find(
    (f) => f.properties.CONTINENT === selectedContinent
    );

    useEffect(() => {
        const HIGHLIGHT_ID = "continent-highlight";
        const map = mapRef.current;
        if (!map || !mapLoaded) return;
        try { if (map.getLayer(HIGHLIGHT_ID))  map.removeLayer(HIGHLIGHT_ID); } catch { /* gone */ }
        try { if (map.getSource(HIGHLIGHT_ID)) map.removeSource(HIGHLIGHT_ID); } catch { /* gone */ }
        // Bail if no continent is selected OR if a vehicle is selected.
        // The cleanup above already ran, so in either case the highlight is
        // visually gone. State (selectedContinent) is preserved so when the
        // truck/vehicle is dismissed, this effect re-runs and the highlight
        // reappears for the still-selected continent.
        if (!selectedContinent || selectedVehicleId) return;
        const features = continents.features.filter((f) => {
            const name = f.properties.CONTINENT.toUpperCase();
            return name === selectedContinent
                || (selectedContinent === "OCEANIA" && name === "AUSTRALIA");
        });
        if (!feature) return;
        try {
            map.addSource(HIGHLIGHT_ID, {
                type: "geojson",
                data: {
                    type: "FeatureCollection",
                    features: features
                },
            });
            map.addLayer({
                id: HIGHLIGHT_ID,
                type: "line",
                source: HIGHLIGHT_ID,
                layout: { "line-join": "round", "line-cap": "round" },
                paint:  {
                    "line-color":   "rgba(255,255,255,0.5)",
                    "line-width":   2,
                    "line-opacity": 0.7,
                },
            });
        } catch { /* map not ready */ }
    }, [mapLoaded, selectedContinent, selectedVehicleId]);

    // Camera reset — when the user clicks "FLEET ←" (selectedVehicleId goes
    // from set to null), ease the camera back to the home view. Without this,
    // the fitBounds zoom from the previous selection stays locked in and the
    // user has no obvious way to return to the global overview.
    const wasSelectedRef = useRef<string | null>(null);
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapLoaded || !cameraSettled) return;
        const wasSelected = wasSelectedRef.current;
        wasSelectedRef.current = selectedVehicleId;
        if (wasSelected && !selectedVehicleId) {
            map.easeTo({
                
                zoom:     2,
                bearing:  0,
                pitch:    0,
                duration: 1200,
                essential: true,
            });
        }
    }, [selectedVehicleId, mapLoaded, cameraSettled]);

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapLoaded || !cameraSettled) return;

        const prev = prevContinentRef.current;
        prevContinentRef.current = selectedContinent;

        if (selectedContinent) {
            // Fly the camera to the selected continent's preset center + zoom.
            // Targets live in data/continents.ts so the TopBar buttons and this
            // effect agree on framing for each continent.
            const target = CONTINENTS[selectedContinent as ContinentCode];
            
            if (!target) return;
            map.flyTo({
                center: target.center,
                zoom:   target.zoom,
                bearing: 0,
                pitch:   0,
                duration: 1200,
                essential: true,
            });
        } else if (prev) {
            // selectedContinent just transitioned from set → null
            map.flyTo({
                
                zoom:   2,
                bearing: 0,
                pitch:   0,
                duration: 1200,
                essential: true,
            });
        }
    }, [selectedContinent, mapLoaded, cameraSettled]);
    return (
        <div className="relative w-full h-full">
            <div ref={mapContainer} className="w-full h-full" />
        </div>
    );
}


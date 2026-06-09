"use client";

import { useEffect, useMemo, useState } from "react";
import { useVehicleStore } from "@/stores/vehicleStore";

// Boot sequence — globe-native, ~3s end-to-end.
//
// Frames:
//   0.0s  Wordmark fades in over a deep-space field
//   0.3s  Globe atmosphere becomes visible; system checklist starts ticking
//   1.8s  Globe camera arrives at home view (driven by WorldMap easeTo)
//   2.5s  Marker cascade by longitude (driven by WorldMap appearDelay)
//   3.0s  Overlay dissolves
//
// The overlay reads real signals — it does not fake progress.

export interface BootStep {
    id:    string;
    label: string;
    state: "pending" | "active" | "ok" | "warn" | "error";
    detail?: string;
}

interface BootOverlayProps {
    /** True once Mapbox style.load has fired in WorldMap. */
    mapReady: boolean;
    /** True once the cinematic camera ease-in has finished — overlay holds
     *  itself in place until this is true so vehicle markers cascade in on
     *  a globe that's already at rest. */
    cameraSettled: boolean;
    /** Force-dismiss after this many ms even if some steps haven't resolved. */
    maxDurationMs?: number;
    /** Notify parent when the overlay finishes dissolving. */
    onComplete?: () => void;
}

export default function BootOverlay({
    mapReady,
    cameraSettled,
    maxDurationMs = 4000,
    onComplete,
}: BootOverlayProps) {
    const aisStatus = useVehicleStore((s) => s.aisStatus);
    const vehicles  = useVehicleStore((s) => s.vehicles);
    const dataMode  = useVehicleStore((s) => s.dataMode);

    const [phase, setPhase] = useState<"showing" | "dissolving" | "done">("showing");
    const [tStart] = useState(() => performance.now());

    // Client-only build timestamp — avoids SSR/CSR hydration mismatch from
    // calling new Date() during render (server and client tick by 1 second).
    const [bootTimestamp, setBootTimestamp] = useState<string | null>(null);
    useEffect(() => {
        setBootTimestamp(new Date().toISOString().slice(0, 19).replace("T", " ") + "Z");
    }, []);

    // Derive real-signal steps from store state.
    const steps: BootStep[] = useMemo(() => {
        const trucks = vehicles.filter((v) => v.type === "truck");
        const trucksWithRoutes = trucks.filter((v) => v.route.length > 1).length;
        const livePlanes = vehicles.filter((v) => v.type === "plane" && v.dataSource === "live").length;
        const liveShips  = vehicles.filter((v) => v.type === "ship"  && v.dataSource === "live").length;

        const aisStep: BootStep =
            dataMode !== "live" && dataMode !== "live+demo"
                ? { id: "ais", label: "AISSTREAM",   state: "ok",      detail: "simulation mode" }
            : !aisStatus
                ? { id: "ais", label: "AISSTREAM",   state: "active",  detail: "handshake…" }
            : aisStatus.state === "connected"
                ? { id: "ais", label: "AISSTREAM",   state: "ok",      detail: `${aisStatus.vesselCount} vessels` }
            : aisStatus.state === "connecting"
                ? { id: "ais", label: "AISSTREAM",   state: "active",  detail: "connecting…" }
            :     { id: "ais", label: "AISSTREAM",   state: "error",   detail: aisStatus.lastMessage ?? aisStatus.state };

        return [
            {
                id:     "mapbox",
                label:  "MAPBOX GLOBE",
                state:  mapReady ? "ok" : "active",
                detail: mapReady ? "tiles loaded" : "loading tiles…",
            },
            aisStep,
            {
                id:     "aviation",
                label:  "AVIATION EDGE",
                state:  dataMode !== "live" && dataMode !== "live+demo" ? "ok" : livePlanes > 0 ? "ok" : "active",
                detail: dataMode !== "live" && dataMode !== "live+demo" ? "simulation mode"
                       : livePlanes > 0    ? `${livePlanes} flights`
                                           : "polling…",
            },
            {
                id:     "routing",
                label:  "HERE ROUTING",
                state:  trucks.length === 0 ? "active"
                       : trucksWithRoutes >= Math.max(1, trucks.length)
                                            ? "ok"
                                            : "active",
                detail: trucks.length === 0 ? "waiting…"
                       : `${trucksWithRoutes}/${trucks.length} routes`,
            },
            {
                id:     "fleet",
                label:  "FLEET SYNC",
                state:  vehicles.length > 0 ? "ok" : "active",
                detail: vehicles.length > 0
                            ? `${vehicles.length} units · ${liveShips + livePlanes} live`
                            : "hydrating…",
            },
        ];
    }, [mapReady, aisStatus, vehicles, dataMode]);

    // Dissolve when:
    //   - map is ready AND camera has settled AND fleet has hydrated AND at least 1500ms has passed
    //   - OR maxDurationMs has elapsed
    // The cameraSettled gate ensures markers never cascade in on a still-easing globe.
    useEffect(() => {
        if (phase !== "showing") return;
        const elapsed   = performance.now() - tStart;
        const fleetReady = vehicles.length > 0;
        const minHeld    = elapsed >= 1500;
        const allCriticalReady = mapReady && cameraSettled && fleetReady && minHeld;

        const remainingToMin = Math.max(0, 1500 - elapsed);
        const remainingToMax = Math.max(0, maxDurationMs - elapsed);

        if (allCriticalReady) {
            const t = setTimeout(() => setPhase("dissolving"), 400); // brief beat to see "ok"s
            return () => clearTimeout(t);
        }

        const t = setTimeout(
            () => setPhase("dissolving"),
            Math.max(remainingToMin, remainingToMax),
        );
        return () => clearTimeout(t);
    }, [phase, mapReady, cameraSettled, vehicles.length, maxDurationMs, tStart]);

    // After dissolve animation ends, signal done.
    useEffect(() => {
        if (phase !== "dissolving") return;
        const t = setTimeout(() => {
            setPhase("done");
            onComplete?.();
        }, 600);
        return () => clearTimeout(t);
    }, [phase, onComplete]);

    if (phase === "done") return null;

    return (
        <div
            className={`boot-overlay absolute inset-0 z-40 pointer-events-none ${
                phase === "dissolving" ? "boot-overlay-out" : "boot-overlay-in"
            }`}
        >
            {/* Vignette so the wordmark + checklist sit cleanly over the globe.
                Heavy opacity ensures anything underneath (markers, half-rendered
                tiles) stays hidden during the cinematic camera ease-in. */}
            <div className="absolute inset-0 bg-black/85 backdrop-blur-[2px]" />

            {/* Wordmark — top-center */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-[140%] text-center">
                <div className="boot-wordmark font-mono text-[11px] tracking-[0.6em] text-white/80">
                    SUPPLY · CHAIN · BRAIN
                </div>
                <div className="boot-wordmark-sub font-mono text-[9px] tracking-[0.3em] text-zinc-500 mt-2">
                    LOGISTICS · CONTROL · TOWER
                </div>
            </div>

            {/* Init checklist — bottom-left, no decoration */}
            <div className="absolute bottom-12 left-12 space-y-1">
                {steps.map((step, i) => (
                    <BootRow key={step.id} step={step} index={i} />
                ))}
            </div>

            {/* Build tag — bottom-right. Timestamp is client-only to avoid
                a hydration mismatch (server vs. client render a different second). */}
            <div className="absolute bottom-12 right-12 font-mono text-[9px] tracking-[0.25em] text-zinc-600 text-right space-y-1">
                <div>BUILD · 0.1.0</div>
                <div className="text-zinc-700 min-h-[1em]" suppressHydrationWarning>
                    {bootTimestamp ?? " "}
                </div>
            </div>
        </div>
    );
}

function BootRow({ step, index }: { step: BootStep; index: number }) {
    const stateClass =
        step.state === "ok"      ? "text-emerald-400" :
        step.state === "active"  ? "text-amber-400"   :
        step.state === "warn"    ? "text-amber-400"   :
        step.state === "error"   ? "text-red-400"     :
                                   "text-zinc-600";
    const dotClass =
        step.state === "ok"     ? "bg-emerald-400" :
        step.state === "active" ? "bg-amber-400 animate-pulse" :
        step.state === "warn"   ? "bg-amber-400" :
        step.state === "error"  ? "bg-red-400" :
                                  "bg-zinc-700";

    return (
        <div
            className="boot-row flex items-center gap-3 font-mono text-[11px] tracking-wider"
            style={{ animationDelay: `${index * 120}ms` }}
        >
            <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
            <span className={`w-32 ${stateClass}`}>{step.label}</span>
            <span className="text-zinc-500 normal-case">
                {step.detail ?? ""}
            </span>
        </div>
    );
}

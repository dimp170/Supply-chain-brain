"use client";

import { useVehicleStore } from "@/stores/vehicleStore";

// TopBar — intentionally minimal. The brand sits on the left; a single
// clickable mode pill sits on the right. The pill flips dataMode between
// "mock" (simulation, default) and "live" (AIS WebSocket + Aviation Edge poll).
// Detailed status (msg throughput, fleet counts, clock) lives in SystemStrip.

export default function TopBar() {
    const dataMode    = useVehicleStore((s) => s.dataMode);
    const setDataMode = useVehicleStore((s) => s.setDataMode);
    const aisStatus   = useVehicleStore((s) => s.aisStatus);

    const isLive = dataMode === "live";

    // When live, the pill reflects the AIS connection state so the user can see
    // whether the WebSocket is actually flowing — not just that they enabled it.
    const liveConnected =
        isLive && aisStatus?.state === "connected";
    const liveConnecting =
        isLive && (aisStatus?.state === "connecting" || aisStatus == null);
    const liveError =
        isLive && aisStatus?.state === "error";

    const pillClass =
        !isLive          ? "text-zinc-400   border-zinc-700/70   bg-zinc-900/40 hover:border-zinc-500" :
        liveError        ? "text-red-400    border-red-500/40    bg-red-500/[0.06] hover:border-red-400/70" :
        liveConnecting   ? "text-amber-400  border-amber-500/40  bg-amber-500/[0.06] hover:border-amber-400/70" :
                           "text-emerald-400 border-emerald-500/40 bg-emerald-500/[0.06] hover:border-emerald-400/70";

    const dotClass =
        !isLive          ? "bg-zinc-600" :
        liveError        ? "bg-red-400" :
        liveConnecting   ? "bg-amber-400 animate-pulse" :
                           "bg-emerald-400 animate-pulse";

    const pillLabel = isLive ? "LIVE" : "SIM";

    const tooltip = isLive
        ? (liveConnected  ? `Live data on · ${aisStatus?.vesselCount ?? 0} vessels · click to switch to simulation`
         : liveConnecting ? "Live data on · connecting to AIS… · click to switch to simulation"
         : liveError      ? `Live data error · ${aisStatus?.lastMessage ?? "see filter popover"} · click to switch to simulation`
                          : "Live data on · click to switch to simulation")
        : "Simulation mode · click to enable live AIS + Aviation Edge data";

    return (
        <header className="relative z-30 flex items-center justify-between h-12 px-4 border-b border-zinc-800/80 bg-zinc-950/85 backdrop-blur-md">
            {/* Brand */}
            <div className="flex items-center gap-3">
                <div className="relative">
                    <div className="w-2 h-2 rounded-full bg-emerald-400" />
                    <div className="absolute inset-0 w-2 h-2 rounded-full bg-emerald-400/60 animate-ping" />
                </div>
                <div className="flex items-baseline gap-2">
                    <span className="font-mono text-[11px] tracking-[0.3em] text-white">SUPPLY CHAIN BRAIN</span>
                    <span className="font-mono text-[10px] text-zinc-600">v0.1</span>
                </div>
            </div>

            {/* Single mode pill — clickable */}
            <button
                onClick={() => setDataMode(isLive ? "mock" : "live")}
                title={tooltip}
                aria-label={tooltip}
                className={`inline-flex items-center gap-2 h-7 px-3 rounded-md border font-mono text-[10px] tracking-[0.2em] transition-colors ${pillClass}`}
            >
                <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
                {pillLabel}
            </button>
        </header>
    );
}

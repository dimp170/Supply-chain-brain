"use client";

import { Sparkles, CloudRain } from "lucide-react";
import { useVehicleStore } from "@/stores/vehicleStore";
import { useWeatherStore } from "@/stores/weatherStore";

// TopBar — brand on the left, continent quick-pan in the middle, and on the
// right a cluster of toggleable pills:
//   - WEATHER — show/hide risk-zone overlays (mock weather + active scenario)
//   - DEMO    — apply pre-baked scenario disruptions to the Petros fleet
//                (ScenarioStrip mounts below for picking which one)
//   - LIVE    — pull real AIS ships + Aviation Edge flights
//   - ASK AI  — open the global chat panel
//
// DEMO and LIVE are INDEPENDENT toggles — both off is the implicit "SIM"
// state, both on layers live data on top of scenario disruptions (combined
// mode). All pills deselect on a second click. The continent buttons in the
// middle row already follow the same pattern.

export default function TopBar() {
    const dataMode             = useVehicleStore((s) => s.dataMode);
    const demoEnabled          = useVehicleStore((s) => s.demoEnabled);
    const liveEnabled          = useVehicleStore((s) => s.liveEnabled);
    const toggleDemo           = useVehicleStore((s) => s.toggleDemo);
    const toggleLive           = useVehicleStore((s) => s.toggleLive);
    const setSelectedContinent = useVehicleStore((s) => s.selectContinent);
    const selectedContinent    = useVehicleStore((s) => s.selectedContinent);
    const aisStatus            = useVehicleStore((s) => s.aisStatus);

    const riskZonesVisible     = useWeatherStore((s) => s.riskZonesVisible);
    const toggleRiskZones      = useWeatherStore((s) => s.toggleRiskZonesVisible);

    // Continent pill styling — same as before; active state when the pill's
    // code matches the currently selected continent. Clicking the active pill
    // deselects it (toggle behaviour managed by the page-level continent
    // selector, which already accepts null).
    const continentButtonClass = (code: string) => {
        const active = selectedContinent === code;
        const base = "h-7 px-3 rounded-md border font-mono text-[10px] tracking-[0.2em] transition-colors focus:outline-none";
        const stateClass = active
            ? "text-white border-zinc-500 bg-zinc-800/60"
            : "text-zinc-400 border-zinc-800 bg-zinc-900/30 hover:text-white hover:border-zinc-600";
        return `${base} ${stateClass}`;
    };

    // Continent click handler — toggles. Clicking the active continent
    // clears the selection (returns to global view).
    const onContinentClick = (code: string) => {
        setSelectedContinent(selectedContinent === code ? null : code);
    };

    // LIVE pill — reflect AIS connection state with color when active.
    const liveConnected  = liveEnabled && aisStatus?.state === "connected";
    const liveConnecting = liveEnabled && (aisStatus?.state === "connecting" || aisStatus == null);
    const liveError      = liveEnabled && aisStatus?.state === "error";

    const livePillClass =
        !liveEnabled       ? "text-zinc-400   border-zinc-700/70   bg-zinc-900/40 hover:border-zinc-500" :
        liveError          ? "text-red-400    border-red-500/40    bg-red-500/[0.06] hover:border-red-400/70" :
        liveConnecting     ? "text-amber-400  border-amber-500/40  bg-amber-500/[0.06] hover:border-amber-400/70" :
                             "text-emerald-400 border-emerald-500/40 bg-emerald-500/[0.06] hover:border-emerald-400/70";
    const liveDotClass =
        !liveEnabled       ? "bg-zinc-600" :
        liveError          ? "bg-red-400" :
        liveConnecting     ? "bg-amber-400 animate-pulse" :
                             "bg-emerald-400 animate-pulse";

    // DEMO pill — rose accent when active. Click again to leave demo mode
    // (which also clears any active scenario via the store action).
    const demoPillClass = demoEnabled
        ? "text-rose-300   border-rose-500/40   bg-rose-500/[0.08] hover:border-rose-400/70"
        : "text-zinc-400   border-zinc-700/70   bg-zinc-900/40 hover:border-zinc-500";
    const demoDotClass = demoEnabled ? "bg-rose-400 animate-pulse" : "bg-zinc-600";

    // Weather pill — sky accent so it's distinct from DEMO (rose) and LIVE
    // (emerald/amber/red). Always available regardless of data mode.
    const weatherPillClass = riskZonesVisible
        ? "text-sky-300    border-sky-500/40    bg-sky-500/[0.08] hover:border-sky-400/70"
        : "text-zinc-400   border-zinc-700/70   bg-zinc-900/40 hover:border-zinc-500";

    // Tooltips spell out exactly what each pill currently does, including
    // the combined-mode case when both LIVE and DEMO are on.
    const liveTooltip = !liveEnabled
        ? "Live feeds OFF · click to pull real AIS ships + Aviation Edge flights"
        : liveConnected   ? `Live feeds ON · ${aisStatus?.vesselCount ?? 0} vessels${demoEnabled ? " · combined with DEMO" : ""} · click to turn off`
        : liveConnecting  ? `Live feeds ON · connecting to AIS…${demoEnabled ? " · combined with DEMO" : ""} · click to turn off`
        : liveError       ? `Live feeds ERROR · ${aisStatus?.lastMessage ?? "see filter popover"} · click to turn off`
                          : "Live feeds ON · click to turn off";
    const demoTooltip = demoEnabled
        ? `Scenario mode ON · pick one from the strip below${liveEnabled ? " · combined with LIVE" : ""} · click to turn off`
        : "Scenario mode OFF · click to apply a pre-baked scenario";
    const weatherTooltip = riskZonesVisible
        ? "Weather overlay ON · scenario + mock weather zones rendered · click to hide"
        : "Weather overlay OFF · click to show extreme weather + active-scenario zones";

    // Mode-summary chip — shows the current resolved state at a glance.
    // Visible only when the mode isn't the default "mock" so it doesn't add
    // chrome unnecessarily in the SIM case.
    const modeLabel =
        dataMode === "live+demo" ? "LIVE + DEMO" :
        dataMode === "live"      ? "LIVE" :
        dataMode === "demo"      ? "DEMO" :
                                   null;

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
                    {modeLabel && (
                        <span className="font-mono text-[9px] tracking-[0.2em] text-zinc-500 border-l border-zinc-800 pl-2 ml-1">
                            {modeLabel}
                        </span>
                    )}
                </div>
            </div>

            <div className="flex items-center gap-1">
                {(["NORTH AMERICA", "EUROPE", "SOUTH AMERICA", "AFRICA", "ASIA", "OCEANIA"] as const).map((code) => (
                    <button
                        key={code}
                        onClick={() => onContinentClick(code)}
                        title={`Pan to ${code.toLowerCase().replace(/(^|\s)\S/g, (l) => l.toUpperCase())}${selectedContinent === code ? " · click again to deselect" : ""}`}
                        className={continentButtonClass(code)}
                    >
                        {code}
                    </button>
                ))}
            </div>

            {/* Right cluster — Weather + Demo + Live + Ask AI */}
            <div className="flex items-center gap-1.5">

                {/* WEATHER pill */}
                <button
                    onClick={toggleRiskZones}
                    title={weatherTooltip}
                    aria-label={weatherTooltip}
                    aria-pressed={riskZonesVisible}
                    className={`inline-flex items-center gap-1.5 h-7 px-3 rounded-md border font-mono text-[10px] tracking-[0.2em] transition-colors focus:outline-none ${weatherPillClass}`}
                >
                    <CloudRain size={11} />
                    WEATHER
                </button>

                {/* DEMO pill */}
                <button
                    onClick={toggleDemo}
                    title={demoTooltip}
                    aria-label={demoTooltip}
                    aria-pressed={demoEnabled}
                    className={`inline-flex items-center gap-2 h-7 px-3 rounded-md border font-mono text-[10px] tracking-[0.2em] transition-colors focus:outline-none ${demoPillClass}`}
                >
                    <span className={`w-1.5 h-1.5 rounded-full ${demoDotClass}`} />
                    DEMO
                </button>

                {/* LIVE pill */}
                <button
                    onClick={toggleLive}
                    title={liveTooltip}
                    aria-label={liveTooltip}
                    aria-pressed={liveEnabled}
                    className={`inline-flex items-center gap-2 h-7 px-3 rounded-md border font-mono text-[10px] tracking-[0.2em] transition-colors focus:outline-none ${livePillClass}`}
                >
                    <span className={`w-1.5 h-1.5 rounded-full ${liveDotClass}`} />
                    LIVE
                </button>

                <AskAIButton />
            </div>
        </header>
    );
}

// AskAIButton — opens the global ChatPanel. Lives in TopBar so the user can
// reach the assistant from any view without hunting for a floating button.
// Visual treatment matches the other right-edge pills so the cluster reads
// as one toolbar group.
function AskAIButton() {
    const setChatOpen = useVehicleStore((s) => s.setChatOpen);
    const chatOpen    = useVehicleStore((s) => s.chatOpen);
    return (
        <button
            onClick={() => setChatOpen(!chatOpen)}
            title={chatOpen ? "Close AI assistant · click again to reopen" : "Open AI assistant"}
            aria-label="Toggle AI assistant"
            aria-pressed={chatOpen}
            className={`inline-flex items-center gap-1.5 h-7 px-3 rounded-md border font-mono text-[10px] tracking-[0.2em] transition-colors focus:outline-none ${
                chatOpen
                    ? "bg-rose-500/[0.12] border-rose-500/50 text-rose-200"
                    : "bg-zinc-900/30 border-zinc-700/70 text-zinc-300 hover:border-zinc-500 hover:text-white"
            }`}
        >
            <Sparkles size={11} />
            ASK AI
        </button>
    );
}

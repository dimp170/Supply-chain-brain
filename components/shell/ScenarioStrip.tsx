"use client";

import { SCENARIOS } from "@/data/scenarios";
import { useVehicleStore } from "@/stores/vehicleStore";
import { AlertTriangle, CloudLightning, Anchor, X } from "lucide-react";
import type { Scenario } from "@/types/disruption";

// ScenarioStrip — horizontal strip below the TopBar listing pre-baked demo
// scenarios. Only mounts when dataMode === "demo" (the page conditionally
// renders it). Click a scenario button to set activeScenario in the store;
// page.tsx watches activeScenario and applies the disruption metadata to
// the Petros fleet via lib/applyScenario.ts.
//
// A leading "SIMULATED · DEMO MODE" label sets reviewer expectations:
// everything that appears as a disruption from here is canned, not a real
// feed. The clear button on the right deactivates the scenario without
// leaving demo mode (useful for showing the "no scenario" baseline view).

function iconForCategory(cat: Scenario["category"]) {
    switch (cat) {
        case "weather":      return CloudLightning;
        case "geopolitical": return AlertTriangle;
        case "congestion":   return Anchor;
        case "compound":     return AlertTriangle;
    }
}

export default function ScenarioStrip() {
    const activeScenario     = useVehicleStore((s) => s.activeScenario);
    const setActiveScenario  = useVehicleStore((s) => s.setActiveScenario);

    return (
        <div className="relative z-20 flex items-center gap-2 h-10 px-4 border-b border-zinc-800/80 bg-zinc-950/85 backdrop-blur-md panel-enter">
            {/* Demo-mode label — leaves no doubt for reviewers that the data
                is simulated, not retrieved from a live feed. */}
            <span className="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.2em] text-rose-300/90">
                <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-pulse" />
                SIMULATED&nbsp;·&nbsp;DEMO
            </span>
            <span className="text-zinc-700 font-mono text-[10px]">|</span>

            <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-x-auto">
                {SCENARIOS.map((s) => {
                    const Icon = iconForCategory(s.category);
                    const active = activeScenario === s.id;
                    return (
                        <button
                            key={s.id}
                            onClick={() => setActiveScenario(active ? null : s.id)}
                            title={s.shortDescription}
                            aria-pressed={active}
                            className={`shrink-0 inline-flex items-center gap-1.5 h-7 px-3 rounded-md border font-mono text-[10px] tracking-[0.15em] transition-colors focus:outline-none ${
                                active
                                    ? "bg-rose-500/[0.10] border-rose-500/50 text-rose-200"
                                    : "bg-zinc-900/40 border-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-white"
                            }`}
                        >
                            <Icon size={11} />
                            {s.name.toUpperCase()}
                        </button>
                    );
                })}
            </div>

            {activeScenario && (
                <button
                    onClick={() => setActiveScenario(null)}
                    title="Clear active scenario"
                    aria-label="Clear active scenario"
                    className="shrink-0 inline-flex items-center gap-1 h-7 px-2 rounded-md border border-zinc-800 text-zinc-500 hover:text-white hover:border-zinc-600 transition-colors font-mono text-[10px] focus:outline-none"
                >
                    <X size={11} />
                    CLEAR
                </button>
            )}
        </div>
    );
}

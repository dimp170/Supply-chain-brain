"use client";

import { useEffect, useState } from "react";
import { useVehicleStore } from "@/stores/vehicleStore";

interface SystemStripProps {
    /** Gates the strip's opacity so it doesn't appear pre-populated during
     *  the deep-space cold-open frame. Pass the page's `bootComplete` signal
     *  so the strip reveals in sync with the sidebar after the boot overlay
     *  has fully dissolved. */
    visible?: boolean;
}

export default function SystemStrip({ visible = true }: SystemStripProps = {}) {
    const vehicles  = useVehicleStore((s) => s.vehicles);
    const aisStatus = useVehicleStore((s) => s.aisStatus);

    // Strip metrics are scoped to the Petros fleet only — this is "your fleet at
    // a glance", not a world tally. The full live AIS/Aviation Edge feed is
    // surfaced in the sidebar's Control Tower stat cards instead.
    const petros = vehicles.filter((v) => v.company === "Petros Transport");
    const counts = {
        truck: petros.filter((v) => v.type === "truck").length,
        ship:  petros.filter((v) => v.type === "ship").length,
        plane: petros.filter((v) => v.type === "plane").length,
    };
    const moving  = petros.filter((v) => v.status === "moving").length;
    const delayed = petros.filter((v) => v.status === "delayed").length;
    const stopped = petros.filter((v) => v.status === "stopped").length;

    // Wall clock — UTC for ops consistency. Initial value is null so the
    // server-rendered HTML doesn't bake in a timestamp that the client will
    // disagree with by a second (hydration mismatch). The effect populates it
    // on mount and ticks every second thereafter.
    const [now, setNow] = useState<string | null>(null);
    useEffect(() => {
        setNow(formatUTC(new Date()));
        const t = setInterval(() => setNow(formatUTC(new Date())), 1000);
        return () => clearInterval(t);
    }, []);

    return (
        <footer
            className={`relative z-30 flex items-center justify-between h-7 px-4 border-t border-zinc-800/80 bg-zinc-950/85 font-mono text-[10px] tracking-wider text-zinc-500 transition-opacity duration-700 ease-out ${
                visible ? "opacity-100" : "opacity-0 pointer-events-none"
            }`}
        >
            {/* Petros fleet breakdown — your fleet at a glance, not a world tally. */}
            <div className="flex items-center gap-4">
                <span className="text-zinc-600 tracking-[0.25em]">PETROS&nbsp;FLEET</span>
                <span className="text-zinc-700">|</span>
                {/* Type metrics carry a dot in the same hue as the marker on
                 * the globe — this is the demo's legend. Status metrics
                 * (MOV/DELAY/STOP) intentionally skip the dot since their
                 * colors mean something else and there's no matching globe
                 * surface to legend against. */}
                <Metric label="TRK" value={counts.truck} color="text-amber-400/80"   dot="bg-amber-400" />
                <Metric label="SHP" value={counts.ship}  color="text-cyan-400/80"    dot="bg-cyan-400" />
                <Metric label="AIR" value={counts.plane} color="text-rose-400/80"   dot="bg-rose-400" />
                <span className="text-zinc-700">|</span>
                <Metric label="MOV"   value={moving}  color="text-emerald-400/80" />
                <Metric label="DELAY" value={delayed} color="text-amber-400/80" />
                <Metric label="STOP"  value={stopped} color="text-zinc-500" />
            </div>

            {/* AIS throughput + clock */}
            <div className="flex items-center gap-4">
                {aisStatus?.state === "connected" && (
                    <span>
                        AIS <span className="text-emerald-400/80 tabular-nums">{aisStatus.msgCount.toLocaleString()}</span> msgs
                    </span>
                )}
                <span className="text-zinc-700">|</span>
                <span className="tabular-nums min-w-[18ch] inline-block text-right" suppressHydrationWarning>
                    {now ?? " "}
                </span>
            </div>
        </footer>
    );
}

function Metric({
    label,
    value,
    color,
    dot,
}: {
    label: string;
    value: number;
    color: string;
    /** Optional bg-* Tailwind class. When set, a small colored dot renders
     *  before the label as a legend tying the metric to its marker hue on
     *  the globe. */
    dot?: string;
}) {
    return (
        <span className="inline-flex items-center gap-1.5">
            {dot && <span aria-hidden className={`w-1.5 h-1.5 rounded-full ${dot}`} />}
            <span>
                <span className="opacity-60">{label}</span>{" "}
                <span className={`tabular-nums ${color}`}>{value.toString().padStart(2, "0")}</span>
            </span>
        </span>
    );
}

function formatUTC(d: Date): string {
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

// Single source of truth for vehicle color tokens.
//
// Three layers of color used across the app, each derived from the same
// type/status/Petros axes so swapping a palette only needs to happen here:
//
//   1. vehicleHex(type, status, isPetros)
//      Raw hex for the marker SVG drawn on the globe. Petros = saturated brand
//      hue, live = desaturated industrial variant. Status overrides type
//      (stopped → gray, delayed → amber) regardless of fleet.
//
//   2. vehicleAccent(type)
//      Tailwind class bundle used by the sidebar for accents (row backgrounds,
//      borders, pill chips, dots). Type-only — there's no Petros variant at
//      this layer because the sidebar groups by type and lives under "your
//      fleet" framing, so the saturated hue is always appropriate.
//
//   3. statusDot(status)
//      Tailwind class for the small live-indicator dot on fleet rows and the
//      status row in the detail drawer. Status overrides everything.
//
// Planes use rose (not sky-blue or violet) to stop competing visually with
// cyan ships at small marker sizes on the dark globe.

import type { Vehicle, VehicleType } from "@/types/vehicle";

/** Raw hex color for the marker SVG. Status overrides type. */
export function vehicleHex(
    type: VehicleType,
    status: Vehicle["status"],
    isPetros: boolean,
): string {
    if (status === "stopped") return "#71717a";
    if (status === "delayed") return "#f59e0b";
    switch (type) {
        case "plane": return isPetros ? "#fb7185" : "#6b4a55"; // rose  → dark muted rose
        case "ship":  return isPetros ? "#22d3ee" : "#527d8c"; // cyan  → muted teal-gray
        case "truck": return isPetros ? "#f59e0b" : "#a78b59"; // amber → muted bronze
    }
}

export interface VehicleAccent {
    dot:    string;
    text:   string;
    border: string;
    bg:     string;
}

/** Tailwind accent classes for sidebar rows, chips, pills, and dots. */
export function vehicleAccent(type: VehicleType): VehicleAccent {
    return ({
        ship:  { dot: "bg-cyan-400",  text: "text-cyan-400",  border: "border-cyan-500/40",  bg: "bg-cyan-500/[0.08]"  },
        plane: { dot: "bg-rose-400",  text: "text-rose-400",  border: "border-rose-500/40",  bg: "bg-rose-500/[0.08]"  },
        truck: { dot: "bg-amber-400", text: "text-amber-400", border: "border-amber-500/40", bg: "bg-amber-500/[0.08]" },
    } as const)[type];
}

/** Status indicator dot. Status overrides type for this surface. */
export function statusDot(status: Vehicle["status"]): string {
    return status === "moving"  ? "bg-emerald-400"
         : status === "delayed" ? "bg-amber-400 animate-pulse"
         :                        "bg-zinc-500";
}

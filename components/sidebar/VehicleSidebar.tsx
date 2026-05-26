"use client";

import { useMemo, useState } from "react";
import { useVehicleStore } from "@/stores/vehicleStore";
import type { Ship, Plane, Vehicle, VehicleType } from "@/types/vehicle";
import { vehicleAccent, statusDot } from "@/lib/vehicleColors";
import {
    Clock, Package, Anchor, Radio, Hash,
    Navigation, ArrowUp, MapPin, Thermometer,
    Search, SlidersHorizontal, X, ChevronLeft, ChevronDown, ChevronRight, Eye, EyeOff,
    AlertTriangle,
} from "lucide-react";

// Port-risk visual tokens shared between the fleet row dot and the
// detail-drawer card. NONE / undefined → render nothing.
const RISK_STYLES = {
    CRITICAL: {
        dot:    "bg-red-500",
        text:   "text-red-400",
        border: "border-red-500/40",
        bg:     "bg-red-500/[0.08]",
        label:  "CRITICAL",
    },
    WARNING: {
        dot:    "bg-amber-400",
        text:   "text-amber-400",
        border: "border-amber-500/40",
        bg:     "bg-amber-500/[0.08]",
        label:  "WARNING",
    },
} as const;

function shipRisk(v: Vehicle): "CRITICAL" | "WARNING" | null {
    if (v.type !== "ship") return null;
    const r = (v as Ship).destinationRisk;
    return r === "CRITICAL" || r === "WARNING" ? r : null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Vehicle color helpers (`vehicleAccent`, `statusDot`) live in
// `@/lib/vehicleColors` — single source of truth shared with VehicleMarker.

function formatCoord(lat: number, lng: number): string {
    return `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? "N" : "S"}  ${Math.abs(lng).toFixed(4)}° ${lng >= 0 ? "E" : "W"}`;
}

function routeSubtitle(vehicle: Vehicle): string {
    if (vehicle.status === "stopped") return "Stopped";

    // Planes: prefer the airport pair (DEP→ARR) over the generic "Air Freight"
    // cargo label — it's the most useful piece for a controller scanning the
    // list. Falls through to the generic branches below if airports are absent.
    if (vehicle.type === "plane") {
        const p = vehicle as Plane;
        if (p.departureAirport && p.arrivalAirport) {
            return `${p.departureAirport} → ${p.arrivalAirport}`;
        }
        if (p.arrivalAirport) {
            return `→ ${p.arrivalAirport}`;
        }
    }

    if (vehicle.status === "delayed") return "Delayed · " + (vehicle.cargo || "—");
    if (vehicle.remainingTime != null && vehicle.remainingTime > 0) {
        return `${vehicle.cargo || "Active"} · ${formatDuration(vehicle.remainingTime)}`;
    }

    // Live AIS ships don't have a synthetic ETA like Petros vessels do, so
    // without this they'd render as just "Cargo" — much sparser than the
    // Petros rows. Fall back to the destination port from AIS data so live
    // rows pull their weight: "Cargo · → ROTTERDAM".
    if (vehicle.type === "ship") {
        const s = vehicle as Ship;
        if (s.destinationPort) {
            return `${vehicle.cargo || "Cargo"} · → ${s.destinationPort}`;
        }
    }

    return vehicle.cargo || "Active";
}

// Format a minute-value ETA into "Nd Nh Nm" human-readable form.
// Drops zero-valued units so short ETAs read "45m" not "0d 0h 45m";
// long ETAs read "2d 4h 30m". Used for both the detail-panel ETA row and
// the fleet-row subtitle so both surfaces display the same shape.
function formatDuration(minutes: number): string {
    const total = Math.round(minutes);
    if (total < 1) return "<1m";
    const d = Math.floor(total / 1440);
    const h = Math.floor((total % 1440) / 60);
    const m = total % 60;
    const parts: string[] = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    return parts.join(" ");
}

function speedLabel(vehicle: Vehicle): { value: string; unit: string } {
    const v = Math.round(vehicle.currentSpeed);
    if (vehicle.type === "ship")  return { value: (vehicle.currentSpeed / 1.852).toFixed(1), unit: "kn" };
    if (vehicle.type === "plane") return { value: v.toString(), unit: "km/h" };
    return { value: v.toString(), unit: "km/h" };
}

const AIS_STATE_TEXT: Record<string, string> = {
    connecting:   "text-amber-400",
    connected:    "text-emerald-400",
    disconnected: "text-zinc-500",
    error:        "text-red-400",
};

// ─── KPI strip ────────────────────────────────────────────────────────────────

function KPIStrip({ vehicles }: { vehicles: Vehicle[] }) {
    const active  = vehicles.length;
    const moving  = vehicles.filter((v) => v.status === "moving").length;
    const delayed = vehicles.filter((v) => v.status === "delayed").length;

    return (
        <div className="grid grid-cols-3 gap-1.5 px-4 py-3 border-b border-zinc-800/80">
            <KPITile label="ACTIVE"  value={active}  tone="text-white" />
            <KPITile label="MOVING"  value={moving}  tone="text-emerald-400" />
            <KPITile label="DELAYED" value={delayed} tone="text-amber-400" />
        </div>
    );
}

function KPITile({ label, value, tone }: { label: string; value: number; tone: string }) {
    return (
        <div className="bg-zinc-900/60 rounded-md px-2.5 py-2 border border-zinc-800/40">
            <div className="text-[9px] font-mono tracking-[0.15em] text-zinc-500">{label}</div>
            <div className={`text-lg font-medium tabular-nums leading-tight mt-0.5 ${tone}`}>
                {value.toString().padStart(2, "0")}
            </div>
        </div>
    );
}

// ─── Filter summary bar ───────────────────────────────────────────────────────

function FilterBar({
    onOpen,
    onSearch,
    search,
}: {
    onOpen:   () => void;
    onSearch: (s: string) => void;
    search:   string;
}) {
    const visibleTypes = useVehicleStore((s) => s.visibleTypes);

    // SIM/LIVE in the TopBar already carries the "which fleets" semantic, so
    // the summary here just lists the visible vehicle types.
    const summary = [...visibleTypes].sort().map((t) => t.toUpperCase()).join(" · ");

    return (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800/80 bg-zinc-950/50">
            <div className="relative flex-1">
                <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600" />
                <input
                    type="text"
                    value={search}
                    onChange={(e) => onSearch(e.target.value)}
                    placeholder="Search fleet…"
                    className="w-full bg-zinc-900/60 border border-zinc-800 rounded-md pl-7 pr-2 py-1.5 text-xs text-white placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
                    title={summary}
                />
            </div>
        </div>
    );
}

// ─── Filter popover ───────────────────────────────────────────────────────────

const TYPE_LABELS: Record<VehicleType, string> = { plane: "Planes", ship: "Ships", truck: "Trucks" };

function FilterPopover({ onClose }: { onClose: () => void }) {
    const vehicles           = useVehicleStore((s) => s.vehicles);
    const visibleTypes       = useVehicleStore((s) => s.visibleTypes);
    const toggleType         = useVehicleStore((s) => s.toggleType);
    const aisStatus          = useVehicleStore((s) => s.aisStatus);
    const dataMode           = useVehicleStore((s) => s.dataMode);
    const setDataMode        = useVehicleStore((s) => s.setDataMode);

    const counts: Record<VehicleType, number> = {
        plane: vehicles.filter((v) => v.type === "plane").length,
        ship:  vehicles.filter((v) => v.type === "ship").length,
        truck: vehicles.filter((v) => v.type === "truck").length,
    };
    const isLive = dataMode === "live";

    return (
        <div className="absolute inset-0 z-20 bg-zinc-950 panel-enter flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
                <div className="text-xs font-medium tracking-wide text-white">Filters &amp; data</div>
                <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors" aria-label="Close filters">
                    <X size={14} />
                </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-5">
                {/* Data source — opt-in live integrations */}
                <div className="space-y-2">
                    <div className="text-[10px] font-mono tracking-[0.2em] text-zinc-500">DATA SOURCE</div>
                    <div className="grid grid-cols-2 gap-1.5">
                        <button
                            onClick={() => setDataMode("mock")}
                            className={`flex flex-col items-start px-3 py-2 rounded-md border transition-colors text-left ${
                                !isLive
                                    ? "bg-zinc-800/60 border-zinc-600 text-white"
                                    : "bg-zinc-900/40 border-zinc-800 text-zinc-500 hover:border-zinc-600"
                            }`}
                        >
                            <span className="flex items-center gap-1.5 text-xs">
                                <span className={`w-1.5 h-1.5 rounded-full ${!isLive ? "bg-zinc-300" : "bg-zinc-600"}`} />
                                Simulation
                            </span>
                            <span className="text-[9px] font-mono text-zinc-600 mt-0.5">DEFAULT</span>
                        </button>
                        <button
                            onClick={() => setDataMode("live")}
                            className={`flex flex-col items-start px-3 py-2 rounded-md border transition-colors text-left ${
                                isLive
                                    ? "bg-emerald-500/[0.08] border-emerald-500/40 text-emerald-300"
                                    : "bg-zinc-900/40 border-zinc-800 text-zinc-500 hover:border-zinc-600"
                            }`}
                        >
                            <span className="flex items-center gap-1.5 text-xs">
                                <span className={`w-1.5 h-1.5 rounded-full ${isLive ? "bg-emerald-400 animate-pulse" : "bg-zinc-600"}`} />
                                Live feeds
                            </span>
                            <span className="text-[9px] font-mono text-zinc-600 mt-0.5">AIS · AVIATION</span>
                        </button>
                    </div>
                    <p className="text-[10px] text-zinc-500 leading-relaxed pt-1">
                        Live mode connects the AIS WebSocket for ships and polls Aviation Edge for flights every 60 s.
                        Simulation runs the local fleet without external calls.
                    </p>
                </div>

                {/* Type filter */}
                <div className="space-y-2">
                    <div className="text-[10px] font-mono tracking-[0.2em] text-zinc-500">VEHICLE TYPES</div>
                    <div className="flex flex-col gap-1.5">
                        {(["ship", "plane", "truck"] as VehicleType[]).map((type) => {
                            const accent = vehicleAccent(type);
                            const active = visibleTypes.has(type);
                            return (
                                <button
                                    key={type}
                                    onClick={() => toggleType(type)}
                                    className={`flex items-center justify-between px-3 py-2 rounded-md border transition-colors ${
                                        active
                                            ? `${accent.bg} ${accent.border} ${accent.text}`
                                            : "bg-zinc-900/40 border-zinc-800 text-zinc-500 hover:border-zinc-600"
                                    }`}
                                >
                                    <span className="flex items-center gap-2">
                                        <span className={`w-1.5 h-1.5 rounded-full ${active ? accent.dot : "bg-zinc-700"}`} />
                                        <span className="text-xs">{TYPE_LABELS[type]}</span>
                                    </span>
                                    <span className="text-[10px] font-mono tabular-nums opacity-70">{counts[type]}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* AIS status */}
                {aisStatus && (
                    <div className="space-y-2">
                        <div className="text-[10px] font-mono tracking-[0.2em] text-zinc-500">AIS STREAM</div>
                        <div className="bg-zinc-900/40 border border-zinc-800 rounded-md px-3 py-2 font-mono text-[10px] leading-relaxed">
                            <div className="flex justify-between">
                                <span className="text-zinc-500">STATE</span>
                                <span className={AIS_STATE_TEXT[aisStatus.state]}>{aisStatus.state.toUpperCase()}</span>
                            </div>
                            {aisStatus.state === "connected" && (
                                <>
                                    <div className="flex justify-between mt-1">
                                        <span className="text-zinc-500">MSGS</span>
                                        <span className="text-zinc-300 tabular-nums">{aisStatus.msgCount.toLocaleString()}</span>
                                    </div>
                                    <div className="flex justify-between mt-1">
                                        <span className="text-zinc-500">SHIPS</span>
                                        <span className="text-zinc-300 tabular-nums">{aisStatus.vesselCount}</span>
                                    </div>
                                </>
                            )}
                            {aisStatus.lastMessage && aisStatus.state !== "connected" && (
                                <div className="text-red-400 mt-1 break-words">{aisStatus.lastMessage}</div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── Fleet list ───────────────────────────────────────────────────────────────

function FleetList({
    vehicles,
    search,
    onSelect,
    selectedId,
}: {
    vehicles:   Vehicle[];
    search:     string;
    onSelect:   (id: string) => void;
    selectedId: string | null;
}) {
    // Visibility state and toggle for type-level filtering. Replaces the
    // standalone FILTERS popover — visibility now lives inline in each type
    // header (the Eye / EyeOff click target).
    const visibleTypes  = useVehicleStore((s) => s.visibleTypes);
    const toggleVisible = useVehicleStore((s) => s.toggleType);

    const filtered = useMemo(() => {
        if (!search.trim()) return vehicles;
        const q = search.toLowerCase();
        return vehicles.filter((v) =>
            v.name.toLowerCase().includes(q) ||
            (v.company?.toLowerCase().includes(q)) ||
            (v.cargo?.toLowerCase().includes(q)),
        );
    }, [vehicles, search]);

    // Group vehicles by type → company → vehicles. The Map preserves insertion
    // order which we then sort below — Petros first, others alphabetical, OTHER
    // last (catch-all for live AIS ships with unmatched operator names).
    const grouped = useMemo(() => {
        const g: Record<VehicleType, Map<string, Vehicle[]>> = {
            ship: new Map(),
            plane: new Map(),
            truck: new Map(),
        };
        for (const v of filtered) {
            const company = v.company || "OTHER";
            const bucket = g[v.type].get(company) ?? [];
            bucket.push(v);
            g[v.type].set(company, bucket);
        }
        return g;
    }, [filtered]);

    const order: VehicleType[] = ["ship", "plane", "truck"];
    const sectionLabel: Record<VehicleType, string> = { ship: "SHIPS", plane: "PLANES", truck: "TRUCKS" };

    // Tracks which sections the user has EXPANDED. Default is empty —
    // meaning every type and every company starts collapsed (chevron points
    // right). User clicks to add to the set (open). Click again to remove
    // from the set (close). This default-closed UX matches the user's spec.
    const [expandedTypes, setExpandedTypes] = useState<Set<VehicleType>>(new Set());
    const [expandedCompanies, setExpandedCompanies] = useState<Set<string>>(new Set());

    const toggleType = (type: VehicleType) => {
        setExpandedTypes((prev) => {
            const next = new Set(prev);
            if (next.has(type)) next.delete(type);
            else next.add(type);
            return next;
        });
    };
    const toggleCompany = (company: string) => {
        setExpandedCompanies((prev) => {
            const next = new Set(prev);
            if (next.has(company)) next.delete(company);
            else next.add(company);
            return next;
        });
    };

    // Sort companies so Petros sits at the top of each type's list and the
    // "OTHER" catch-all bucket sits at the bottom.
    const sortCompanies = (a: string, b: string) => {
        if (a === "Petros Transport") return -1;
        if (b === "Petros Transport") return 1;
        if (a === "OTHER") return 1;
        if (b === "OTHER") return -1;
        return a.localeCompare(b);
    };

    if (filtered.length === 0) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-12">
                <div className="text-xs text-zinc-500">No vehicles match</div>
                <div className="text-[10px] text-zinc-700 mt-1 font-mono tracking-wider">
                    {search ? `"${search}"` : "Adjust filters to see more"}
                </div>
            </div>
        );
    }

    return (
        <div className="flex-1 overflow-y-auto">
            {order.map((type) => {
                const companies = grouped[type];
                const totalCount = Array.from(companies.values()).reduce((s, v) => s + v.length, 0);
                const isTypeVisible  = visibleTypes.has(type);
                // Always render the header when the type is hidden (so the user has a
                // toggle to re-enable it). Skip only when the type is visible AND truly
                // has no vehicles.
                if (totalCount === 0 && isTypeVisible) return null;
                const accent = vehicleAccent(type);
                const isTypeExpanded = expandedTypes.has(type);
                const sortedCompanyNames = Array.from(companies.keys()).sort(sortCompanies);

                // When only one company exists under a type (e.g. SIM mode = all
                // Petros), skip the company sub-header entirely and list the
                // vehicles directly. Saves a useless click and reads cleaner.
                const singleCompany = companies.size === 1;

                return (
                    <div key={type}>
                        {/* Type header — click to expand/collapse the whole section.
                            Sticky so it stays pinned to the top of the scroll area.
                            The Eye toggle inside is an independent click target — it
                            uses stopPropagation so the parent expand handler doesn't
                            also fire. */}
                        <button
                            onClick={() => toggleType(type)}
                            className="w-full px-4 pt-3 pb-1.5 flex items-center justify-between sticky top-0 bg-zinc-950/95 backdrop-blur-sm z-10 border-b border-zinc-900/80 hover:bg-zinc-900/40 transition-colors text-left focus:outline-none"
                        >
                            <span className="flex items-center gap-1.5">
                                {isTypeExpanded
                                    ? <ChevronDown  size={11} className="text-zinc-500" />
                                    : <ChevronRight size={11} className="text-zinc-500" />}
                                <span className={`text-[10px] font-mono tracking-[0.2em] ${accent.text} ${!isTypeVisible ? "opacity-40" : ""}`}>{sectionLabel[type]}</span>
                            </span>
                            <span className="flex items-center gap-2">
                                <span
                                    role="switch"
                                    aria-checked={isTypeVisible}
                                    aria-label={`Toggle ${sectionLabel[type]} visibility`}
                                    onClick={(e) => { e.stopPropagation(); toggleVisible(type); }}
                                    className={`p-1 -m-1 rounded ${isTypeVisible ? "text-zinc-400" : "text-zinc-600"} hover:text-white transition-colors cursor-pointer`}
                                >
                                    {isTypeVisible
                                        ? <Eye    size={11} />
                                        : <EyeOff size={11} />}
                                </span>
                                <span className="text-[10px] font-mono text-zinc-600 tabular-nums">
                                    {isTypeVisible ? totalCount.toString().padStart(2, "0") : "—"}
                                </span>
                            </span>
                        </button>

                        {isTypeExpanded && isTypeVisible && (
                            singleCompany ? (
                                // Flat — vehicles directly under the type header.
                                sortedCompanyNames.flatMap((c) => companies.get(c)!).map((v) => (
                                    <FleetRow
                                        key={v.id}
                                        vehicle={v}
                                        selected={v.id === selectedId}
                                        onClick={() => onSelect(v.id)}
                                    />
                                ))
                            ) : (
                                // Nested — company sub-headers above their vehicles.
                                sortedCompanyNames.map((company) => {
                                    const list = companies.get(company)!;
                                    const isCompanyExpanded = expandedCompanies.has(company);
                                    return (
                                        <div key={company}>
                                            <button
                                                onClick={() => toggleCompany(company)}
                                                className="w-full px-4 py-1.5 flex items-center justify-between bg-zinc-950/50 border-b border-zinc-900/40 hover:bg-zinc-900/30 transition-colors text-left focus:outline-none"
                                            >
                                                <span className="flex items-center gap-1.5 min-w-0">
                                                    {isCompanyExpanded
                                                        ? <ChevronDown  size={10} className="text-zinc-600 shrink-0" />
                                                        : <ChevronRight size={10} className="text-zinc-600 shrink-0" />}
                                                    <span className="text-[9px] font-mono tracking-[0.18em] text-zinc-500 truncate">
                                                        {company.toUpperCase()}
                                                    </span>
                                                </span>
                                                <span className="text-[9px] font-mono text-zinc-700 tabular-nums shrink-0">
                                                    {list.length}
                                                </span>
                                            </button>

                                            {isCompanyExpanded && list.map((v) => (
                                                <FleetRow
                                                    key={v.id}
                                                    vehicle={v}
                                                    selected={v.id === selectedId}
                                                    onClick={() => onSelect(v.id)}
                                                />
                                            ))}
                                        </div>
                                    );
                                })
                            )
                        )}
                    </div>
                );
            })}
        </div>
    );
}

function FleetRow({ vehicle, selected, onClick }: { vehicle: Vehicle; selected: boolean; onClick: () => void }) {
    const accent = vehicleAccent(vehicle.type);
    const speed  = speedLabel(vehicle);
    const risk   = shipRisk(vehicle);
    return (
        <button
            onClick={onClick}
            className={`w-full flex items-center gap-3 px-4 py-2.5 text-left border-b border-zinc-900/60 transition-colors ${
                selected
                    ? `${accent.bg} border-l-2 ${accent.border}`
                    : "hover:bg-zinc-900/40"
            }`}
            style={selected ? { paddingLeft: "calc(1rem - 2px)" } : undefined}
        >
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot(vehicle.status)}`} />
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-xs font-medium text-white truncate">{vehicle.name}</span>
                    {risk && (
                        <span
                            className={`shrink-0 w-1.5 h-1.5 rounded-full ${RISK_STYLES[risk].dot} ${
                                risk === "CRITICAL" ? "animate-pulse" : ""
                            }`}
                            title={`Destination ${risk.toLowerCase()}`}
                        />
                    )}
                </div>
                <div className="text-[10px] text-zinc-500 font-mono truncate">
                    {vehicle.company ? `${vehicle.company.toUpperCase()} · ` : ""}
                    {routeSubtitle(vehicle)}
                </div>
            </div>
            <div className="text-right shrink-0">
                <div className="text-[11px] text-zinc-300 font-mono tabular-nums">{speed.value}</div>
                <div className="text-[9px] text-zinc-600 font-mono">{speed.unit}</div>
            </div>
        </button>
    );
}

// ─── Detail drawer ────────────────────────────────────────────────────────────

function DetailDrawer({ vehicle, onBack }: { vehicle: Vehicle; onBack: () => void }) {
    const accent = vehicleAccent(vehicle.type);
    const speed  = speedLabel(vehicle);
    const ship   = vehicle.type === "ship"  ? (vehicle as Ship)  : null;
    const plane  = vehicle.type === "plane" ? (vehicle as Plane) : null;

    return (
        <div className="absolute inset-0 z-10 flex flex-col bg-zinc-950 panel-enter">
            {/* Drawer header */}
            <div className="flex items-center justify-between px-3 py-2.5 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur-sm">
                <button
                    onClick={onBack}
                    className="flex items-center gap-1.5 text-[10px] font-mono tracking-[0.15em] text-zinc-500 hover:text-white transition-colors"
                >
                    <ChevronLeft size={12} />
                    FLEET
                </button>
                {vehicle.dataSource === "live" && (
                    <span className={`flex items-center gap-1.5 text-[10px] font-mono tracking-wider ${accent.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${accent.dot} animate-pulse`} />
                        LIVE
                    </span>
                )}
            </div>

            <div className="flex-1 overflow-y-auto">
                {/* Identity — operator label sits ABOVE the vessel name as a
                 *  brand chip so the affiliation reads first. Vessel name in
                 *  white below. Type + IMO/flight metadata is the smallest line
                 *  underneath. This three-tier hierarchy mirrors how flight
                 *  trackers display airline → flight number, and how shipping
                 *  manifests display operator → vessel. */}
                <div className="px-4 pt-4 pb-3">
                    {vehicle.company && (
                        <div className={`inline-flex items-center gap-1.5 text-[10px] font-mono tracking-[0.2em] ${accent.text} border ${accent.border} ${accent.bg} rounded-full px-2 py-0.5 mb-2`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${accent.dot}`} />
                            {vehicle.company.toUpperCase()}
                        </div>
                    )}
                    <div className="text-base font-medium text-white tracking-tight">{vehicle.name}</div>
                    <div className="text-[10px] font-mono tracking-[0.15em] mt-1 text-zinc-500">
                        {vehicle.type.toUpperCase()}
                        {ship?.imoNumber ? ` · IMO ${ship.imoNumber}` : ""}
                        {plane?.flightNumber ? ` · ${plane.flightNumber}` : ""}
                    </div>
                </div>

                {/* Speed card */}
                <div className="mx-4 mb-3 bg-zinc-900/50 border border-zinc-800/60 rounded-lg px-4 py-3">
                    <div className="text-[9px] font-mono tracking-[0.2em] text-zinc-500 mb-1">CURRENT SPEED</div>
                    <div className="flex items-baseline gap-2">
                        <span className="text-3xl font-medium tabular-nums leading-none text-white">{speed.value}</span>
                        <span className="text-[10px] font-mono text-zinc-500">{speed.unit}</span>
                        {vehicle.speedLimit != null && vehicle.speedLimit > 0 && (
                            <span className="ml-auto text-[10px] font-mono text-zinc-600 tabular-nums">
                                limit {Math.round(vehicle.speedLimit)}
                            </span>
                        )}
                    </div>
                </div>

                {/* Status card */}
                <div className="mx-4 mb-3 bg-zinc-900/50 border border-zinc-800/60 rounded-lg px-4 py-3">
                    <div className="flex items-center justify-between">
                        <div className="text-[9px] font-mono tracking-[0.2em] text-zinc-500">STATUS</div>
                        <span className={`inline-flex items-center gap-1.5 text-[10px] font-mono tracking-wider ${
                            vehicle.status === "moving"  ? "text-emerald-400" :
                            vehicle.status === "delayed" ? "text-amber-400" :
                                                           "text-zinc-500"
                        }`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${statusDot(vehicle.status)}`} />
                            {vehicle.status.toUpperCase()}
                        </span>
                    </div>
                </div>

                {/* Cargo / route card — shared across vehicle types. Title flips
                 * to "CARGO" when the card only carries cargo (typical for planes
                 * and most live AIS ships, neither of which expose remainingTime
                 * or remainingDistance) so we don't compete with the "Route" row
                 * in the FLIGHT card below. Stays "ROUTE" for trucks where ETA
                 * and remaining distance make routing the dominant semantic. */}
                {(() => {
                    const hasRouting =
                        (vehicle.remainingTime != null && vehicle.remainingTime > 0) ||
                        (vehicle.remainingDistance != null && vehicle.remainingDistance > 0);
                    if (!vehicle.cargo && !hasRouting) return null;
                    return (
                        <DetailCard title={hasRouting ? "ROUTE" : "CARGO"}>
                            {vehicle.cargo && <DetailRow icon={<Package size={11} />} label="Cargo" value={vehicle.cargo} />}
                            {vehicle.remainingTime != null && vehicle.remainingTime > 0 && (
                                <DetailRow icon={<Clock size={11} />} label="ETA" value={formatDuration(vehicle.remainingTime)} mono />
                            )}
                            {vehicle.remainingDistance != null && vehicle.remainingDistance > 0 && (
                                <DetailRow icon={<Navigation size={11} />} label="Distance" value={`${vehicle.remainingDistance.toFixed(1)} km`} mono />
                            )}
                        </DetailCard>
                    );
                })()}

                {/* Ship card */}
                {ship && (ship.destinationPort || ship.callSign || ship.imoNumber || ship.draught || ship.vesselLength) && (
                    <DetailCard title="VESSEL">
                        {ship.destinationPort && <DetailRow icon={<Anchor size={11} />} label="Port"      value={ship.destinationPort} />}
                        {ship.callSign         && <DetailRow icon={<Radio size={11} />}  label="Call sign" value={ship.callSign} />}
                        {ship.imoNumber != null && ship.imoNumber > 0 && (
                            <DetailRow icon={<Hash size={11} />} label="IMO" value={ship.imoNumber.toString()} mono />
                        )}
                        {ship.draught     != null && ship.draught > 0      && <DetailRow label="Draught" value={`${ship.draught.toFixed(1)} m`} mono />}
                        {ship.vesselLength != null && ship.vesselLength > 0 && <DetailRow label="Length"  value={`${ship.vesselLength} m`} mono />}
                    </DetailCard>
                )}

                {/* Port risk — only when the backend RSS scraper has flagged
                    the destination. Read from ship.destinationRisk /
                    destinationIncident (populated by backend/services/risk_engine.py). */}
                {ship && shipRisk(ship) && (
                    <PortRiskCard
                        level={shipRisk(ship)!}
                        port={ship.destinationPort}
                        incident={ship.destinationIncident}
                    />
                )}

                {/* Plane card */}
                {plane && (plane.flightNumber || plane.airline || plane.altitude) && (
                    <DetailCard title="FLIGHT">
                        {plane.flightNumber && <DetailRow icon={<Hash size={11} />} label="Flight" value={plane.flightNumber} />}
                        {plane.airline      && <DetailRow label="Airline" value={plane.airline} />}
                        {plane.departureAirport && plane.arrivalAirport && (
                            <DetailRow
                                icon={<Navigation size={11} />}
                                label="Route"
                                value={`${plane.departureAirport} → ${plane.arrivalAirport}`}
                            />
                        )}
                        {plane.altitude != null && plane.altitude > 0 && (
                            <DetailRow icon={<ArrowUp size={11} />} label="Altitude" value={`${plane.altitude.toLocaleString()} m`} mono />
                        )}
                    </DetailCard>
                )}

                {/* Position card */}
                <DetailCard title="POSITION">
                    <DetailRow
                        icon={<MapPin size={11} />}
                        label="Coords"
                        value={formatCoord(vehicle.latitude, vehicle.longitude)}
                        mono
                    />
                    {vehicle.temperature != null && (
                        <DetailRow icon={<Thermometer size={11} />} label="Temp" value={`${vehicle.temperature} °C`} mono />
                    )}
                    <DetailRow
                        icon={<Clock size={11} />}
                        label="Updated"
                        value={new Date(vehicle.lastUpdated).toLocaleTimeString()}
                    />
                </DetailCard>

                <div className="h-4" />
            </div>
        </div>
    );
}

function PortRiskCard({
    level, port, incident,
}: {
    level: "CRITICAL" | "WARNING";
    port?: string;
    incident?: string;
}) {
    const s = RISK_STYLES[level];
    return (
        <div className={`mx-4 mb-3 rounded-lg px-4 py-3 border ${s.border} ${s.bg}`}>
            <div className="flex items-center justify-between mb-2">
                <span className={`flex items-center gap-1.5 text-[10px] font-mono tracking-[0.2em] ${s.text}`}>
                    <AlertTriangle size={11} />
                    PORT RISK
                </span>
                <span className={`text-[10px] font-mono tracking-wider ${s.text}`}>{s.label}</span>
            </div>
            {port && (
                <div className="text-[11px] text-zinc-300 mb-1">
                    <span className="text-zinc-500">Destination</span> · {port}
                </div>
            )}
            {incident && (
                <div className="text-[11px] text-zinc-300 leading-relaxed italic">
                    “{incident}”
                </div>
            )}
        </div>
    );
}

function DetailCard({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="mx-4 mb-3 bg-zinc-900/50 border border-zinc-800/60 rounded-lg px-4 py-3">
            <div className="text-[9px] font-mono tracking-[0.2em] text-zinc-500 mb-2">{title}</div>
            <div className="space-y-1.5">{children}</div>
        </div>
    );
}

function DetailRow({
    label, value, icon, mono = false,
}: {
    label: string; value: React.ReactNode; icon?: React.ReactNode; mono?: boolean;
}) {
    return (
        <div className="flex items-start justify-between gap-3 min-w-0">
            <span className="flex items-center gap-1.5 text-zinc-500 text-[11px] shrink-0 mt-0.5">
                {icon}
                {label}
            </span>
            <span className={`text-[12px] text-right truncate ${mono ? "font-mono tabular-nums text-zinc-200" : "text-white"}`}>
                {value}
            </span>
        </div>
    );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function VehicleSidebar() {
    const vehicles          = useVehicleStore((s) => s.vehicles);
    const selectedVehicleId = useVehicleStore((s) => s.selectedVehicleId);
    const selectVehicle     = useVehicleStore((s) => s.selectVehicle);
    const visibleTypes      = useVehicleStore((s) => s.visibleTypes);

    const [search, setSearch] = useState("");

    // Mirror WorldMap's visibility filter so the fleet list matches what's on the globe.
    // The "Petros only" company filter is gone — the SIM/LIVE pill carries that
    // semantic now (SIM = Petros fleet, LIVE = Petros + external feeds). We always
    // hide third-party mock seeds (non-Petros + non-live) so neither mode is noisy.
    const visibleFleet = useMemo(
        () => vehicles.filter((v) => {
            if (!visibleTypes.has(v.type)) return false;
            if (v.company !== "Petros Transport" && v.dataSource !== "live") return false;
            return true;
        }),
        [vehicles, visibleTypes],
    );

    const selectedVehicle = useMemo(
        () => vehicles.find((v) => v.id === selectedVehicleId) ?? null,
        [vehicles, selectedVehicleId],
    );

    const anyLive = vehicles.some((v) => v.dataSource === "live");

    return (
        <div className="relative flex flex-col h-full bg-zinc-950 overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800/80">
                <div className="flex flex-col">
                    <h2 className="text-xs font-medium text-white tracking-wide">Control Tower</h2>
                    <span className="text-[9px] font-mono tracking-[0.2em] text-zinc-600 mt-0.5">
                        {visibleFleet.length} OF {vehicles.length} VISIBLE
                    </span>
                </div>
                <span className={`flex items-center gap-1.5 text-[10px] font-mono tracking-wider px-2 py-0.5 rounded-full border ${
                    anyLive
                        ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/[0.06]"
                        : "text-zinc-500   border-zinc-700/60   bg-zinc-900/40"
                }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${anyLive ? "bg-emerald-400 animate-pulse" : "bg-zinc-600"}`} />
                    {anyLive ? "LIVE" : "SIM"}
                </span>
            </div>

            <KPIStrip vehicles={visibleFleet} />
            <FilterBar onOpen={() => {}} onSearch={setSearch} search={search} />
            <FleetList
                vehicles={visibleFleet}
                search={search}
                onSelect={selectVehicle}
                selectedId={selectedVehicleId}
            />

            {/* Drawer slides over the list when a vehicle is selected. */}
            {selectedVehicle && (
                <DetailDrawer vehicle={selectedVehicle} onBack={() => selectVehicle(null)} />
            )}
        </div>
    );
}

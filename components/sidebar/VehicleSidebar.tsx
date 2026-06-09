"use client";

import { useMemo, useState } from "react";
import { useVehicleStore } from "@/stores/vehicleStore";
import type { Ship, Plane, Vehicle, VehicleType } from "@/types/vehicle";
import { vehicleAccent, statusDot } from "@/lib/vehicleColors";
import {
    Clock, Package, Anchor, Radio, Hash,
    Navigation, ArrowUp, MapPin, Thermometer,
    Search, SlidersHorizontal, X, ChevronLeft, ChevronDown, ChevronRight, Eye, EyeOff,
    AlertTriangle, CloudLightning, Activity, Snowflake, Container, Droplets, Wheat, Truck as TruckIcon,
    Download,
} from "lucide-react";
import { apiUrl } from "@/lib/apiClient";
import type { Disruption } from "@/types/disruption";
import { WeatherCard } from "@/components/weather/WeatherCard";
import { airportName } from "@/data/airports";
import type {
    CargoManifest, CargoShipment,
    TruckManifest, TruckShipment,
    PlaneManifest, AirShipment,
} from "@/types/manifest";
import type { Truck } from "@/types/vehicle";
import {
    imdgClassLabel, incotermLabel, freightTermLabel, countryName, containerTypeLabel,
} from "@/data/cargoLabels";

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
            return `${airportName(p.departureAirport)} → ${airportName(p.arrivalAirport)}`;
        }
        if (p.arrivalAirport) {
            return `→ ${airportName(p.arrivalAirport)}`;
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
    const setDemoEnabled     = useVehicleStore((s) => s.setDemoEnabled);
    const setLiveEnabled     = useVehicleStore((s) => s.setLiveEnabled);

    const counts: Record<VehicleType, number> = {
        plane: vehicles.filter((v) => v.type === "plane").length,
        ship:  vehicles.filter((v) => v.type === "ship").length,
        truck: vehicles.filter((v) => v.type === "truck").length,
    };
    const isLive = dataMode === "live" || dataMode === "live+demo";

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
                            onClick={() => { setDemoEnabled(false); setLiveEnabled(false); }}
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
                            onClick={() => setLiveEnabled(true)}
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
    // Manifest panel toggle — when true, a full-screen ManifestPanel overlays
    // the drawer with its own back button. Keeps the main detail view from
    // getting cluttered by what's essentially a separate workflow.
    const [showManifest, setShowManifest] = useState(false);
    const accent = vehicleAccent(vehicle.type);
    const speed  = speedLabel(vehicle);
    const ship   = vehicle.type === "ship"  ? (vehicle as Ship)  : null;
    const plane  = vehicle.type === "plane" ? (vehicle as Plane) : null;
    // Weather rendering + on-demand fetching is now owned entirely by
    // <WeatherCard /> below. It reads from useWeatherStore, does its own
    // section-based dedup, and renders all the fields the drawer used to
    // render inline (temp, wind speed, wind direction, precipitation,
    // humidity, condition, source). Pure consolidation — no duplicate
    // state, no duplicate fetch.

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

                {/* Disruption cards — one per disruption affecting this
                 * vehicle. Sit at the top of the drawer because for a
                 * flagged vehicle the disruptions are the most important
                 * thing on screen. The array is the canonical AI input
                 * (see types/disruption.ts) — populated by applyScenario
                 * in DEMO mode and by weather / port-risk / geopolitical
                 * producers in LIVE mode. UI behavior is identical
                 * regardless of source. */}
                {vehicle.disruptions?.map((d, i) => (
                    <DisruptionCard key={`${d.source.authority}-${d.headline}-${i}`} disruption={d} />
                ))}

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
                {ship && (ship.originPort || ship.destinationPort || ship.callSign || ship.imoNumber || ship.draught || ship.vesselLength || ship.vesselSubType) && (
                    <DetailCard title="VESSEL">
                        {ship.vesselSubType   && <DetailRow icon={<Package size={11} />}    label="Type"         value={VESSEL_SUBTYPE_LABELS[ship.vesselSubType]} />}
                        {ship.originPort      && <DetailRow icon={<Navigation size={11} />} label="Origin"      value={ship.originPort} />}
                        {ship.destinationPort && <DetailRow icon={<Anchor size={11} />}     label="Destination"  value={ship.destinationPort} />}
                        {ship.callSign         && <DetailRow icon={<Radio size={11} />}  label="Call sign" value={ship.callSign} />}
                        {ship.imoNumber != null && ship.imoNumber > 0 && (
                            <DetailRow icon={<Hash size={11} />} label="IMO" value={ship.imoNumber.toString()} mono />
                        )}
                        {ship.draught     != null && ship.draught > 0      && <DetailRow label="Draught" value={`${ship.draught.toFixed(1)} m`} mono />}
                        {ship.vesselLength != null && ship.vesselLength > 0 && <DetailRow label="Length"  value={`${ship.vesselLength} m`} mono />}
                    </DetailCard>
                )}

                {/* Cargo manifest — compact summary card with a button that
                    opens the dedicated ManifestPanel overlay. Works for all
                    three modes; the card branches internally on vehicle.type
                    to surface the right unit (containers / pallets / pieces),
                    weight label and hazmat code (IMDG / ADR / DGR). */}
                {vehicle && vehicleHasManifest(vehicle) && (
                    <ManifestSummaryCard
                        vehicle={vehicle}
                        onOpen={() => setShowManifest(true)}
                    />
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
                                value={`${airportName(plane.departureAirport)} → ${airportName(plane.arrivalAirport)}`}
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

                {/* Weather — single source of truth. Renders all weather
                 *  metrics (temp, wind speed, direction, precip, humidity,
                 *  condition) + any risk zones affecting this position.
                 *  Owns its own on-demand fetch with section-based dedup. */}
                <WeatherCard latitude={vehicle.latitude} longitude={vehicle.longitude} />

                <div className="h-4" />
            </div>

            {/* Manifest panel — overlays the whole drawer when active. Higher
                z-index than the drawer (z-10) so it covers everything. The
                panel branches internally to render the right Master/B-L/AWB
                header + per-shipment row variant. */}
            {showManifest && vehicle && vehicleHasManifest(vehicle) && (
                <ManifestPanel
                    vehicle={vehicle}
                    onBack={() => setShowManifest(false)}
                />
            )}
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

// ─── Disruption card ─────────────────────────────────────────────────────────
// Renders the scenario-driven disruption metadata attached to a vehicle by
// lib/applyScenario.ts. The shape mirrors what a real open-source feed
// (NOAA bulletin, port authority status, sanctions notice) would deliver —
// see types/disruption.ts for the rationale. A prominent SIMULATED badge is
// shown when `disruption.simulated` is true so reviewers always know they're
// looking at canned demo data, not a live feed.

const DISRUPTION_PALETTE = {
    critical: { text: "text-red-300",   border: "border-red-500/40",   bg: "bg-red-500/[0.08]",   dot: "bg-red-400 animate-pulse" },
    high:     { text: "text-rose-300",  border: "border-rose-500/40",  bg: "bg-rose-500/[0.08]",  dot: "bg-rose-400" },
    medium:   { text: "text-amber-300", border: "border-amber-500/40", bg: "bg-amber-500/[0.08]", dot: "bg-amber-400" },
    low:      { text: "text-zinc-300",  border: "border-zinc-600/40",  bg: "bg-zinc-700/[0.15]",  dot: "bg-zinc-400" },
} as const;

const CATEGORY_ICON = {
    weather:      CloudLightning,
    geopolitical: AlertTriangle,
    congestion:   Anchor,
} as const;

const CATEGORY_LABEL = {
    weather:      "WEATHER",
    geopolitical: "GEOPOLITICAL",
    congestion:   "CONGESTION",
} as const;

function DisruptionCard({ disruption }: { disruption: Disruption }) {
    const palette = DISRUPTION_PALETTE[disruption.severity];
    const Icon = CATEGORY_ICON[disruption.category];
    const categoryLabel = CATEGORY_LABEL[disruption.category];

    return (
        <div className={`mx-4 mb-3 rounded-lg px-4 py-3 border ${palette.border} ${palette.bg}`}>
            {/* Header — category icon + label on the left, severity pill on the right */}
            <div className="flex items-center justify-between mb-2">
                <span className={`flex items-center gap-1.5 text-[10px] font-mono tracking-[0.2em] ${palette.text}`}>
                    <Icon size={11} />
                    {categoryLabel}
                </span>
                <span className={`inline-flex items-center gap-1.5 text-[10px] font-mono tracking-wider ${palette.text}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${palette.dot}`} />
                    {disruption.severity.toUpperCase()}
                </span>
            </div>

            {/* SIMULATED badge — only when simulated:true. Stays prominent so
                reviewers can't miss that this disruption is canned. */}
            {disruption.simulated && (
                <div className="inline-flex items-center gap-1.5 text-[9px] font-mono tracking-[0.2em] text-rose-300/90 border border-rose-500/40 bg-rose-500/[0.06] rounded-full px-2 py-0.5 mb-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-pulse" />
                    SIMULATED
                </div>
            )}

            {/* Headline + description */}
            <div className="text-[12px] text-white font-medium mb-1">{disruption.headline}</div>
            <div className="text-[11px] text-zinc-300 leading-relaxed mb-2">{disruption.description}</div>

            {/* Impact metrics — only render the fields that are populated */}
            {(disruption.impact.estimatedDelayHours != null || disruption.impact.rerouteRequired) && (
                <div className="flex items-center gap-3 mb-2 text-[10px] font-mono text-zinc-400">
                    {disruption.impact.estimatedDelayHours != null && (
                        <span className="inline-flex items-center gap-1">
                            <Clock size={10} />
                            <span className="tabular-nums">{disruption.impact.estimatedDelayHours}</span>h delay
                        </span>
                    )}
                    {disruption.impact.rerouteRequired && (
                        <span className="inline-flex items-center gap-1 text-amber-300">
                            <Navigation size={10} />
                            REROUTE
                        </span>
                    )}
                </div>
            )}
            {disruption.impact.notes && (
                <div className="text-[10px] text-zinc-400 italic leading-relaxed mb-2">
                    {disruption.impact.notes}
                </div>
            )}

            {/* Source citation — small footer with authority + feed + (optional) id */}
            <div className="pt-2 mt-1 border-t border-white/5 text-[9px] font-mono tracking-wide text-zinc-500 leading-relaxed">
                <div className="flex items-center gap-1.5">
                    <Activity size={9} />
                    <span className="text-zinc-400">{disruption.source.authority}</span>
                </div>
                <div className="ml-3.5 mt-0.5">
                    {disruption.source.feed}
                    {disruption.source.citation && (
                        <span className="text-zinc-600"> · {disruption.source.citation}</span>
                    )}
                </div>
                <div className="ml-3.5 mt-0.5 text-zinc-600">
                    {new Date(disruption.effectiveFrom).toLocaleString(undefined, {
                        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                    })}
                    {disruption.effectiveUntil && (
                        <> – {new Date(disruption.effectiveUntil).toLocaleString(undefined, {
                            month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                        })}</>
                    )}
                </div>
            </div>
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

// ─── Manifest card ────────────────────────────────────────────────────────────
//
// Surfaces the cargo manifest generated by backend/services/manifest_generator.py.
// The aggregate header gives the at-a-glance "what's at risk" read; each
// shipment row expands to show type-appropriate detail (containers vs tanks
// vs holds vs vehicle units vs breakbulk packages). Hazmat and reefer rows
// pick up coloured badges so they jump out of the list.

const VESSEL_SUBTYPE_LABELS: Record<string, string> = {
    container: "Container ship",
    tanker:    "Tanker",
    bulker:    "Bulk carrier",
    reefer:    "Refrigerated cargo",
    roro:      "RoRo (vehicle carrier)",
    breakbulk: "General cargo / breakbulk",
};

const RORO_UNIT_LABELS: Record<string, string> = {
    passenger_car:          "passenger cars",
    commercial_truck:       "commercial trucks",
    heavy_equipment:        "heavy equipment",
    agricultural_machinery: "agricultural machinery",
};

const PACKAGE_LABELS: Record<string, string> = {
    container: "containers",
    pallet:    "pallets",
    case:      "cases",
    drum:      "drums",
    bag:       "bags",
    bulk:      "bulk",
    unit:      "units",
};

/** Compact USD format — "$45.6M", "$1.07B", "$580k". */
function formatUSD(v: number): string {
    if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
    if (v >= 1_000_000)     return `$${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000)         return `$${(v / 1_000).toFixed(0)}k`;
    return `$${v.toFixed(0)}`;
}

/** Tonnes for everything ≥1 t, kg below that. Used heavily — containers,
 *  tanker bulk, bulker bulk, RoRo, breakbulk all share this format. */
function formatTonnes(kg: number): string {
    if (kg >= 1000) return `${(kg / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 })} t`;
    return `${kg.toLocaleString()} kg`;
}

/** IMDG class -> badge color. Toxic gases (2.3), flammable liquids (3),
 *  toxic substances (6.1) and radioactive (7) read as the highest-risk
 *  reds; everything else lands on amber. */
function hazmatBadgeColor(imdgClass: string): string {
    if (["2.3", "3", "6.1", "7"].includes(imdgClass)) return "text-red-300 border-red-500/40 bg-red-500/[0.08]";
    return "text-amber-300 border-amber-500/40 bg-amber-500/[0.08]";
}

/** True if the vehicle has any manifest attached (truck CMR / ship cargo /
 *  plane AWB). Used to gate the summary card + panel rendering. */
function vehicleHasManifest(v: Vehicle): boolean {
    if (v.type === "ship")  return !!(v as Ship).manifest;
    if (v.type === "truck") return !!(v as Truck).manifest;
    if (v.type === "plane") return !!(v as Plane).manifest;
    return false;
}

/** Unified summary view derived from any of the three manifest shapes. The
 *  components consume this so they don't have to know about the
 *  underlying CargoManifest / TruckManifest / PlaneManifest shape. */
type ManifestSummary = {
    /** Title to show in the small badge — "MANIFEST" / "CMR" / "AWB". */
    title: string;
    /** Document number (manifest / consignment / master AWB). */
    docNumber: string;
    /** Voyage / trip / flight identifier. */
    tripNumber: string;
    shipmentCount: number;
    /** Primary unit row — TEU for containers, pallets for trucks, PCS for air. */
    primaryUnit?: { icon: React.ReactNode; label: string; sublabel?: string; value: string };
    grossWeightKg: number;
    declaredValueUSD: number;
    /** Each badge gets rendered in the badges row. */
    badges: { kind: "hazmat" | "reefer" | "dgr" | "per" | "val"; label: string }[];
};

function summarizeManifest(v: Vehicle): ManifestSummary | null {
    if (v.type === "ship") {
        const m = (v as Ship).manifest;
        if (!m) return null;
        const badges: ManifestSummary["badges"] = [];
        if (m.hazmatPresent) badges.push({ kind: "hazmat", label: "HAZMAT" });
        if (m.reeferPresent) badges.push({ kind: "reefer", label: "REEFER" });
        return {
            title: "MANIFEST",
            docNumber: m.manifestNumber,
            tripNumber: m.voyageNumber,
            shipmentCount: m.shipments.length,
            primaryUnit: m.totalContainers != null
                ? { icon: <Container size={11} />, label: "Containers (TEU)", value: m.totalContainers.toLocaleString() }
                : m.totalUnits != null
                ? { icon: <TruckIcon size={11} />, label: "Vehicle units",     value: m.totalUnits.toLocaleString() }
                : undefined,
            grossWeightKg: m.totalGrossWeightKg,
            declaredValueUSD: m.totalDeclaredValueUSD,
            badges,
        };
    }
    if (v.type === "truck") {
        const m = (v as Truck).manifest;
        if (!m) return null;
        const badges: ManifestSummary["badges"] = [];
        if (m.hazmatPresent) badges.push({ kind: "hazmat", label: "ADR HAZMAT" });
        if (m.reeferPresent) badges.push({ kind: "reefer", label: "REEFER" });
        return {
            title: "CMR CONSIGNMENT",
            docNumber: m.consignmentNumber,
            tripNumber: m.tripNumber,
            shipmentCount: m.shipments.length,
            primaryUnit: m.totalPallets != null
                ? { icon: <Package size={11} />, label: "Pallets", value: m.totalPallets.toLocaleString() }
                : undefined,
            grossWeightKg: m.totalGrossWeightKg,
            declaredValueUSD: m.totalDeclaredValueUSD,
            badges,
        };
    }
    if (v.type === "plane") {
        const m = (v as Plane).manifest;
        if (!m) return null;
        const badges: ManifestSummary["badges"] = [];
        if (m.dangerousGoodsOnboard) badges.push({ kind: "dgr",    label: "DGR" });
        if (m.perishablesOnboard)    badges.push({ kind: "per",    label: "PERISHABLE" });
        if (m.coldChainOnboard)      badges.push({ kind: "reefer", label: "COLD CHAIN" });
        if (m.valuableOnboard)       badges.push({ kind: "val",    label: "VAL" });
        return {
            title: "AIR WAYBILL",
            docNumber: m.masterAwbNumber,
            tripNumber: m.flightNumber,
            shipmentCount: m.shipments.length,
            primaryUnit: {
                icon: <Package size={11} />,
                label: "Pieces (PCS)",
                sublabel: "individual packages",
                value: m.totalPieces.toLocaleString(),
            },
            grossWeightKg: m.totalGrossWeightKg,
            declaredValueUSD: m.totalDeclaredValueUSD,
            badges,
        };
    }
    return null;
}

/** Compact manifest summary — aggregate badges plus a button that opens
 *  the dedicated ManifestPanel overlay. Designed to coexist with the other
 *  detail cards (VESSEL, POSITION, WEATHER) without dominating the column. */
function ManifestSummaryCard({
    vehicle, onOpen,
}: {
    vehicle: Vehicle;
    onOpen: () => void;
}) {
    const s = summarizeManifest(vehicle);
    if (!s) return null;
    const manifest = s;
    return (
        <div className="mx-4 mb-3 bg-zinc-900/50 border border-zinc-800/60 rounded-lg overflow-hidden">
            {/* Title — type-aware (MANIFEST / CMR / AWB) */}
            <div className="px-4 pt-3 pb-2 text-[9px] font-mono tracking-[0.2em] text-zinc-500 flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                    <Package size={11} />
                    {manifest.title}
                </span>
                <span className="font-mono text-[9px] text-zinc-600 normal-case tracking-normal">
                    {manifest.shipmentCount} {manifest.shipmentCount === 1 ? "shipment" : "shipments"}
                </span>
            </div>

            {/* Aggregate label/value rows. */}
            <div className="px-4 pb-3 space-y-1">
                {manifest.primaryUnit && (
                    <DetailRow
                        icon={manifest.primaryUnit.icon}
                        label={manifest.primaryUnit.label}
                        value={manifest.primaryUnit.value}
                        mono
                    />
                )}
                <DetailRow
                    label="Gross weight"
                    value={formatTonnes(manifest.grossWeightKg)}
                    mono
                />
                <DetailRow
                    label="Declared value"
                    value={
                        <span className="text-white font-semibold">
                            {formatUSD(manifest.declaredValueUSD)}
                        </span>
                    }
                    mono
                />
            </div>

            {/* Status badges (HAZMAT / REEFER / DGR / PER / VAL / COLD CHAIN). */}
            {manifest.badges.length > 0 && (
                <div className="px-4 pb-3 flex flex-wrap gap-1.5">
                    {manifest.badges.map((b) => (
                        <ManifestBadge key={b.kind + b.label} kind={b.kind} label={b.label} />
                    ))}
                </div>
            )}

            {/* CTA — opens the dedicated panel */}
            <button
                onClick={onOpen}
                className="w-full px-4 py-2.5 border-t border-zinc-800/60 bg-zinc-900/40 hover:bg-zinc-800/60 text-left flex items-center justify-between transition-colors focus:outline-none focus:bg-zinc-800/70"
            >
                <span className="text-[11px] text-zinc-300 font-mono tracking-wider">VIEW MANIFEST</span>
                <ChevronRight size={14} className="text-zinc-500" />
            </button>
        </div>
    );
}

/** Small badge used inside the summary card + panel. Maps each kind to a
 *  consistent colour (HAZMAT/DGR red, REEFER/COLD sky, VAL amber, PER green). */
function ManifestBadge({ kind, label }: { kind: "hazmat" | "reefer" | "dgr" | "per" | "val"; label: string }) {
    const styles: Record<typeof kind, string> = {
        hazmat: "text-red-300 border-red-500/40 bg-red-500/[0.08]",
        dgr:    "text-red-300 border-red-500/40 bg-red-500/[0.08]",
        reefer: "text-sky-300 border-sky-500/40 bg-sky-500/[0.08]",
        per:    "text-emerald-300 border-emerald-500/40 bg-emerald-500/[0.08]",
        val:    "text-amber-300 border-amber-500/40 bg-amber-500/[0.08]",
    };
    const icon =
        kind === "hazmat" || kind === "dgr" ? <AlertTriangle size={10} /> :
        kind === "reefer" ? <Snowflake size={10} /> :
        null;
    return (
        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-mono tracking-wider ${styles[kind]}`}>
            {icon} {label}
        </span>
    );
}

/** Full-screen overlay showing every shipment in the manifest. Vehicle-aware:
 *  dispatches to ShipmentRow / TruckShipmentRow / AirShipmentRow per type
 *  and shows the right document label (B/L / CMR / AWB). */
function ManifestPanel({
    vehicle, onBack,
}: {
    vehicle: Vehicle;
    onBack: () => void;
}) {
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const s = summarizeManifest(vehicle);
    if (!s) return null;

    // Vehicle-type-specific headline subtitle + back-button label
    const backLabel  = vehicle.type === "ship" ? "VESSEL" : vehicle.type === "truck" ? "TRUCK" : "FLIGHT";
    const heading    = vehicle.type === "ship" ? "CARGO MANIFEST"
                      : vehicle.type === "truck" ? "CMR CONSIGNMENT NOTE"
                      : "AIR WAYBILL (MASTER)";
    const headingSub =
        vehicle.type === "ship"
            ? ((vehicle as Ship).vesselSubType ? VESSEL_SUBTYPE_LABELS[(vehicle as Ship).vesselSubType!] : "Vessel")
            : vehicle.type === "truck"
            ? `${(vehicle as Truck).manifest!.trailerType.replace("_", " ")} · ${(vehicle as Truck).manifest!.loadFactor}`
            : `${(vehicle as Plane).manifest!.flightNumber} · ${(vehicle as Plane).airline ?? "Petros Air"}`;

    return (
        <div className="absolute inset-0 z-20 flex flex-col bg-zinc-950 panel-enter">
            {/* Drawer header — Back left, vehicle name centre, Excel download right. */}
            <div className="flex items-center justify-between px-3 py-2.5 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur-sm">
                <button
                    onClick={onBack}
                    className="flex items-center gap-1.5 text-[10px] font-mono tracking-[0.15em] text-zinc-500 hover:text-white transition-colors"
                >
                    <ChevronLeft size={12} />
                    {backLabel}
                </button>
                <span className="text-[10px] font-mono tracking-wider text-zinc-400 truncate flex-1 text-center px-2">
                    {vehicle.name}
                </span>
                {/* Hits the backend xlsx endpoint and lets the browser save it.
                    Using a real <a download> so the browser uses the
                    Content-Disposition filename from the server response. */}
                <a
                    href={apiUrl(`/api/fleet/petros/${vehicle.id}/manifest.xlsx`)}
                    download
                    title="Download manifest as Excel (.xlsx)"
                    className="inline-flex items-center gap-1.5 text-[10px] font-mono tracking-[0.15em] text-zinc-500 hover:text-white transition-colors focus:outline-none"
                >
                    <Download size={12} />
                    XLSX
                </a>
            </div>

            {/* Scroll body */}
            <div className="flex-1 overflow-y-auto">
                {/* Headline block */}
                <div className="px-4 pt-4 pb-3 border-b border-zinc-800/60">
                    <div className="text-[9px] font-mono tracking-[0.25em] text-zinc-500 mb-1">
                        {heading}
                    </div>
                    <div className="text-[15px] text-white font-medium capitalize">{headingSub}</div>
                    <div className="text-[10px] font-mono text-zinc-500 mt-1 flex items-center gap-2 tabular-nums">
                        <span>{s.docNumber}</span>
                        <span className="text-zinc-700">•</span>
                        <span>{s.tripNumber}</span>
                    </div>
                </div>

                {/* Aggregate summary block — type-aware tiles */}
                <ManifestSummaryGrid vehicle={vehicle} />

                {/* Shipment list */}
                <div className="text-[9px] font-mono tracking-[0.2em] text-zinc-500 px-4 pt-4 pb-2">
                    SHIPMENTS
                </div>
                <div>
                    {vehicle.type === "ship" && (vehicle as Ship).manifest!.shipments.map((sh) => (
                        <ShipmentRow
                            key={sh.blNumber}
                            shipment={sh}
                            expanded={expandedId === sh.blNumber}
                            onToggle={() => setExpandedId(expandedId === sh.blNumber ? null : sh.blNumber)}
                        />
                    ))}
                    {vehicle.type === "truck" && (vehicle as Truck).manifest!.shipments.map((sh) => (
                        <TruckShipmentRow
                            key={sh.consignmentNumber}
                            shipment={sh}
                            expanded={expandedId === sh.consignmentNumber}
                            onToggle={() => setExpandedId(expandedId === sh.consignmentNumber ? null : sh.consignmentNumber)}
                        />
                    ))}
                    {vehicle.type === "plane" && (vehicle as Plane).manifest!.shipments.map((sh) => (
                        <AirShipmentRow
                            key={sh.houseAwbNumber}
                            shipment={sh}
                            expanded={expandedId === sh.houseAwbNumber}
                            onToggle={() => setExpandedId(expandedId === sh.houseAwbNumber ? null : sh.houseAwbNumber)}
                        />
                    ))}
                </div>

                <div className="h-4" />
            </div>
        </div>
    );
}

/** Per-type summary tiles — extracted so ManifestPanel stays readable. */
function ManifestSummaryGrid({ vehicle }: { vehicle: Vehicle }) {
    const badges = summarizeManifest(vehicle)?.badges ?? [];

    return (
        <div className="px-4 py-4 border-b border-zinc-800/60 grid grid-cols-2 gap-3">
            {vehicle.type === "ship" && <ShipSummaryTiles ship={vehicle as Ship} />}
            {vehicle.type === "truck" && <TruckSummaryTiles truck={vehicle as Truck} />}
            {vehicle.type === "plane" && <PlaneSummaryTiles plane={vehicle as Plane} />}
            {badges.length > 0 && (
                <div className="col-span-2 flex flex-wrap gap-2 pt-1">
                    {badges.map((b) => {
                        const big = (
                            b.kind === "hazmat" ? "HAZMAT ON BOARD" :
                            b.kind === "dgr"    ? "DANGEROUS GOODS" :
                            b.kind === "reefer" ? "COLD CHAIN" :
                            b.kind === "per"    ? "PERISHABLES" :
                            b.kind === "val"    ? "VALUABLE" :
                            b.label
                        );
                        return (
                            <ManifestBadge key={b.kind + b.label} kind={b.kind} label={big} />
                        );
                    })}
                </div>
            )}
        </div>
    );
}

function ShipSummaryTiles({ ship }: { ship: Ship }) {
    const m = ship.manifest!;
    return (
        <>
            {m.totalContainers != null && (
                <SummaryTile
                    icon={<Container size={12} />}
                    label="Containers (TEU)"
                    sublabel="twenty-foot equivalent"
                    value={m.totalContainers.toLocaleString()}
                />
            )}
            {m.totalUnits != null && (
                <SummaryTile icon={<TruckIcon size={12} />} label="Vehicle units" value={m.totalUnits.toLocaleString()} />
            )}
            <SummaryTile label="Gross weight" value={formatTonnes(m.totalGrossWeightKg)} />
            <SummaryTile label="Volume"       value={`${m.totalVolumeCBM.toLocaleString()} m³`} />
            <SummaryTile label="Declared value" value={formatUSD(m.totalDeclaredValueUSD)} highlight />
            <SummaryTile label="Shipments"    value={m.shipments.length.toString()} />
        </>
    );
}

function TruckSummaryTiles({ truck }: { truck: Truck }) {
    const m = truck.manifest!;
    return (
        <>
            {m.totalPallets != null && (
                <SummaryTile icon={<Package size={12} />} label="Pallets" value={m.totalPallets.toLocaleString()} />
            )}
            <SummaryTile label="Gross weight" value={formatTonnes(m.totalGrossWeightKg)} />
            <SummaryTile label="Volume"       value={`${m.totalVolumeM3.toLocaleString()} m³`} />
            <SummaryTile label="Trailer"      value={m.trailerType.replace("_", " ")} />
            <SummaryTile label="Vehicle plate" value={m.vehicleRegistration} />
            <SummaryTile label="Load type"   value={m.loadFactor === "FTL" ? "Full Truckload" : "Less than Truckload"} />
            <SummaryTile label="Declared value" value={formatUSD(m.totalDeclaredValueUSD)} highlight />
            <SummaryTile label="Shipments"   value={m.shipments.length.toString()} />
        </>
    );
}

function PlaneSummaryTiles({ plane }: { plane: Plane }) {
    const m = plane.manifest!;
    return (
        <>
            <SummaryTile
                icon={<Package size={12} />}
                label="Pieces (PCS)"
                sublabel="individual packages"
                value={m.totalPieces.toLocaleString()}
            />
            {m.uldCount != null && <SummaryTile label="ULDs" value={m.uldCount.toString()} />}
            <SummaryTile label="Gross weight" value={formatTonnes(m.totalGrossWeightKg)} />
            <SummaryTile
                label="Chargeable weight"
                sublabel="max of actual & volumetric"
                value={formatTonnes(m.totalChargeableWeightKg)}
            />
            <SummaryTile label="Volume" value={`${m.totalVolumeM3.toLocaleString()} m³`} />
            <SummaryTile label="Declared value" value={formatUSD(m.totalDeclaredValueUSD)} highlight />
            <SummaryTile label="Flight" value={m.flightNumber} />
            <SummaryTile label="Shipments" value={m.shipments.length.toString()} />
        </>
    );
}

/** Small stat tile used in the manifest panel's summary grid. */
function SummaryTile({
    label, value, icon, highlight = false, sublabel,
}: {
    label: string;
    value: string;
    icon?: React.ReactNode;
    highlight?: boolean;
    /** Optional small explanatory text under the label — used to spell out
     *  industry abbreviations like TEU on first encounter. */
    sublabel?: string;
}) {
    return (
        <div className="bg-zinc-900/40 border border-zinc-800/60 rounded-md px-3 py-2">
            <div className="text-[9px] font-mono tracking-[0.2em] text-zinc-500 flex items-center gap-1">
                {icon}
                {label.toUpperCase()}
            </div>
            {sublabel && (
                <div className="text-[8px] text-zinc-600 italic mt-0.5 leading-tight">{sublabel}</div>
            )}
            <div className={`mt-0.5 font-mono tabular-nums ${highlight ? "text-[16px] text-white font-semibold" : "text-[13px] text-zinc-100"}`}>
                {value}
            </div>
        </div>
    );
}

function ShipmentRow({
    shipment, expanded, onToggle,
}: {
    shipment: CargoShipment;
    expanded: boolean;
    onToggle: () => void;
}) {
    // Primary metric shown in collapsed view — picks the most informative
    // count for the shipment's cargo form: TEU for containers, tonnes for
    // bulk, units for RoRo, packages for breakbulk.
    const primaryMetric = (() => {
        switch (shipment.cargoForm) {
            case "containerized":
            case "reefer_containers":
                return `${shipment.containerCount} × ${shipment.containerType ?? "container"}`;
            case "bulk_liquid":
            case "bulk_dry":
                return formatTonnes(shipment.grossWeightKg);
            case "vehicle_units":
                return `${shipment.unitCount?.toLocaleString()} units`;
            case "breakbulk":
                return `${shipment.packageCount.toLocaleString()} ${PACKAGE_LABELS[shipment.packageType] ?? "packages"}`;
            default:
                return "";
        }
    })();

    const cargoFormIcon = (() => {
        switch (shipment.cargoForm) {
            case "containerized":
            case "reefer_containers":
                return <Container size={11} />;
            case "bulk_liquid":
                return <Droplets size={11} />;
            case "bulk_dry":
                return <Wheat size={11} />;
            case "vehicle_units":
                return <TruckIcon size={11} />;
            case "breakbulk":
                return <Package size={11} />;
            default:
                return null;
        }
    })();

    return (
        <div className="border-b border-zinc-800/40 last:border-b-0">
            {/* Collapsed row — clickable to expand */}
            <button
                onClick={onToggle}
                className="w-full px-4 py-2 flex items-center gap-2 text-left hover:bg-zinc-800/30 transition-colors focus:outline-none"
            >
                <span className="text-zinc-600">
                    {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </span>
                <span className="text-zinc-500">{cargoFormIcon}</span>
                <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 min-w-0">
                        <span className="text-[12px] text-white truncate">{shipment.commodityDescription}</span>
                        {shipment.hazmat && (
                            <span className={`shrink-0 px-1 py-px rounded text-[8px] font-mono tracking-wide border ${hazmatBadgeColor(shipment.hazmat.imdgClass)}`}>
                                {shipment.hazmat.imdgClass}
                            </span>
                        )}
                        {shipment.temperature != null && (
                            <span className="shrink-0 inline-flex items-center gap-0.5 px-1 py-px rounded text-[8px] font-mono tracking-wide border text-sky-300 border-sky-500/40 bg-sky-500/[0.08]">
                                <Snowflake size={8} />
                                {shipment.temperature}°
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-[10px] font-mono text-zinc-500 tabular-nums">
                        <span>{shipment.blNumber}</span>
                        <span className="text-zinc-700">•</span>
                        <span>{primaryMetric}</span>
                    </div>
                </div>
                <span className="text-[12px] font-semibold text-white tabular-nums shrink-0">
                    {formatUSD(shipment.declaredValueUSD)}
                </span>
            </button>

            {/* Expanded detail — organised into clear sections so the reader
                can scan quickly. Plain-language labels everywhere; regulatory
                codes (HS, UN, IMDG, Incoterms) appear alongside their
                expanded name so a non-domain reader doesn't have to Google. */}
            {expanded && (
                <div className="px-4 pb-4 pt-2 bg-zinc-950/30 text-[11px]">
                    {/* Dangerous goods banner */}
                    {shipment.hazmat && (
                        <div className="mb-3 rounded border border-red-500/40 bg-red-500/[0.06] px-3 py-2.5">
                            <div className="flex items-center gap-1.5 text-[10px] font-mono tracking-[0.15em] text-red-300 mb-1.5">
                                <AlertTriangle size={11} />
                                DANGEROUS GOODS
                            </div>
                            <div className="text-[12px] text-red-100 leading-snug">
                                <span className="font-mono tabular-nums">{shipment.hazmat.unNumber}</span>
                                {" — "}
                                {imdgClassLabel(shipment.hazmat.imdgClass)}{" "}
                                <span className="text-red-300/70">(Class {shipment.hazmat.imdgClass})</span>
                            </div>
                            {shipment.hazmat.packingGroup && (
                                <div className="text-[11px] text-red-200/80 mt-0.5">
                                    Packing group {shipment.hazmat.packingGroup}
                                </div>
                            )}
                            <div className="text-[10px] text-red-300/70 mt-1 italic">
                                {shipment.hazmat.properShippingName}
                            </div>
                        </div>
                    )}

                    {/* ── Goods ───────────────────────────────────────── */}
                    <SectionHeader label="Goods" />
                    <ManifestRow label="Commodity"     value={shipment.commodityDescription} />
                    <ManifestRow label="Tariff code"   value={`HS-${shipment.hsCode}`} mono />
                    <ManifestRow label="Country of origin" value={countryName(shipment.countryOfOrigin)} />

                    {/* ── Cargo (type-specific) ───────────────────────── */}
                    <SectionHeader label="Cargo" />
                    {/* Container ships and reefer ships */}
                    {shipment.containerType && shipment.containerCount != null && (
                        <ManifestRow
                            label="Containers"
                            value={`${shipment.containerCount} × ${containerTypeLabel(shipment.containerType)}`}
                        />
                    )}
                    {shipment.containerIds && shipment.containerIds.length > 0 && (
                        <ManifestWrappedRow
                            label="Container IDs"
                            items={shipment.containerIds}
                            extraCount={(shipment.containerCount ?? shipment.containerIds.length) - shipment.containerIds.length}
                        />
                    )}
                    {shipment.sealNumbers && shipment.sealNumbers.length > 0 && (
                        <ManifestWrappedRow label="Seals" items={shipment.sealNumbers} />
                    )}
                    {/* Tankers */}
                    {shipment.productGrade && shipment.productGrade !== shipment.commodityDescription && (
                        <ManifestRow label="Product grade" value={shipment.productGrade} />
                    )}
                    {shipment.tankNumbers && shipment.tankNumbers.length > 0 && (
                        <ManifestRow
                            label={`Cargo tanks (${shipment.tankNumbers.length})`}
                            value={shipment.tankNumbers.join(", ")}
                            mono
                        />
                    )}
                    {/* Bulkers */}
                    {shipment.holdNumbers && shipment.holdNumbers.length > 0 && (
                        <ManifestRow
                            label={`Cargo holds (${shipment.holdNumbers.length})`}
                            value={shipment.holdNumbers.join(", ")}
                            mono
                        />
                    )}
                    {/* RoRo */}
                    {shipment.unitType && (
                        <ManifestRow
                            label="Vehicle type"
                            value={RORO_UNIT_LABELS[shipment.unitType] ?? shipment.unitType}
                        />
                    )}
                    {shipment.temperature != null && (
                        <ManifestRow
                            label="Temperature"
                            value={
                                <span className="inline-flex items-center gap-1">
                                    <Snowflake size={10} className="text-sky-400" />
                                    {shipment.temperature}°C
                                </span>
                            }
                        />
                    )}

                    {/* ── Weights & dimensions ────────────────────────── */}
                    <SectionHeader label="Weight & volume" />
                    <ManifestRow label="Gross weight" value={formatTonnes(shipment.grossWeightKg)} mono />
                    <ManifestRow label="Net weight"   value={formatTonnes(shipment.netWeightKg)}   mono />
                    <ManifestRow
                        label="Volume"
                        value={`${shipment.volumeCBM.toLocaleString()} m³`}
                        mono
                    />

                    {/* ── Commercial ──────────────────────────────────── */}
                    <SectionHeader label="Commercial" />
                    <ManifestRow label="Incoterms"     value={incotermLabel(shipment.incoterms)} />
                    <ManifestRow label="Freight terms" value={freightTermLabel(shipment.freightTerms)} />
                    {shipment.customerCode && (
                        <ManifestRow label="Customer reference" value={shipment.customerCode} mono />
                    )}
                </div>
            )}
        </div>
    );
}

// ────────────────────────────────────────────────────────────────────────────
// TruckShipmentRow — collapsed/expanded per-shipment view for road freight.
// Distinct from the ship version: pallets instead of containers, ADR
// dangerous goods (with tunnel restriction codes) instead of IMDG, no
// container/seal lists. CMR consignment number replaces B/L.
// ────────────────────────────────────────────────────────────────────────────

function TruckShipmentRow({
    shipment, expanded, onToggle,
}: {
    shipment: TruckShipment;
    expanded: boolean;
    onToggle: () => void;
}) {
    const primary =
        shipment.packageType === "bulk"
            ? formatTonnes(shipment.grossWeightKg)
            : `${shipment.packageCount} × ${shipment.packageType.replace("_", " ")}`;
    return (
        <div className="border-b border-zinc-800/40 last:border-b-0">
            <button
                onClick={onToggle}
                className="w-full px-4 py-2 flex items-center gap-2 text-left hover:bg-zinc-800/30 transition-colors focus:outline-none"
            >
                <span className="text-zinc-600">
                    {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </span>
                <span className="text-zinc-500"><Package size={11} /></span>
                <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 min-w-0">
                        <span className="text-[12px] text-white truncate">{shipment.goodsDescription}</span>
                        {shipment.adr && (
                            <span className={`shrink-0 px-1 py-px rounded text-[8px] font-mono tracking-wide border ${hazmatBadgeColor(shipment.adr.adrClass)}`}>
                                {shipment.adr.adrClass}
                            </span>
                        )}
                        {shipment.temperature != null && (
                            <span className="shrink-0 inline-flex items-center gap-0.5 px-1 py-px rounded text-[8px] font-mono tracking-wide border text-sky-300 border-sky-500/40 bg-sky-500/[0.08]">
                                <Snowflake size={8} /> {shipment.temperature}°
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-[10px] font-mono text-zinc-500 tabular-nums">
                        <span>{shipment.consignmentNumber}</span>
                        <span className="text-zinc-700">•</span>
                        <span>{primary}</span>
                    </div>
                </div>
                <span className="text-[12px] font-semibold text-white tabular-nums shrink-0">
                    {formatUSD(shipment.declaredValueUSD)}
                </span>
            </button>

            {expanded && (
                <div className="px-4 pb-4 pt-2 bg-zinc-950/30 text-[11px]">
                    {/* ADR dangerous-goods banner */}
                    {shipment.adr && (
                        <div className="mb-3 rounded border border-red-500/40 bg-red-500/[0.06] px-3 py-2.5">
                            <div className="flex items-center gap-1.5 text-[10px] font-mono tracking-[0.15em] text-red-300 mb-1.5">
                                <AlertTriangle size={11} /> ADR DANGEROUS GOODS
                            </div>
                            <div className="text-[12px] text-red-100 leading-snug">
                                <span className="font-mono tabular-nums">{shipment.adr.unNumber}</span>
                                {" — "}
                                {imdgClassLabel(shipment.adr.adrClass)}{" "}
                                <span className="text-red-300/70">(ADR class {shipment.adr.adrClass})</span>
                            </div>
                            {shipment.adr.packingGroup && (
                                <div className="text-[11px] text-red-200/80 mt-0.5">
                                    Packing group {shipment.adr.packingGroup}
                                </div>
                            )}
                            {shipment.adr.tunnelCode && (
                                <div className="text-[11px] text-red-200/80 mt-0.5">
                                    Tunnel restriction code: {shipment.adr.tunnelCode}
                                </div>
                            )}
                            <div className="text-[10px] text-red-300/70 mt-1 italic">
                                {shipment.adr.properShippingName}
                            </div>
                        </div>
                    )}

                    <SectionHeader label="Goods" />
                    <ManifestRow label="Commodity"     value={shipment.goodsDescription} />
                    <ManifestRow label="Tariff code"   value={`HS-${shipment.hsCode}`} mono />
                    <ManifestRow label="Country of origin" value={countryName(shipment.countryOfOrigin)} />

                    <SectionHeader label="Packaging" />
                    <ManifestRow
                        label="Packages"
                        value={`${shipment.packageCount} × ${shipment.packageType.replace("_", " ")}`}
                    />
                    {shipment.temperature != null && (
                        <ManifestRow
                            label="Temperature"
                            value={<span className="inline-flex items-center gap-1"><Snowflake size={10} className="text-sky-400" />{shipment.temperature}°C</span>}
                        />
                    )}

                    <SectionHeader label="Weight & volume" />
                    <ManifestRow label="Gross weight" value={formatTonnes(shipment.grossWeightKg)} mono />
                    <ManifestRow label="Net weight"   value={formatTonnes(shipment.netWeightKg)} mono />
                    <ManifestRow label="Volume"       value={`${shipment.volumeM3} m³`} mono />

                    <SectionHeader label="Commercial" />
                    {shipment.incoterms && (
                        <ManifestRow label="Incoterms"     value={incotermLabel(shipment.incoterms)} />
                    )}
                    <ManifestRow label="Freight terms" value={freightTermLabel(shipment.freightTerms)} />
                    {shipment.customerCode && (
                        <ManifestRow label="Customer reference" value={shipment.customerCode} mono />
                    )}
                </div>
            )}
        </div>
    );
}

// ────────────────────────────────────────────────────────────────────────────
// AirShipmentRow — collapsed/expanded per-shipment view for air cargo.
// Pieces (PCS) instead of containers/pallets. Chargeable weight (the
// max(actual, volumetric) figure airlines bill on) is its own row. IATA
// Special Handling Codes (SHC) rendered as chips. DGR — air-specific
// dangerous goods rules with packing instructions — replaces IMDG/ADR.
// ────────────────────────────────────────────────────────────────────────────

const SHC_LABELS: Record<string, string> = {
    DGR: "Dangerous goods",
    PER: "Perishable",
    COL: "Cool (+2 to +8 °C)",
    FRO: "Frozen",
    ERT: "Extreme temperature regulated",
    VAL: "Valuable",
    VUN: "Vulnerable",
    AVI: "Live animals",
    HEA: "Heavy (>150 kg per piece)",
    BIG: "Outsized",
    ICE: "Dry ice in shipment",
    CAO: "Cargo aircraft only",
};

function AirShipmentRow({
    shipment, expanded, onToggle,
}: {
    shipment: AirShipment;
    expanded: boolean;
    onToggle: () => void;
}) {
    return (
        <div className="border-b border-zinc-800/40 last:border-b-0">
            <button
                onClick={onToggle}
                className="w-full px-4 py-2 flex items-center gap-2 text-left hover:bg-zinc-800/30 transition-colors focus:outline-none"
            >
                <span className="text-zinc-600">
                    {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </span>
                <span className="text-zinc-500"><Package size={11} /></span>
                <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 min-w-0 flex-wrap">
                        <span className="text-[12px] text-white truncate">{shipment.goodsDescription}</span>
                        {shipment.dgr && (
                            <span className={`shrink-0 px-1 py-px rounded text-[8px] font-mono tracking-wide border ${hazmatBadgeColor(shipment.dgr.dgrClass)}`}>
                                DGR {shipment.dgr.dgrClass}
                            </span>
                        )}
                        {shipment.specialHandlingCodes.filter((c) => c !== "DGR").slice(0, 3).map((c) => (
                            <span key={c} className="shrink-0 px-1 py-px rounded text-[8px] font-mono tracking-wide border text-amber-300 border-amber-500/40 bg-amber-500/[0.08]">
                                {c}
                            </span>
                        ))}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-[10px] font-mono text-zinc-500 tabular-nums">
                        <span>{shipment.houseAwbNumber}</span>
                        <span className="text-zinc-700">•</span>
                        <span>{shipment.pieces} PCS · {shipment.chargeableWeightKg.toLocaleString()} kg ch.</span>
                    </div>
                </div>
                <span className="text-[12px] font-semibold text-white tabular-nums shrink-0">
                    {formatUSD(shipment.declaredValueUSD)}
                </span>
            </button>

            {expanded && (
                <div className="px-4 pb-4 pt-2 bg-zinc-950/30 text-[11px]">
                    {/* DGR (IATA Dangerous Goods Regulations) banner */}
                    {shipment.dgr && (
                        <div className="mb-3 rounded border border-red-500/40 bg-red-500/[0.06] px-3 py-2.5">
                            <div className="flex items-center gap-1.5 text-[10px] font-mono tracking-[0.15em] text-red-300 mb-1.5">
                                <AlertTriangle size={11} /> DANGEROUS GOODS (IATA DGR)
                            </div>
                            <div className="text-[12px] text-red-100 leading-snug">
                                <span className="font-mono tabular-nums">{shipment.dgr.unNumber}</span>
                                {" — "}
                                {imdgClassLabel(shipment.dgr.dgrClass)}{" "}
                                <span className="text-red-300/70">(IATA class {shipment.dgr.dgrClass})</span>
                            </div>
                            {shipment.dgr.packingInstruction && (
                                <div className="text-[11px] text-red-200/80 mt-0.5">
                                    Packing instruction PI {shipment.dgr.packingInstruction}
                                </div>
                            )}
                            {shipment.dgr.cargoAircraftOnly && (
                                <div className="text-[11px] text-red-200/80 mt-0.5">
                                    Cargo aircraft only (CAO) — cannot fly on passenger aircraft
                                </div>
                            )}
                            <div className="text-[10px] text-red-300/70 mt-1 italic">
                                {shipment.dgr.properShippingName}
                            </div>
                        </div>
                    )}

                    <SectionHeader label="Goods" />
                    <ManifestRow label="Commodity"      value={shipment.goodsDescription} />
                    <ManifestRow label="Tariff code"    value={`HS-${shipment.hsCode}`} mono />
                    <ManifestRow label="Country of origin" value={countryName(shipment.countryOfOrigin)} />

                    <SectionHeader label="Cargo" />
                    <ManifestRow label="Pieces"                value={`${shipment.pieces} PCS`} mono />
                    {shipment.uldType && (
                        <ManifestRow label="ULD type"          value={`${shipment.uldType}${shipment.uldType === "loose" ? "" : " container"}`} />
                    )}
                    {shipment.temperature != null && (
                        <ManifestRow
                            label="Temperature"
                            value={<span className="inline-flex items-center gap-1"><Snowflake size={10} className="text-sky-400" />{shipment.temperature}°C</span>}
                        />
                    )}
                    {shipment.specialHandlingCodes.length > 0 && (
                        <ManifestRow
                            label="Special handling"
                            value={
                                <div className="flex flex-wrap gap-1 justify-end">
                                    {shipment.specialHandlingCodes.map((c) => (
                                        <span
                                            key={c}
                                            title={SHC_LABELS[c] ?? c}
                                            className="px-1 py-px rounded border text-[9px] font-mono tracking-wide text-amber-300 border-amber-500/40 bg-amber-500/[0.08] cursor-help"
                                        >
                                            {c}
                                        </span>
                                    ))}
                                </div>
                            }
                        />
                    )}

                    <SectionHeader label="Weight & volume" />
                    <ManifestRow label="Gross weight"      value={formatTonnes(shipment.grossWeightKg)} mono />
                    <ManifestRow
                        label="Chargeable weight"
                        value={
                            <span title="Max of actual gross and volumetric weight — what airlines bill on">
                                {formatTonnes(shipment.chargeableWeightKg)}
                            </span>
                        }
                        mono
                    />
                    <ManifestRow label="Volume"            value={`${shipment.volumeM3} m³`} mono />

                    <SectionHeader label="Commercial" />
                    <ManifestRow
                        label="Freight basis"
                        value={
                            shipment.freightBasis === "P" ? "Prepaid (shipper)" :
                            shipment.freightBasis === "C" ? "Collect (consignee)" :
                            "Other arrangement"
                        }
                    />
                    <ManifestRow
                        label="Customs declared value"
                        value={formatUSD(shipment.declaredValueForCustomsUSD)}
                        mono
                    />
                    {shipment.customerCode && (
                        <ManifestRow label="Customer reference" value={shipment.customerCode} mono />
                    )}
                </div>
            )}
        </div>
    );
}

/** Section header inside the expanded shipment detail. Lowercase tracking-
 *  wider mono label with a hairline separator above. */
function SectionHeader({ label }: { label: string }) {
    return (
        <div className="text-[9px] font-mono tracking-[0.2em] text-zinc-500 uppercase mt-3 mb-1.5 pt-2 border-t border-zinc-800/40 first:mt-0 first:pt-0 first:border-t-0">
            {label}
        </div>
    );
}

/** Label/value row tuned for the manifest panel — allows the value to wrap
 *  (unlike DetailRow which truncates). Uses a fixed-ish left column so
 *  labels align nicely across rows in a section. */
function ManifestRow({
    label, value, mono = false,
}: {
    label: string;
    value: React.ReactNode;
    mono?: boolean;
}) {
    return (
        <div className="flex items-start gap-3 py-1 min-w-0">
            <span className="text-zinc-500 text-[11px] shrink-0 w-[36%] max-w-[140px] mt-0.5">
                {label}
            </span>
            <span className={`text-[12px] flex-1 text-right break-words ${mono ? "font-mono tabular-nums text-zinc-200" : "text-white"}`}>
                {value}
            </span>
        </div>
    );
}

/** Label + readable list of items (container IDs, seal numbers). Items
 *  flow into a two-column grid — each ID lives in its own cell so they
 *  can't visually run into each other the way a wrapped flex row did.
 *  Optional "+N more" trailing chip when the backend trimmed the list. */
function ManifestWrappedRow({
    label, items, extraCount = 0,
}: {
    label: string;
    items: string[];
    extraCount?: number;
}) {
    return (
        <div className="flex items-start gap-3 py-1 min-w-0">
            <span className="text-zinc-500 text-[11px] shrink-0 w-[36%] max-w-[140px] mt-0.5">
                {label}
            </span>
            <div className="flex-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-right text-[11px] font-mono tabular-nums text-zinc-200">
                {items.map((it) => (
                    <span key={it} className="truncate">{it}</span>
                ))}
                {extraCount > 0 && (
                    <span className="col-span-2 text-zinc-500 italic">+{extraCount} more</span>
                )}
            </div>
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

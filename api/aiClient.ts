// Thin client for /api/ai/chat.
//
// Assembles the per-request context snapshot from useVehicleStore so the model
// can ground its answer in real fleet state. Sends every Petros + live vehicle
// in compact form on every turn — the model is stateless and we want it to be
// able to answer ANY query without hand-rolled tool-calling. Conversation
// history is the caller's responsibility — pass the full message list every turn.
//
// Size budget: 150 vehicles × ~250 chars each ≈ 35 KB per request. Nemotron 3
// Super 120B has a 1M-token context window, so this lands easily and leaves
// plenty of headroom for the conversation history. Position precision is
// truncated to 3 decimal places (≈ 110 m) — enough for "where is this ship"
// answers, much smaller than full float resolution.

import { apiUrl } from "@/lib/apiClient";
import { useVehicleStore } from "@/stores/vehicleStore";
import { SCENARIOS, SCENARIO_BY_ID } from "@/data/scenarios";
import type { Vehicle, Ship, Plane, Truck } from "@/types/vehicle";
import type { Disruption } from "@/types/disruption";

export interface ChatMessage {
    role: "user" | "assistant";
    content: string;
}

export interface ChatResponse {
    message: { role: "assistant"; content: string };
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    model?: string;
}

// Compact vehicle record — only the fields the model actually needs to
// reason. Stripping nulls/undefineds keeps the JSON tight; truncating
// position to 3dp halves the byte count without losing useful precision.
interface CompactVehicle {
    id: string;
    name: string;
    type: "truck" | "ship" | "plane";
    company?: string;
    dataSource?: string;
    status: string;
    position: [number, number]; // [lat, lng]
    speed: number;              // km/h, rounded
    heading: number;
    cargo: string;
    destination?: [number, number]; // [lng, lat] — matches your Vehicle.destination convention
    remainingKm?: number;
    remainingMin?: number;
    temp?: number;
    // Ship-specific
    destPort?: string;
    callSign?: string;
    imo?: number;
    lengthM?: number;
    draughtM?: number;
    destRisk?: string;
    destIncident?: string;
    // Plane-specific
    flight?: string;
    airline?: string;
    dep?: string;
    arr?: string;
    altM?: number;
}

interface CompactDisruption {
    vehicleId: string;
    vehicleName: string;
    vehicleType: string;
    category: Disruption["category"];
    severity: Disruption["severity"];
    headline: string;
    description: string;
    sourceAuthority: string;
    sourceFeed: string;
    sourceCitation?: string;
    impact: Disruption["impact"];
    simulated: boolean;
}

interface ScenarioCatalogEntry {
    id: string;
    name: string;
    category: string;
    shortDescription: string;
}

interface FleetContext {
    dataMode: string;
    activeScenario: string | null;
    activeScenarioName: string | null;
    availableScenarios: ScenarioCatalogEntry[];
    selectedVehicleId: string | null;
    fleetSummary: {
        total: number;
        moving: number;
        delayed: number;
        stopped: number;
        byType: { truck: number; ship: number; plane: number };
        withDisruptions: number;
    };
    vehicles: CompactVehicle[];
    disruptions: CompactDisruption[];
    /** Flattened list of every shipment (B/L, CMR or AWB) across the
     *  fleet's manifests. The backend SQL snapshot loads these into a
     *  `shipments` table keyed by vehicle_id so the AI can JOIN cargo
     *  questions to spatial / status filters in one query. */
    shipments: CompactShipment[];
}

/** Single shipment row sent to the AI. Mirrors the SHIPMENT_COLUMNS schema
 *  in backend/services/fleet_sql.py. Mode-specific fields use friendly
 *  generic names (unitCount, unitLabel) so SQL queries don't have to
 *  branch on vehicle type. */
export interface CompactShipment {
    vehicleId: string;
    vehicleType: "ship" | "truck" | "plane";
    docId: string;           // B/L / CMR / HAWB
    customerCode?: string;
    commodity: string;
    hsCode: string;
    countryOrigin: string;
    grossKg: number;
    volumeM3: number;
    valueUSD: number;
    hazmat: 0 | 1;
    hazmatClass?: string;
    hazmatUn?: string;
    reefer: 0 | 1;
    temperature?: number;
    unitCount?: number;
    unitLabel?: "TEU" | "pallet" | "PCS";
    chargeableKg?: number;   // planes only
    shc?: string;            // planes only — joined IATA SHC
}

function r3(n: number): number {
    return Math.round(n * 1000) / 1000;
}

function compactVehicle(v: Vehicle): CompactVehicle {
    const base: CompactVehicle = {
        id: v.id,
        name: v.name,
        type: v.type,
        company: v.company,
        dataSource: v.dataSource,
        status: v.status,
        position: [r3(v.latitude), r3(v.longitude)],
        speed: Math.round(v.currentSpeed),
        heading: Math.round(v.heading),
        cargo: v.cargo,
    };

    if (v.destination) {
        base.destination = [r3(v.destination[0]), r3(v.destination[1])];
    }
    if (v.remainingDistance != null && v.remainingDistance > 0) {
        base.remainingKm = Math.round(v.remainingDistance);
    }
    if (v.remainingTime != null && v.remainingTime > 0) {
        base.remainingMin = Math.round(v.remainingTime);
    }
    if (v.temperature != null) {
        base.temp = v.temperature;
    }

    if (v.type === "ship") {
        const ship = v as Ship;
        if (ship.destinationPort) base.destPort = ship.destinationPort;
        if (ship.callSign) base.callSign = ship.callSign;
        if (ship.imoNumber) base.imo = ship.imoNumber;
        if (ship.vesselLength) base.lengthM = ship.vesselLength;
        if (ship.draught) base.draughtM = ship.draught;
        if (ship.destinationRisk && ship.destinationRisk !== "NONE") {
            base.destRisk = ship.destinationRisk;
            if (ship.destinationIncident) base.destIncident = ship.destinationIncident;
        }
    } else if (v.type === "plane") {
        const plane = v as Plane;
        if (plane.flightNumber) base.flight = plane.flightNumber;
        if (plane.airline) base.airline = plane.airline;
        if (plane.departureAirport) base.dep = plane.departureAirport;
        if (plane.arrivalAirport) base.arr = plane.arrivalAirport;
        if (plane.altitude) base.altM = plane.altitude;
    }

    return base;
}

/**
 * Build the snapshot the backend injects into the system prompt.
 *
 * Includes EVERY visible vehicle in compact form so the AI can answer
 * specific queries ("where is PT Pacific Star?", "which truck has the
 * highest speed?", "which ships are heading to Singapore?"). Position
 * precision is truncated to ~110 m, route polylines are omitted, and
 * only populated optional fields ship — keeps each record under ~300
 * bytes.
 */
function buildFleetContext(): FleetContext {
    const state = useVehicleStore.getState();
    const vehicles: Vehicle[] = state.vehicles;

    const moving = vehicles.filter((v) => v.status === "moving").length;
    const delayed = vehicles.filter((v) => v.status === "delayed").length;
    const stopped = vehicles.filter((v) => v.status === "stopped").length;

    const byType = {
        truck: vehicles.filter((v) => v.type === "truck").length,
        ship: vehicles.filter((v) => v.type === "ship").length,
        plane: vehicles.filter((v) => v.type === "plane").length,
    };

    const withDisruptions = vehicles.filter(
        (v) => v.disruptions && v.disruptions.length > 0,
    ).length;

    const compactVehicles = vehicles.map(compactVehicle);
    const shipments = vehicles.flatMap(compactShipmentsForVehicle);

    const disruptions = vehicles.flatMap((v) =>
        (v.disruptions ?? []).map((d) => ({
            vehicleId: v.id,
            vehicleName: v.name,
            vehicleType: v.type,
            category: d.category,
            severity: d.severity,
            headline: d.headline,
            description: d.description,
            sourceAuthority: d.source.authority,
            sourceFeed: d.source.feed,
            sourceCitation: d.source.citation,
            impact: d.impact,
            simulated: d.simulated ?? false,
        })),
    );

    const availableScenarios = SCENARIOS.map((s) => ({
        id: s.id,
        name: s.name,
        category: s.category,
        shortDescription: s.shortDescription,
    }));

    const activeScenarioName = state.activeScenario
        ? (SCENARIO_BY_ID[state.activeScenario]?.name ?? null)
        : null;

    return {
        dataMode: state.dataMode,
        activeScenario: state.activeScenario,
        activeScenarioName,
        availableScenarios,
        selectedVehicleId: state.selectedVehicleId,
        fleetSummary: {
            total: vehicles.length,
            moving,
            delayed,
            stopped,
            byType,
            withDisruptions,
        },
        vehicles: compactVehicles,
        disruptions,
        shipments,
    };
}

/** Flatten one vehicle's manifest into 0+ CompactShipment rows. Returns
 *  the union of fields the backend SQL schema expects, with type-specific
 *  fields packed into the generic unit_count / unit_label / chargeable_kg
 *  / shc columns so JOIN queries don't have to branch. */
function compactShipmentsForVehicle(v: Vehicle): CompactShipment[] {
    if (v.type === "ship") {
        const m = (v as Ship).manifest;
        if (!m) return [];
        return m.shipments.map((s) => ({
            vehicleId: v.id,
            vehicleType: "ship",
            docId: s.blNumber,
            customerCode: s.customerCode,
            commodity: s.commodityDescription,
            hsCode: s.hsCode,
            countryOrigin: s.countryOfOrigin,
            grossKg: s.grossWeightKg,
            volumeM3: s.volumeCBM,
            valueUSD: s.declaredValueUSD,
            hazmat: s.hazmat ? 1 : 0,
            hazmatClass: s.hazmat?.imdgClass,
            hazmatUn: s.hazmat?.unNumber,
            reefer: s.cargoForm === "reefer_containers" ? 1 : 0,
            temperature: s.temperature,
            unitCount: s.containerCount,
            unitLabel: s.containerCount ? "TEU" : undefined,
        }));
    }
    if (v.type === "truck") {
        const m = (v as Truck).manifest;
        if (!m) return [];
        return m.shipments.map((s) => ({
            vehicleId: v.id,
            vehicleType: "truck",
            docId: s.consignmentNumber,
            customerCode: s.customerCode,
            commodity: s.goodsDescription,
            hsCode: s.hsCode,
            countryOrigin: s.countryOfOrigin,
            grossKg: s.grossWeightKg,
            volumeM3: s.volumeM3,
            valueUSD: s.declaredValueUSD,
            hazmat: s.adr ? 1 : 0,
            hazmatClass: s.adr?.adrClass,
            hazmatUn: s.adr?.unNumber,
            reefer: s.temperature != null ? 1 : 0,
            temperature: s.temperature,
            unitCount: (s.packageType === "EUR_pallet" || s.packageType === "ISO_pallet") ? s.packageCount : undefined,
            unitLabel: (s.packageType === "EUR_pallet" || s.packageType === "ISO_pallet") ? "pallet" : undefined,
        }));
    }
    if (v.type === "plane") {
        const m = (v as Plane).manifest;
        if (!m) return [];
        return m.shipments.map((s) => ({
            vehicleId: v.id,
            vehicleType: "plane",
            docId: s.houseAwbNumber,
            customerCode: s.customerCode,
            commodity: s.goodsDescription,
            hsCode: s.hsCode,
            countryOrigin: s.countryOfOrigin,
            grossKg: s.grossWeightKg,
            volumeM3: s.volumeM3,
            valueUSD: s.declaredValueUSD,
            hazmat: s.dgr ? 1 : 0,
            hazmatClass: s.dgr?.dgrClass,
            hazmatUn: s.dgr?.unNumber,
            reefer: (s.specialHandlingCodes?.includes("COL") || s.specialHandlingCodes?.includes("FRO")) ? 1 : 0,
            temperature: s.temperature,
            unitCount: s.pieces,
            unitLabel: "PCS",
            chargeableKg: s.chargeableWeightKg,
            shc: s.specialHandlingCodes?.join(" "),
        }));
    }
    return [];
}

/**
 * Send a chat request. Pass the entire conversation history every turn —
 * the model has no memory between calls.
 */
export async function sendChat(messages: ChatMessage[]): Promise<ChatResponse> {
    const context = buildFleetContext();

    const response = await fetch(apiUrl("/api/ai/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, context }),
    });

    if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
            `Chat request failed: HTTP ${response.status} ${response.statusText} — ${detail.slice(0, 200)}`,
        );
    }

    return (await response.json()) as ChatResponse;
}

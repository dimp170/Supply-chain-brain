// Polling client for live ships.
//
// The AIS WebSocket subscription lives in the Python backend
// (`backend/services/ingestor.py`), which writes positions to SQLite. This
// module polls the FastAPI `/api/vessels` endpoint every five seconds and
// emits the same `Vehicle[]` shape the rest of the app already expects.
//
// `AISStatus` is exported because the Zustand store + BootOverlay +
// SystemStrip read its `state` / `vesselCount` / `lastMessage` fields. The
// polling client pulls those numbers from `/api/ingestor/status`.

import { Vehicle, Ship } from "@/types/vehicle";
import { apiJson } from "@/lib/apiClient";

const POLL_INTERVAL_MS = 5_000;

// ─── Status type — unchanged shape so BootOverlay/SystemStrip keep working ───

export type AISStatus = {
    state: "connecting" | "connected" | "disconnected" | "error";
    msgCount: number;
    vesselCount: number;
    lastMessage?: string;
};

type IngestorStatusPayload = {
    state: AISStatus["state"];
    msgCount: number;
    vesselCount: number;
    lastMessage?: string | null;
};

// The FastAPI `/api/vessels` endpoint returns `Ship` objects directly modulo
// two extra optional fields (destinationRisk, destinationIncident) that we
// strip out before handing the data to the store.
type ApiShip = Ship & {
    destinationRisk?: string;
    destinationIncident?: string;
};

// ─── ShipPoller ──────────────────────────────────────────────────────────────

export class ShipPoller {
    private timer: ReturnType<typeof setInterval> | null = null;
    private stopped = false;
    private lastStatus: AISStatus = {
        state: "connecting",
        msgCount: 0,
        vesselCount: 0,
    };

    constructor(
        private readonly onUpdate: (vessels: Vehicle[]) => void,
        private readonly onStatus?: (status: AISStatus) => void,
    ) {}

    start(): void {
        if (this.timer || this.stopped) return;
        this.emitStatus({ ...this.lastStatus, state: "connecting" });

        // Kick off an immediate poll, then settle into a steady cadence.
        void this.pollOnce();
        this.timer = setInterval(() => { void this.pollOnce(); }, POLL_INTERVAL_MS);
    }

    stop(): void {
        this.stopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private async pollOnce(): Promise<void> {
        if (this.stopped) return;

        // Two parallel concerns: vessels (the data the UI draws) and status
        // (the data the BootOverlay/SystemStrip render).
        let ships: Vehicle[] = [];
        let status: AISStatus = this.lastStatus;

        try {
            const raw = await apiJson<ApiShip[]>("/api/vessels");
            // Drop the extra risk fields so the React state stays clean.
            ships = raw.map(({ destinationRisk: _r, destinationIncident: _i, ...ship }) => ship);
        } catch (err) {
            this.emitStatus({
                ...this.lastStatus,
                state: "error",
                lastMessage: err instanceof Error ? err.message : String(err),
            });
            return;
        }

        try {
            const s = await apiJson<IngestorStatusPayload>("/api/ingestor/status");
            status = {
                state: s.state,
                msgCount: s.msgCount,
                vesselCount: s.vesselCount,
                lastMessage: s.lastMessage ?? undefined,
            };
        } catch {
            // Status is non-critical; fall back to the last known status with
            // the freshly-counted vessel count from the vessels response.
            status = { ...this.lastStatus, state: "connected", vesselCount: ships.length };
        }

        this.onUpdate(ships);
        this.emitStatus(status);
    }

    private emitStatus(status: AISStatus): void {
        this.lastStatus = status;
        this.onStatus?.(status);
    }
}

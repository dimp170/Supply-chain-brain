// Disruption + Scenario types.
//
// `Disruption` is the CANONICAL AI input shape. The AI agent (Brev) reads
// `vehicle.disruptions: Disruption[]` and reasons over it without caring
// which mode the app is in. SIM / DEMO / LIVE all write to the same field
// in the same shape — the only thing that changes between modes is WHO
// produces the disruptions:
//
//   SIM   — no producers, array stays empty
//   DEMO  — lib/applyScenario.ts injects pre-baked scenario disruptions
//   LIVE  — weather hooks, port-risk consumer, geopolitical scraper, etc.
//           each push their own Disruption objects into the array
//
// Adding a new disruption source = write a producer that pushes the right
// shape. No AI changes, no UI changes (the sidebar renders any Disruption).
//
// The shape here intentionally mirrors what we'd get from real open-source
// intel feeds so when the AI agents land they consume data shaped the same
// way the production pipeline will deliver it:
//
//   - Weather sources mirror NOAA / JMA tropical cyclone bulletins
//     (basin, name, advisory number, sustained winds, projected track).
//   - Geopolitical sources mirror SCA / Suez Canal Authority advisories
//     and government NOTAM-style notices (authority, advisory id, scope).
//   - Congestion sources mirror MarineTraffic / Port Authority status
//     feeds (port name, vessels-at-anchor, average wait days).
//
// All scenarios in `data/scenarios.ts` are SIMULATED — they carry
// `simulated: true` and the UI surfaces this as a visible badge so
// reviewers can see that the disruption is a canned demo event, not a
// real feed. This lets the demo show the same end-to-end flow regardless
// of whether reality cooperates on stage.
//
// Swap point for real feeds: replace the static `vehicleDisruptions` lookup
// in `lib/applyScenario.ts` with a derive-from-feeds pipeline, and set
// `simulated: false` on disruptions that came from real sources. The data
// shape doesn't have to change.

export type DisruptionCategory = "weather" | "geopolitical" | "congestion";
export type DisruptionSeverity = "low" | "medium" | "high" | "critical";

/** Where this disruption notionally came from. The AI demo narrative is
 *  "the agent retrieved this from <source.feed>"; the citation is the
 *  document id (advisory number, bulletin id, port status report id). */
export interface DisruptionSource {
    /** Issuing authority, e.g. "Suez Canal Authority", "NOAA NHC", "JMA",
     *  "Port of Rotterdam Authority", "MarineTraffic". */
    authority: string;
    /** Feed name, e.g. "SCA daily transit bulletin",
     *  "NOAA Tropical Cyclone Advisory", "Port congestion status". */
    feed: string;
    /** Document identifier — advisory number, bulletin id, report id.
     *  Optional because some feeds (e.g. live status pages) don't issue them. */
    citation?: string;
    /** Hypothetical canonical URL of the source document. Optional. */
    url?: string;
}

export interface DisruptionImpact {
    /** Estimated delay in hours caused by the disruption, if known. */
    estimatedDelayHours?: number;
    /** True if the AI agent should propose a reroute. UI doesn't reroute on
     *  its own — this flag tells downstream consumers (Brev agents) that a
     *  reroute is a sensible mitigation. */
    rerouteRequired?: boolean;
    /** Free-form notes (e.g. "alt port: Antwerp", "vessel speed reduced"). */
    notes?: string;
}

export interface Disruption {
    category: DisruptionCategory;
    severity: DisruptionSeverity;
    /** True if this disruption was produced by a canned demo scenario rather
     *  than a real feed. The sidebar shows a visible "SIMULATED" badge when
     *  true so reviewers always know what's real and what's staged. */
    simulated?: boolean;
    /** Short title shown in the sidebar card header. */
    headline: string;
    /** One- or two-sentence explanation suitable for an operator to read at
     *  a glance. Should reference specific facts (storm name, port name,
     *  closure window) so the AI can later quote/expand on it. */
    description: string;
    source: DisruptionSource;
    /** ISO-8601 datetime the disruption began (or first reported). */
    effectiveFrom: string;
    /** ISO-8601 datetime the disruption is expected to clear, if estimable. */
    effectiveUntil?: string;
    /** Geographic context. EXACTLY ONE of these is typically populated:
     *   - location  — point epicenter for weather events
     *   - port      — port name for congestion events
     *   - region    — named region/strait/airspace for geopolitical events */
    location?: [number, number]; // [lng, lat]
    port?: string;
    region?: string;
    impact: DisruptionImpact;
}

export interface Scenario {
    /** Stable kebab-case id used by `vehicleStore.activeScenario`. */
    id: string;
    /** Display name (TopBar / strip button label). */
    name: string;
    /** One-of category for visual color treatment + grouping. */
    category: DisruptionCategory | "compound";
    /** Tooltip / sub-header text. */
    shortDescription: string;
    /** Long-form narrative for the briefing panel when activated.
     *  Should explain the global event in terms an operator (or AI agent)
     *  would reason from. */
    longDescription: string;
    /** Map from Petros vehicle id → disruption applied to that vehicle when
     *  this scenario is active. Vehicles not present in the map are left
     *  untouched. */
    vehicleDisruptions: Record<string, Disruption>;
    /** Geographic risk zones surfaced on the map when this scenario is active
     *  AND the user has toggled the weather overlay on. Example: the Pacific
     *  typhoon scenario contributes a typhoon eye + advisory cone. The
     *  weather pill in the TopBar gates visibility; users opt in. Optional —
     *  scenarios without weather/spatial impact omit this field. */
    riskZones?: import("./weather").RiskZone[];
    /** All scenarios in data/scenarios.ts are simulated (canned demo events).
     *  Default true. Reserved for future real-feed-derived scenarios. */
    simulated?: boolean;
}

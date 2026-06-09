// Apply a scenario to a vehicle list.
//
// Returns a new array where any vehicle whose id appears in the scenario's
// `vehicleDisruptions` map gets that disruption pushed into its
// `disruptions: Disruption[]` array. Vehicles not in the map have any
// SCENARIO-SOURCED disruptions removed (so toggling between scenarios
// leaves no residue) but disruptions from OTHER producers (weather hooks,
// port risk, etc.) are preserved.
//
// A scenario-sourced disruption is identified by its source.feed string
// starting with the scenario's id-derived signature — see SCENARIO_TAG.
// Future producers should tag their own disruptions the same way so the
// applyScenario / clear cycle stays deterministic.
//
// Pure function: no side effects, safe to call inside React effects, useMemo,
// or wherever else.

import type { Vehicle } from "@/types/vehicle";
import type { Disruption } from "@/types/disruption";
import { SCENARIO_BY_ID } from "@/data/scenarios";

/** Marker injected onto every scenario-sourced disruption so we can tell
 *  them apart from disruptions written by other producers (weather, port
 *  risk, AI-suggested events). When applyScenario clears stale state it
 *  ONLY removes disruptions carrying this marker — other producers' work
 *  survives. */
const SCENARIO_TAG = "__scenario_id";

interface TaggedDisruption extends Disruption {
    [SCENARIO_TAG]?: string;
}

function stripScenarioDisruptions(disruptions: Disruption[] | undefined): Disruption[] {
    if (!disruptions || disruptions.length === 0) return [];
    return disruptions.filter((d) => !(SCENARIO_TAG in d));
}

export function applyScenario(vehicles: Vehicle[], scenarioId: string | null): Vehicle[] {
    if (!scenarioId) {
        // No active scenario — strip ONLY scenario-sourced disruptions.
        return vehicles.map((v) => {
            const next = stripScenarioDisruptions(v.disruptions);
            return next.length === (v.disruptions?.length ?? 0)
                ? v
                : { ...v, disruptions: next.length ? next : undefined };
        });
    }
    const scenario = SCENARIO_BY_ID[scenarioId];
    if (!scenario) {
        return vehicles.map((v) => {
            const next = stripScenarioDisruptions(v.disruptions);
            return next.length === (v.disruptions?.length ?? 0)
                ? v
                : { ...v, disruptions: next.length ? next : undefined };
        });
    }
    return vehicles.map((v) => {
        const surviving = stripScenarioDisruptions(v.disruptions);
        const fresh = scenario.vehicleDisruptions[v.id];
        if (fresh) {
            // Propagate scenario.simulated → disruption.simulated so the UI
            // only has to check one place. Tag with SCENARIO_TAG so we can
            // identify and remove this entry cleanly on the next call.
            const tagged: TaggedDisruption = {
                ...fresh,
                simulated:
                    scenario.simulated && fresh.simulated === undefined
                        ? true
                        : fresh.simulated,
                [SCENARIO_TAG]: scenario.id,
            };
            return { ...v, disruptions: [...surviving, tagged] };
        }
        if (surviving.length === (v.disruptions?.length ?? 0)) return v;
        return { ...v, disruptions: surviving.length ? surviving : undefined };
    });
}

// Pre-baked demo scenarios.
//
// Every scenario here is SIMULATED — the disruption events did not happen.
// The data shape mirrors what real open-source feeds would emit (NOAA
// bulletins, port authority status pages, sanctions notices) so the demo
// can show the end-to-end flow consistently regardless of whether reality
// cooperates on stage.
//
// Transparency: every disruption carries `simulated: true` and the sidebar
// surfaces a visible "SIMULATED" badge so reviewers always know they're
// looking at canned data, not a live feed.
//
// The citation strings (e.g. "SCA-2026-114", "JMA-06W-ADV-18") follow the
// shape real authorities use for advisory identifiers — they're illustrative
// stand-ins to demonstrate what a real-source citation would look like in
// the UI. They are not real document ids.
//
// `effectiveFrom` / `effectiveUntil` windows are pinned around 2026-06-04
// so the disruption is always "current" when the demo runs. Bump the dates
// if demoing later.
//
// To add a scenario: define it here and it shows up automatically in the
// ScenarioStrip (components/shell/ScenarioStrip.tsx reads SCENARIOS).

import type { Scenario } from "@/types/disruption";

const SUEZ_CLOSURE: Scenario = {
    id: "suez-closure",
    name: "Suez Canal Closure",
    category: "geopolitical",
    shortDescription: "Northbound transit suspended; Red Sea / Med freight rerouted around Africa or held",
    longDescription:
        "Suez Canal Authority has suspended northbound transit following a vessel grounding " +
        "near km 84. Backlog of 47 vessels at the southern approach (Gulf of Suez). " +
        "Authority estimates 36-48h to restore single-lane traffic. Affects Asia–Europe " +
        "cargo on the canal route; Cape of Good Hope diversion adds ~9 days transit. " +
        "Knock-on congestion expected at Mediterranean transhipment hubs (Algeciras, Tanger) " +
        "and uplift in air cargo / overland Suez–Cairo–Mediterranean transit demand.",
    vehicleDisruptions: {
        // Direct: northbound Suez transit
        "pt-ship-10": {
            category: "geopolitical",
            severity: "critical",
            headline: "Suez northbound transit closed",
            description:
                "PT Suez Express is 2,100 km from Suez with no alternative routing en route. " +
                "Hold at southern approach or divert via Cape of Good Hope (+9 days transit).",
            source: {
                authority: "Suez Canal Authority",
                feed: "SCA daily transit advisory",
                citation: "SCA-2026-114",
                url: "https://www.suezcanal.gov.eg/advisories/SCA-2026-114",
            },
            effectiveFrom: "2026-06-03T08:00:00Z",
            effectiveUntil: "2026-06-05T20:00:00Z",
            region: "Suez Canal (Gulf of Suez approach)",
            impact: {
                estimatedDelayHours: 36,
                rerouteRequired: true,
                notes: "Cape of Good Hope diversion adds ~216 h transit. Suez hold preferred if closure < 48 h.",
            },
        },
        // Indirect: Indian Ocean tanker heading for Gulf, likely held at Bab-el-Mandeb if Suez stays shut
        "pt-ship-08": {
            category: "geopolitical",
            severity: "high",
            headline: "Red Sea staging risk",
            description:
                "PT Indian Star is Dubai-bound but onward Red Sea routing for return leg is exposed " +
                "if Suez closure extends. Pre-position fuel and confirm Dubai bunkering slot.",
            source: {
                authority: "Suez Canal Authority",
                feed: "SCA daily transit advisory",
                citation: "SCA-2026-114",
            },
            effectiveFrom: "2026-06-03T08:00:00Z",
            effectiveUntil: "2026-06-05T20:00:00Z",
            region: "Red Sea / Bab-el-Mandeb",
            impact: {
                estimatedDelayHours: 12,
                rerouteRequired: false,
                notes: "Monitor SCA-2026-114 hourly. Re-evaluate at Hormuz waypoint.",
            },
        },
        // Knock-on: Singapore-bound carrier likely sees Med-side congestion at next leg
        "pt-ship-12": {
            category: "congestion",
            severity: "medium",
            headline: "Algeciras knock-on congestion",
            description:
                "Transhipment hubs west of Suez (Algeciras, Tanger Med) expect vessel surge as " +
                "Asia–Europe traffic diverts. Onward feeder slots from Singapore tightening.",
            source: {
                authority: "MarineTraffic",
                feed: "Port congestion index",
                citation: "MT-CONG-2026-06-04",
            },
            effectiveFrom: "2026-06-04T00:00:00Z",
            region: "Mediterranean transhipment hubs",
            impact: {
                estimatedDelayHours: 24,
                rerouteRequired: false,
                notes: "Book feeder capacity from Singapore early. Watch Algeciras anchorage.",
            },
        },
        // Overland alternative: Egypt textile truck transit gains demand
        "pt-truck-12": {
            category: "geopolitical",
            severity: "medium",
            headline: "Cairo–Istanbul overland demand spike",
            description:
                "Overland Suez–Cairo–Mediterranean routes seeing freight uplift as shippers " +
                "bypass canal closure. Border-crossing wait times at Rafah / Taba elevated.",
            source: {
                authority: "Suez Canal Authority",
                feed: "SCA daily transit advisory",
                citation: "SCA-2026-114",
            },
            effectiveFrom: "2026-06-03T12:00:00Z",
            region: "Egypt – Sinai overland corridor",
            impact: {
                estimatedDelayHours: 8,
                rerouteRequired: false,
                notes: "Border wait times tracked at Rafah crossing. Consider Ismailia alt route.",
            },
        },
        // Air freight uplift: Mumbai → Dubai cargo capacity tightening
        "pt-plane-08": {
            category: "congestion",
            severity: "medium",
            headline: "Air cargo demand surge",
            description:
                "BOM–DXB freight bookings up sharply as time-critical Asia–Europe cargo " +
                "shifts from sea to air. DXB cargo terminal slot allocation under pressure.",
            source: {
                authority: "IATA Cargo iQ",
                feed: "Regional capacity bulletin",
                citation: "CIQ-MEA-2026-23",
            },
            effectiveFrom: "2026-06-03T18:00:00Z",
            region: "Mumbai – Dubai air corridor",
            impact: {
                estimatedDelayHours: 4,
                rerouteRequired: false,
                notes: "DXB ground handling slot at risk. Consider AUH as alternative.",
            },
        },
    },
    simulated: true,
};

const PACIFIC_TYPHOON: Scenario = {
    id: "pacific-typhoon",
    name: "Pacific Typhoon Hina",
    category: "weather",
    shortDescription: "Cat-3 typhoon transiting West Pacific; sustained 95 kt winds, projected track crosses major shipping lanes",
    longDescription:
        "Tropical Cyclone Hina (JMA designation 06W) is currently a Category 3 equivalent " +
        "tropical cyclone in the West Pacific basin, centered near 24.8°N 142.5°E with " +
        "sustained winds of 95 kt and central pressure 945 hPa. JMA forecast track has the " +
        "system tracking NW at 12 kt, recurving northeast in 36 h. Wave heights in the storm " +
        "core exceed 11 m. North Pacific great-circle routes between Asia and the US West Coast " +
        "and trans-Pacific air lanes between East Asia and North America are within the " +
        "advisory cone. Vessels are routing around the southern quadrant; flights expect " +
        "westerly track diversions adding 30–60 minutes flight time.",
    vehicleDisruptions: {
        // Shanghai-bound ship transiting central West Pacific
        "pt-ship-01": {
            category: "weather",
            severity: "high",
            headline: "Typhoon Hina advisory — direct exposure",
            description:
                "PT Pacific Star current position 38°N 175°W is north of advisory cone but " +
                "projected great-circle to Shanghai crosses 36h forecast track. Recommend " +
                "southerly diversion 200 nm south of storm center.",
            source: {
                authority: "JMA",
                feed: "Tropical Cyclone Advisory",
                citation: "JMA-06W-ADV-18",
                url: "https://www.jma.go.jp/bosai/typhoon/2606W",
            },
            effectiveFrom: "2026-06-04T06:00:00Z",
            effectiveUntil: "2026-06-07T18:00:00Z",
            location: [142.5, 24.8],
            impact: {
                estimatedDelayHours: 18,
                rerouteRequired: true,
                notes: "Diversion adds ~400 nm. Fuel sufficient. Re-evaluate at 36h advisory.",
            },
        },
        // Seattle-bound, North Pacific, edge of cone
        "pt-ship-03": {
            category: "weather",
            severity: "medium",
            headline: "Typhoon Hina advisory — periphery",
            description:
                "PT Transpacific 01 is in the northern advisory periphery. Heavy swell expected " +
                "but not direct wind threat. Reduce speed in worst window (T+12 to T+24).",
            source: {
                authority: "JMA",
                feed: "Tropical Cyclone Advisory",
                citation: "JMA-06W-ADV-18",
            },
            effectiveFrom: "2026-06-04T06:00:00Z",
            effectiveUntil: "2026-06-06T12:00:00Z",
            location: [142.5, 24.8],
            impact: {
                estimatedDelayHours: 8,
                rerouteRequired: false,
                notes: "Speed reduction window 12-24 h. Course unchanged.",
            },
        },
        // Japan → LA, southern flank of forecast track
        "pt-ship-25": {
            category: "weather",
            severity: "high",
            headline: "Typhoon Hina advisory — recurve risk",
            description:
                "PT Japan Carrier is on great-circle from Kii Peninsula toward LA. Recurve track " +
                "of Hina at T+36 puts storm center within 250 nm of planned route. Northerly " +
                "diversion recommended.",
            source: {
                authority: "JMA",
                feed: "Tropical Cyclone Advisory",
                citation: "JMA-06W-ADV-18",
            },
            effectiveFrom: "2026-06-04T06:00:00Z",
            effectiveUntil: "2026-06-07T00:00:00Z",
            location: [142.5, 24.8],
            impact: {
                estimatedDelayHours: 24,
                rerouteRequired: true,
                notes: "Reroute via 35°N to clear T+36 advisory cone.",
            },
        },
        // LAX → NRT, Pacific air route
        "pt-plane-03": {
            category: "weather",
            severity: "medium",
            headline: "Pacific track diversion (Hina)",
            description:
                "Flight PTA003 LAX–NRT scheduled great-circle clips the Hina advisory turbulence " +
                "zone north of recurve. ATC routing via northerly waypoints likely.",
            source: {
                authority: "ICAO METAR/SIGMET",
                feed: "Pacific SIGMET WSPA31",
                citation: "WSPA31-2026-1408",
            },
            effectiveFrom: "2026-06-04T12:00:00Z",
            effectiveUntil: "2026-06-05T18:00:00Z",
            location: [142.5, 24.8],
            impact: {
                estimatedDelayHours: 1,
                rerouteRequired: false,
                notes: "ATC re-route adds ~45 min. Fuel reserves adequate.",
            },
        },
        // ICN → LAX, north-Pacific corridor
        "pt-plane-23": {
            category: "weather",
            severity: "medium",
            headline: "North Pacific SIGMET",
            description:
                "Flight PTA023 ICN–LAX is in the northern SIGMET zone associated with Hina's " +
                "outflow band. Expect moderate clear-air turbulence between 32°N and 38°N.",
            source: {
                authority: "ICAO METAR/SIGMET",
                feed: "Pacific SIGMET WSPA31",
                citation: "WSPA31-2026-1408",
            },
            effectiveFrom: "2026-06-04T12:00:00Z",
            effectiveUntil: "2026-06-05T18:00:00Z",
            location: [142.5, 24.8],
            impact: {
                estimatedDelayHours: 0,
                rerouteRequired: false,
                notes: "Cabin secure. Altitude flexibility coordinated with ATC.",
            },
        },
    },
    // Visible geographic zones rendered on the map when the weather overlay
    // is toggled on. The typhoon contributes two concentric circles around
    // its eye — a critical-severity inner core (eyewall + heaviest
    // precipitation) and a wider HIGH-severity advisory cone covering the
    // outer wind bands. RiskZone center is [lat, lng] per types/weather.ts.
    riskZones: [
        {
            id: "typhoon-hina-eye",
            type: "weather_alert",
            severity: "CRITICAL",
            center: [24.8, 142.5],
            radius: 200, // km — eyewall and severe weather core
            affectedVehicles: ["pt-ship-01", "pt-ship-03", "pt-ship-25"],
            description: "Typhoon Hina (06W) — Cat 3 eyewall · 95 kt sustained",
            recommendations: [
                "Avoid 200 km core radius",
                "Vessels divert south of advisory cone",
                "Flights expect westerly track diversions",
            ],
            validFrom: "2026-06-04T06:00:00Z",
            validUntil: "2026-06-07T18:00:00Z",
        },
        {
            id: "typhoon-hina-band",
            type: "weather_alert",
            severity: "HIGH",
            center: [24.8, 142.5],
            radius: 700, // km — outer rain band / 35+ kt wind radius
            affectedVehicles: ["pt-plane-03", "pt-plane-23"],
            description: "Typhoon Hina advisory cone — heavy swell, gusts to 65 kt",
            recommendations: [
                "Speed reduction within advisory zone",
                "Monitor JMA-06W-ADV every 6 h",
            ],
            validFrom: "2026-06-04T06:00:00Z",
            validUntil: "2026-06-07T18:00:00Z",
        },
    ],
    simulated: true,
};

const NORTH_SEA_CONGESTION: Scenario = {
    id: "north-sea-congestion",
    name: "North Sea Port Congestion",
    category: "congestion",
    shortDescription: "Rotterdam + Hamburg at critical backlog; North Sea feeder ports cascading",
    longDescription:
        "Port of Rotterdam (ECT Delta terminal) reports 5.1-day average vessel wait, 31 " +
        "container vessels at anchor (Maasvlakte and approach). Hamburg Burchardkai at 4.6-day " +
        "wait following labor action 2026-06-01 — 02. Cascading effects to Le Havre and Baltic " +
        "feeders. Inland barge and rail capacity tightening; overland EU trucking demand up.",
    vehicleDisruptions: {
        // North Sea feeder destined STOCKHOLM, transits via congested approach
        "pt-ship-15": {
            category: "congestion",
            severity: "high",
            headline: "Baltic feeder delay",
            description:
                "PT North Sea Carrier is Stockholm-bound via North Sea transhipment. Feeder " +
                "departures from Rotterdam/Hamburg delayed; expect 18-24h hold for onward Baltic leg.",
            source: {
                authority: "Port of Rotterdam Authority",
                feed: "Port congestion status",
                citation: "PoR-STATUS-2026-06-04",
                url: "https://www.portofrotterdam.com/en/port-status",
            },
            effectiveFrom: "2026-06-02T00:00:00Z",
            effectiveUntil: "2026-06-08T00:00:00Z",
            port: "Rotterdam",
            impact: {
                estimatedDelayHours: 24,
                rerouteRequired: false,
                notes: "Consider Gothenburg as alternative transhipment to reduce wait.",
            },
        },
        // South Atlantic → Le Havre directly hit
        "pt-ship-20": {
            category: "congestion",
            severity: "critical",
            headline: "Le Havre cascade congestion",
            description:
                "PT South America 02 is Le Havre-bound. Le Havre wait at 3.8 days and rising " +
                "as Rotterdam diverts capacity. Anchorage availability tight.",
            source: {
                authority: "MarineTraffic",
                feed: "Port congestion index",
                citation: "MT-CONG-2026-06-04",
            },
            effectiveFrom: "2026-06-03T00:00:00Z",
            effectiveUntil: "2026-06-08T00:00:00Z",
            port: "Le Havre",
            impact: {
                estimatedDelayHours: 96,
                rerouteRequired: false,
                notes: "Pre-book pilotage. Consider Antwerp diversion if wait exceeds 5 days.",
            },
        },
        // Amsterdam → Frankfurt overland — direct beneficiary of overland demand
        "pt-truck-08": {
            category: "congestion",
            severity: "medium",
            headline: "EU overland transit uplift",
            description:
                "Amsterdam–Frankfurt corridor seeing demand surge as shippers bypass Rotterdam " +
                "marine wait. Border crossings normal; A2 corridor congestion likely on outbound legs.",
            source: {
                authority: "Port of Rotterdam Authority",
                feed: "Port congestion status",
                citation: "PoR-STATUS-2026-06-04",
            },
            effectiveFrom: "2026-06-02T12:00:00Z",
            effectiveUntil: "2026-06-08T00:00:00Z",
            port: "Rotterdam",
            impact: {
                estimatedDelayHours: 6,
                rerouteRequired: false,
                notes: "Driver hours management. Consider A1 corridor for return legs.",
            },
        },
        // Stockholm → Helsinki — Baltic feeder secondary
        "pt-truck-25": {
            category: "congestion",
            severity: "low",
            headline: "Baltic feeder spillover",
            description:
                "Stockholm–Helsinki overland freight nominal. Watch ferry slot availability " +
                "at Tallinn route if North Sea congestion extends past 2026-06-08.",
            source: {
                authority: "Port of Rotterdam Authority",
                feed: "Port congestion status",
                citation: "PoR-STATUS-2026-06-04",
            },
            effectiveFrom: "2026-06-04T00:00:00Z",
            port: "Rotterdam",
            impact: {
                estimatedDelayHours: 2,
                rerouteRequired: false,
            },
        },
        // PEK → AMS — Amsterdam-bound air cargo, congestion-adjacent ground handling
        "pt-plane-06": {
            category: "congestion",
            severity: "medium",
            headline: "AMS cargo ground handling slot risk",
            description:
                "Flight PTA006 PEK–AMS lands into AMS where ground handling slots are saturated " +
                "with sea-to-air diverted cargo. Ramp turn time elevated.",
            source: {
                authority: "Port of Rotterdam Authority",
                feed: "Port congestion status",
                citation: "PoR-STATUS-2026-06-04",
            },
            effectiveFrom: "2026-06-03T00:00:00Z",
            effectiveUntil: "2026-06-08T00:00:00Z",
            port: "Amsterdam Schiphol cargo",
            impact: {
                estimatedDelayHours: 3,
                rerouteRequired: false,
                notes: "Pre-book ramp slot. Consider LGG as alternative cargo gateway.",
            },
        },
    },
    simulated: true,
};

export const SCENARIOS: Scenario[] = [
    SUEZ_CLOSURE,
    PACIFIC_TYPHOON,
    NORTH_SEA_CONGESTION,
];

/** Quick lookup by id — used by `lib/applyScenario.ts`. */
export const SCENARIO_BY_ID: Record<string, Scenario> = Object.fromEntries(
    SCENARIOS.map((s) => [s.id, s]),
);

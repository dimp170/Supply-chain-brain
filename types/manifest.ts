/**
 * Cargo manifest types — what's actually on each Petros ship.
 *
 * The shape mirrors a real maritime cargo manifest minus the named-party
 * fields (shipper / consignee / notify party). Those are required for
 * customs filings but not for the operational-intelligence view this
 * platform serves: we care about WHAT is being moved (commodity, value,
 * hazmat exposure, regulatory class), not WHO to email about it. Skipping
 * names also avoids inventing a pool of fake company names that would
 * either look fake or land too close to real businesses.
 *
 * One CargoManifest per ship. Each manifest holds N CargoShipment entries —
 * one per Bill of Lading. The shipment shape carries common fields plus
 * optional type-specific fields (container ids, tank numbers, hold numbers,
 * RoRo unit counts) — the generator only populates the fields appropriate
 * to the ship's `vesselSubType`.
 *
 * Sources:
 *   - marinepublic.com/blogs/marine-law/977262-cargo-manifest-…
 *   - 19 CFR § 4.7a (US inward manifest requirements)
 *   - CBP "Cargo Vessel Manifest" flyer (May 2024)
 */

/** Vessel sub-type — drives manifest shape AND commodity pool. Container ships
 *  carry TEU-form cargo; tankers carry bulk liquid; bulkers carry bulk dry;
 *  reefers carry temperature-controlled containers; RoRo carries vehicles;
 *  breakbulk carries heterogeneous palletized cargo. The generator branches
 *  on this to pick which optional fields on CargoShipment to populate. */
export type VesselSubType =
    | "container"
    | "tanker"
    | "bulker"
    | "reefer"
    | "roro"
    | "breakbulk";

/** Physical form of a single shipment. Most ships carry one form across all
 *  their shipments (e.g. all containerized on a container ship), but a
 *  breakbulk vessel can mix forms within one voyage. */
export type CargoForm =
    | "containerized"     // standard TEU containers
    | "reefer_containers" // refrigerated TEU containers
    | "bulk_liquid"       // tanker — crude, refined product, LNG, chemical
    | "bulk_dry"          // bulker — ore, coal, grain, fertilizer
    | "vehicle_units"     // RoRo — cars, trucks, heavy equipment
    | "breakbulk";        // palletized / project cargo

export type FreightTerms = "PREPAID" | "COLLECT";

/** Common Incoterms 2020. EXW = Ex Works (buyer takes everything from origin);
 *  FOB = Free On Board (seller covers up to ship loading); CFR = Cost & Freight
 *  (seller covers up to discharge port); CIF = CFR plus insurance; DAP =
 *  Delivered At Place; DDP = Delivered Duty Paid (seller covers everything). */
export type Incoterms = "EXW" | "FOB" | "CFR" | "CIF" | "DAP" | "DDP";

/** Package presentation — what physical unit is being counted by packageCount. */
export type PackagingType =
    | "container"   // TEU container as the package unit
    | "pallet"
    | "case"
    | "drum"
    | "bag"
    | "bulk"        // for tankers/bulkers — packageCount = 1
    | "unit";       // for RoRo — packageCount = unitCount

/** RoRo unit types — the buckets the AI cares about for value/weight
 *  questions. We deliberately don't model brand/model individually. */
export type RoRoUnitType =
    | "passenger_car"
    | "commercial_truck"
    | "heavy_equipment"
    | "agricultural_machinery";

/** Hazmat declaration. UN number + IMDG class are the minimum a manifest
 *  needs for dangerous goods — packing group narrows handling intensity
 *  (I = highest risk). */
export interface HazmatInfo {
    /** UN dangerous-goods number, e.g. "UN1267" for crude petroleum. */
    unNumber: string;
    /** IMDG class string — kept as a string because subclasses use dotted
     *  notation ("2.3" = toxic gas, "5.1" = oxidizer). */
    imdgClass: string;
    /** Packing group I (high), II (medium), III (low). Omitted for classes
     *  that don't use packing groups (e.g. radioactive, infectious). */
    packingGroup?: "I" | "II" | "III";
    /** Regulatory shipping name, e.g. "PETROLEUM CRUDE OIL". */
    properShippingName: string;
}

export interface CargoShipment {
    /** Bill of Lading number — primary shipment identifier. */
    blNumber: string;
    /** Booking reference linked to the shipper's contract. */
    bookingReference: string;
    /** Optional opaque customer id (e.g. "SH-4731") — lets downstream
     *  consumers aggregate by customer without us inventing names. */
    customerCode?: string;

    cargoForm: CargoForm;

    // ── Container-specific (cargoForm: "containerized" | "reefer_containers")
    /** ISO container size/type — "20'STD", "40'STD", "40'HC", "20'REF", "40'REF". */
    containerType?: string;
    containerCount?: number;
    /** Container ID, e.g. "MSCU1234567". */
    containerIds?: string[];
    sealNumbers?: string[];

    // ── Bulk liquid (cargoForm: "bulk_liquid")
    /** Cargo tank designators — "P1" (port 1), "S1" (starboard 1), "C" (centre). */
    tankNumbers?: string[];
    /** Product grade/spec, e.g. "Dubai Crude", "Jet A-1", "Anhydrous Ammonia". */
    productGrade?: string;

    // ── Bulk dry (cargoForm: "bulk_dry")
    /** Cargo hold designators — typically "1" through "5" on bulk carriers. */
    holdNumbers?: string[];

    // ── RoRo (cargoForm: "vehicle_units")
    unitCount?: number;
    unitType?: RoRoUnitType;

    // ── Common across all forms
    /** Free-text commodity description (operator-readable). */
    commodityDescription: string;
    /** Harmonized System code — 6 digits minimum (HS-6), 10 for HTS detail. */
    hsCode: string;
    packageType: PackagingType;
    packageCount: number;
    grossWeightKg: number;
    netWeightKg: number;
    /** Cubic meters of stowage volume. */
    volumeCBM: number;
    declaredValueUSD: number;
    /** ISO 3166-1 alpha-2 country code, e.g. "CN", "AE", "DE". */
    countryOfOrigin: string;

    hazmat?: HazmatInfo;
    /** Setpoint °C for refrigerated cargo. Negative for frozen (-18°C is
     *  the global frozen-food standard). */
    temperature?: number;

    freightTerms: FreightTerms;
    incoterms: Incoterms;
}

export interface CargoManifest {
    /** Manifest identifier — typically "MAN-<carrier>-<year>-<seq>". */
    manifestNumber: string;
    voyageNumber: string;
    /** ISO date the manifest was issued (usually = ETD). */
    issuedAt: string;

    /** Mirror of the parent ship's sub-type — denormalized here so a
     *  manifest extracted from the SQL snapshot doesn't need a JOIN to
     *  the ship row to know what shape to expect. */
    vesselSubType: VesselSubType;

    /** Aggregate stats — denormalized so the UI summary header can render
     *  without walking the shipments array. */
    /** TEU count — container/reefer ships only. */
    totalContainers?: number;
    /** Vehicle count — RoRo only. */
    totalUnits?: number;
    totalGrossWeightKg: number;
    totalVolumeCBM: number;
    totalDeclaredValueUSD: number;
    hazmatPresent: boolean;
    reeferPresent: boolean;

    shipments: CargoShipment[];
}


// ─────────────────────────────────────────────────────────────────────────────
// Truck manifest (CMR consignment note)
//
// Road freight uses the CMR Convention's consignment note as its primary
// document — different shape from a maritime B/L. Pallets (EUR or ISO size)
// are the unit of measure, not containers. Dangerous goods follow ADR
// (Accord européen relatif au transport international des marchandises
// Dangereuses par Route), which adds the tunnel restriction code (B/C/D/E)
// on top of the IMDG-parallel hazard class. Loads are typed as FTL (Full
// Truckload — one shipper fills the trailer) vs LTL (Less than Truckload —
// multiple shippers, sometimes a different consignee each).
// ─────────────────────────────────────────────────────────────────────────────

/** Trailer body type — drives the package mix and what the cab can carry. */
export type TrailerType =
    | "dry_van"        // standard enclosed trailer
    | "refrigerated"   // reefer
    | "curtainside"    // tilt / sliding curtains for side loading
    | "flatbed"        // open deck — heavy/oversized
    | "tanker"         // bulk liquid road tanker
    | "container"      // skeletal trailer for ISO containers
    | "drop_deck";     // step-frame for over-height freight

/** Load factor — FTL means one shipper books the whole trailer (one
 *  consignment); LTL packages multiple shipper consignments onto the same
 *  trailer for economy. */
export type LoadFactor = "FTL" | "LTL";

/** Per-shipment package presentation, road-specific. EUR pallets are the
 *  EU standard 1200×800 mm, ISO is 1200×1000 mm. */
export type RoadPackagingType =
    | "EUR_pallet"
    | "ISO_pallet"
    | "case"
    | "drum"
    | "crate"
    | "bulk";          // for tankers / silo trucks

/** ADR dangerous-goods info. Class string mirrors ADR class numbering
 *  (parallel to IMDG: 1 explosives, 2 gases, 3 flammable liquids, …, 9
 *  miscellaneous). Tunnel code controls which road tunnels the vehicle
 *  may pass through — a real operational concern when planning EU routes. */
export interface AdrInfo {
    unNumber: string;
    adrClass: string;                              // e.g. "3", "8", "6.1"
    packingGroup?: "I" | "II" | "III";
    properShippingName: string;
    /** ADR tunnel category restriction. B = lightest restrictions,
     *  E = most restricted (excluded from many tunnels). */
    tunnelCode?: "B" | "C" | "D" | "E";
}

export interface TruckShipment {
    /** CMR consignment note number — primary shipment identifier. */
    consignmentNumber: string;
    /** Internal booking ref. */
    bookingReference: string;
    customerCode?: string;

    goodsDescription: string;
    hsCode: string;

    packageType: RoadPackagingType;
    packageCount: number;
    grossWeightKg: number;
    netWeightKg: number;
    /** Volume in cubic metres. (Trucks talk m³, not CBM — different from sea.) */
    volumeM3: number;
    declaredValueUSD: number;
    countryOfOrigin: string;

    adr?: AdrInfo;
    /** Reefer setpoint °C when the trailer is refrigerated. */
    temperature?: number;

    freightTerms: FreightTerms;
    /** Incoterms only carry meaning for cross-border road freight; many
     *  domestic shipments don't bother. Optional here. */
    incoterms?: Incoterms;
}

export interface TruckManifest {
    /** CMR master consignment number for the trip. */
    consignmentNumber: string;
    /** Internal trip / route number. */
    tripNumber: string;
    issuedAt: string;

    /** Trailer body — drives package mix and value range. */
    trailerType: TrailerType;
    /** Vehicle registration plate (no driver name per policy). */
    vehicleRegistration: string;
    /** Trailer cargo capacity in m³ (typical 13.6-m curtainside ≈ 90 m³). */
    trailerCapacityM3?: number;
    /** Whole-trailer or shared-load economics. */
    loadFactor: LoadFactor;

    /** Aggregate stats — denormalised. */
    totalPallets?: number;
    totalGrossWeightKg: number;
    totalVolumeM3: number;
    totalDeclaredValueUSD: number;
    hazmatPresent: boolean;
    reeferPresent: boolean;

    shipments: TruckShipment[];
}


// ─────────────────────────────────────────────────────────────────────────────
// Plane manifest (Air Waybill — IATA standards)
//
// Air cargo uses the Air Waybill (AWB), not a B/L. Master AWB is issued by
// the carrier; House AWBs are issued by forwarders for the shippers they
// consolidate. AWB numbers follow IATA format: 3-digit airline prefix +
// 8-digit serial + check digit (e.g. "020-12345678" for Lufthansa Cargo,
// "176-12345678" for Emirates SkyCargo). For Petros Air we use a fictional
// "888" prefix.
//
// Pieces (PCS) replace containers. Cargo bills on CHARGEABLE WEIGHT — the
// higher of actual gross and volumetric weight (L×W×H cm / 6000 for IATA).
// ULDs (Unit Load Devices) are the air-cargo analogue of containers but
// shaped to fit specific aircraft holds: LD3, LD7, PMC, AKE, PAG, etc.
//
// Special Handling Codes (SHC) are 3-letter IATA codes flagging cargo
// that needs operational attention — DGR (dangerous goods), PER
// (perishable), VAL (valuable), AVI (live animals), COL/FRO (chilled/
// frozen), HEA (heavy), VUN (vulnerable).
//
// Dangerous goods follow IATA DGR (Dangerous Goods Regulations) rather
// than IMDG/ADR. Each entry has a packing instruction (e.g. PI 353).
// ─────────────────────────────────────────────────────────────────────────────

/** Common ULD type codes. Maps to airline cargo handling systems —
 *  drives palletisation planning and aircraft hold layout. */
export type UldType =
    | "LD3"     // AKE — 1.5 m³, 1,587 kg max — narrowbody bins
    | "LD7"     // PAG — 4.1 m³, 4,627 kg max — widebody pallet
    | "LD9"     // AAP — 4.9 m³, 4,627 kg max — widebody container
    | "LD11"    // AAU — 7.2 m³, 7,000 kg max — main-deck container
    | "PMC"     // 5.5 m³, 6,800 kg max — main-deck pallet
    | "PAG"     // 4.1 m³ contoured pallet
    | "AKE"     // LD3 container code
    | "loose";  // build-up loose into bulk hold

/** Three-letter IATA Special Handling Codes for ops crew. Picked the
 *  ones that commonly appear on freight; full list runs to ~150 codes. */
export type SpecialHandlingCode =
    | "DGR"   // Dangerous goods
    | "PER"   // Perishable
    | "COL"   // Cool (+2 to +8 °C, pharma)
    | "FRO"   // Frozen
    | "ERT"   // Extreme temp regulated
    | "VAL"   // Valuable
    | "VUN"   // Vulnerable
    | "AVI"   // Live animals
    | "HEA"   // Heavy (per piece > 150 kg)
    | "BIG"   // Outsized
    | "ICE"   // Dry ice in shipment
    | "CAO";  // Cargo aircraft only (can't fly passenger pax)

/** IATA DGR hazard info — air-cargo variant of the maritime IMDG block.
 *  Packing instruction is the IATA-specific shipping rule. */
export interface DgrInfo {
    unNumber: string;
    /** IATA DGR class string — mirrors IMDG numbering. */
    dgrClass: string;
    packingGroup?: "I" | "II" | "III";
    properShippingName: string;
    /** IATA Packing Instruction — operationally critical. PIs like "353"
     *  (flammable liquids, passenger aircraft, max 5 L per package). */
    packingInstruction?: string;
    /** Whether shipment is restricted to cargo aircraft only. */
    cargoAircraftOnly?: boolean;
}

/** Air freight payment basis — replaces sea freight's PREPAID/COLLECT. */
export type AirFreightBasis = "P" | "C" | "X";

export interface AirShipment {
    /** House Air Waybill — assigned by forwarder. */
    houseAwbNumber: string;
    bookingReference: string;
    customerCode?: string;

    goodsDescription: string;
    hsCode: string;

    /** Air cargo unit count — "PCS" in industry parlance. */
    pieces: number;
    grossWeightKg: number;
    /** Chargeable weight (kg). Volumetric formula: L_cm × W_cm × H_cm /
     *  6000. Carriers bill the higher of gross and volumetric. */
    chargeableWeightKg: number;
    volumeM3: number;
    /** ULD type if shipment fills (or is built into) a specific ULD. */
    uldType?: UldType;

    /** Operations flags — drives ground handling priority. */
    specialHandlingCodes: SpecialHandlingCode[];

    declaredValueUSD: number;
    /** For customs purposes the declared value can differ from carriage
     *  value (insurance / liability cap reasons). */
    declaredValueForCustomsUSD: number;
    countryOfOrigin: string;

    dgr?: DgrInfo;
    /** Setpoint °C for temperature-controlled shipments (COL / FRO). */
    temperature?: number;

    /** P=Prepaid (shipper), C=Collect (consignee), X=other arrangement. */
    freightBasis: AirFreightBasis;
}

export interface PlaneManifest {
    /** Master Air Waybill — issued by the operating carrier. Format:
     *  "<3-digit airline prefix>-<8-digit serial>". */
    masterAwbNumber: string;
    /** IATA flight number for this leg (e.g. "PTA001"). */
    flightNumber: string;
    /** Scheduled departure date (ISO). */
    flightDate: string;
    issuedAt: string;

    /** Operating aircraft registration (no crew names per policy). */
    aircraftRegistration?: string;

    /** Aggregate stats — denormalised. */
    totalPieces: number;
    totalGrossWeightKg: number;
    /** Sum of chargeable weights across shipments — what the carrier bills. */
    totalChargeableWeightKg: number;
    totalVolumeM3: number;
    totalDeclaredValueUSD: number;
    /** Total ULD slots committed to this flight's cargo build-up. */
    uldCount?: number;

    /** Status flags — used by handling crew + ground ops at origin / dest. */
    dangerousGoodsOnboard: boolean;
    perishablesOnboard: boolean;
    valuableOnboard: boolean;
    coldChainOnboard: boolean;

    shipments: AirShipment[];
}


// Discriminator — useful for type-aware UI rendering and SQL queries.
export type AnyManifest = CargoManifest | TruckManifest | PlaneManifest;

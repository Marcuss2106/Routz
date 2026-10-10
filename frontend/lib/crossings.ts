/**
 * Known railroad crossings for the Routz hackathon demo.
 *
 * REAL FRA INVENTORY COORDINATES (U.S. DOT Crossing Inventory Form 71,
 * current as of Oct 2026, STATENAME=SOUTH CAROLINA, CITYNAME=COLUMBIA).
 * All entries below are public, at-grade, open crossings operated by
 * Norfolk Southern. DOT IDs let anyone verify them in the FRA inventory.
 *
 * Two demo corridors (both NS, both near downtown Columbia):
 * - "Downtown" corridor: Greene -> Hampton -> Taylor -> Blanding -> Laurel
 *   runs ~NNE (heading ~109 deg-from-east). These five are exactly collinear.
 * - "Assembly" cluster: Main -> Assembly -> Lincoln runs ~SSW (~201 deg).
 *
 * Blockage *predictions* are still simulated estimates (constant-velocity
 * model in lib/trains.ts). Coordinates/road names are real.
 */

export interface Crossing {
  /** Stable id for the app ( == DOT crossing id). */
  id: string;
  /** U.S. DOT Grade Crossing Inventory Number, e.g. "715869J". */
  dotId: string;
  roadName: string;
  latitude: number;
  longitude: number;
  railroad: string;
  /** Optional display label. */
  label?: string;
}

/** Greene -> Laurel, exactly collinear. Northbound heading ≈ 109° from east. */
export const FRA_DOWNTOWN_CORRIDOR: Crossing[] = [
  {
    id: "715869J",
    dotId: "715869J",
    roadName: "Greene St",
    latitude: 33.9996626,
    longitude: -81.0186712,
    railroad: "Norfolk Southern",
    label: "Greene St (DOT 715869J)",
  },
  {
    id: "715871K",
    dotId: "715871K",
    roadName: "Hampton St",
    latitude: 34.0092424,
    longitude: -81.0224989,
    railroad: "Norfolk Southern",
    label: "Hampton St (DOT 715871K)",
  },
  {
    id: "715872S",
    dotId: "715872S",
    roadName: "Taylor St",
    latitude: 34.0105799,
    longitude: -81.0230943,
    railroad: "Norfolk Southern",
    label: "Taylor St (DOT 715872S)",
  },
  {
    id: "715874F",
    dotId: "715874F",
    roadName: "Blanding St",
    latitude: 34.0119064,
    longitude: -81.0236831,
    railroad: "Norfolk Southern",
    label: "Blanding St (DOT 715874F)",
  },
  {
    id: "715875M",
    dotId: "715875M",
    roadName: "Laurel St",
    latitude: 34.0132446,
    longitude: -81.0242793,
    railroad: "Norfolk Southern",
    label: "Laurel St (DOT 715875M)",
  },
];

/** South of downtown. Southbound heading ≈ 201° from east. */
export const FRA_ASSEMBLY_CLUSTER: Crossing[] = [
  {
    id: "715621X",
    dotId: "715621X",
    roadName: "Main St",
    latitude: 33.9905036,
    longitude: -81.028736,
    railroad: "Norfolk Southern",
    label: "Main St (DOT 715621X)",
  },
  {
    id: "715620R",
    dotId: "715620R",
    roadName: "Assembly St",
    latitude: 33.9899741,
    longitude: -81.0304332,
    railroad: "Norfolk Southern",
    label: "Assembly St (DOT 715620R)",
  },
  {
    id: "716365M",
    dotId: "716365M",
    roadName: "Lincoln St",
    latitude: 33.988965,
    longitude: -81.033601,
    railroad: "Norfolk Southern",
    label: "Lincoln St (DOT 716365M)",
  },
];

/** All crossings the demo predicts against. */
export const FRA_CROSSINGS: Crossing[] = [...FRA_DOWNTOWN_CORRIDOR, ...FRA_ASSEMBLY_CLUSTER];

/** Back-compat alias (older code called these simulated). */
export const SIMULATED_CROSSINGS: Crossing[] = FRA_CROSSINGS;

/** Crossing lookup by id (DOT id). */
export function getCrossing(id: string): Crossing | undefined {
  return FRA_CROSSINGS.find((c) => c.id === id);
}

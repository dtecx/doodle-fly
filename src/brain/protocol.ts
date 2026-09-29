// Messages between the main thread and the brain worker, plus the neuron groups the game talks to.

/** Descending neurons that the connectome routes from the ipsilateral LC10a (found with scripts/survey.ts). */
export const STEER_TYPES = ["DNa02", "DNa01", "DNae002", "DNg111", "DNb01", "DNge043"] as const;

/** Groups whose spikes are counted every frame. `<type>_L/_R` keys are resolved from cell type + side. */
export const TRACKED = [
  "LC10a_L",
  "LC10a_R",
  "LPLC2_L",
  "LPLC2_R",
  "LC4_L",
  "LC4_R",
  "AOTU019_L",
  "AOTU019_R",
  "AOTU025_L",
  "AOTU025_R",
  ...STEER_TYPES.flatMap((t) => [`${t}_L`, `${t}_R`]),
  "DNp01_L",
  "DNp01_R",
  "sugar_GRN_L",
  "sugar_GRN_R",
  "proboscis_MN",
] as const;
export type TrackedKey = (typeof TRACKED)[number];

/** Poisson drive (Hz) for the sensory populations. */
export interface SensoryInput {
  lc10L: number;
  lc10R: number;
  loom: number;
  sugar: number;
}

export interface Calibration {
  /** steering-population spikes/s for LC10a at `hz` on one side */
  respL: number;
  respR: number;
  hz: number;
  gainL: number;
  gainR: number;
  /** calibrated population rate that means "full turn" */
  ref: number;
}

export interface ReadyInfo {
  dataset: string;
  neurons: number;
  connections: number;
  synapses: number;
  dt: number;
  params: Record<string, number>;
  types: string[];
  superclasses: string[];
  typeIdx: Uint16Array;
  superclass: Uint8Array;
  side: Uint8Array;
  soma: Float32Array;
  anchor: Float32Array;
  groups: Record<TrackedKey, Int32Array>;
  calibration: Calibration;
  loadMs: number;
}

export interface FrameResult {
  id: number;
  simMs: number;
  frameMs: number;
  wallMs: number;
  /** neuron index of every spike in this frame */
  spikes: Int32Array;
  /** ms since frame start of every spike */
  spikeT: Float32Array;
  /** spikes per TRACKED group in this frame */
  counts: Int32Array;
  active: number;
  totalSpikes: number;
  resets: number;
}

export type ToWorker =
  | { type: "init"; base: string }
  | { type: "step"; id: number; ms: number; input: SensoryInput };

export type FromWorker =
  | { type: "progress"; stage: string; frac: number }
  | { type: "ready"; info: ReadyInfo }
  | { type: "frame"; frame: FrameResult }
  | { type: "error"; message: string };

// The two hand-made interfaces between game and brain. Everything in between is the connectome.
import type { Calibration, SensoryInput } from "./brain/protocol.ts";
import { PLATFORM_W } from "./game/game.ts";

export const LC10_MIN_HZ = 14;
export const LC10_MAX_HZ = 80;
const DEAD_ZONE = PLATFORM_W * 0.16;
const FULL_OFFSET = 170;

/**
 * Eyes: the target platform's horizontal offset becomes Poisson drive of the LC10a population on
 * that side (small-object detectors, one population per eye). Straight ahead drives nothing.
 */
export function encodeTarget(dx: number | null): { lc10L: number; lc10R: number } {
  if (dx === null) return { lc10L: 0, lc10R: 0 };
  const a = Math.abs(dx);
  if (a < DEAD_ZONE) return { lc10L: 0, lc10R: 0 };
  const s = Math.min(1, (a - DEAD_ZONE) / FULL_OFFSET);
  const hz = LC10_MIN_HZ + (LC10_MAX_HZ - LC10_MIN_HZ) * Math.sqrt(s);
  return dx < 0 ? { lc10L: hz, lc10R: 0 } : { lc10L: 0, lc10R: hz };
}

export function makeInput(
  dx: number | null,
  opts: { swapEyes: boolean; blind: boolean; loom: number; sugar: number },
): SensoryInput {
  let { lc10L, lc10R } = encodeTarget(dx);
  if (opts.blind) lc10L = lc10R = 0;
  if (opts.swapEyes) [lc10L, lc10R] = [lc10R, lc10L];
  return { lc10L, lc10R, loom: opts.loom, sugar: opts.sugar };
}

/**
 * Buttons: smoothed spike rates of the left and right steering populations (DNa02, DNa01, DNae002,
 * DNg111, DNb01, DNge043), balanced by the start-up calibration. steer < 0 = left, > 0 = right.
 */
export class SteeringDecoder {
  rateL = 0;
  rateR = 0;
  steer = 0;
  private readonly tau: number;

  constructor(tauMs = 55) {
    this.tau = tauMs;
  }

  update(spikesL: number, spikesR: number, frameMs: number, cal: Calibration): number {
    const k = 1 - Math.exp(-frameMs / this.tau);
    this.rateL += ((spikesL * 1000) / frameMs - this.rateL) * k;
    this.rateR += ((spikesR * 1000) / frameMs - this.rateR) * k;
    this.steer = (cal.gainR * this.rateR - cal.gainL * this.rateL) / (cal.ref * 0.75);
    return this.steer;
  }

  reset(): void {
    this.rateL = this.rateR = this.steer = 0;
  }
}

/** Slow leaky average for display (Hz). */
export class RateMeter {
  value = 0;
  private readonly tau: number;
  constructor(tauMs = 120) {
    this.tau = tauMs;
  }
  update(spikes: number, neurons: number, frameMs: number): number {
    const k = 1 - Math.exp(-frameMs / this.tau);
    const hz = (spikes * 1000) / frameMs / Math.max(1, neurons);
    this.value += (hz - this.value) * k;
    return this.value;
  }
}

// Whole-brain leaky integrate-and-fire model of Shiu et al. 2024 (Nature 634, 210-219):
//   dv/dt = (v_rest - v + g) / tau_m      (unless refractory)
//   dg/dt = -g / tau_s                    (unless refractory)
//   spike when v > v_th  ->  v = v_reset, g = 0, refractory for t_ref
//   each presynaptic spike adds (signed synapse count * w_syn) to g after t_delay
//   stimulated neurons get Poisson kicks of w_syn * f_poi straight into v (and no refractory period)
//
// Integration is exact for the linear system (like Brian2's `method='linear'`).
//
// Speed: between inputs a neuron's trajectory is known in closed form, so most neurons are updated
// lazily - only when a synaptic event reaches them. A neuron is stepped every dt ("hot") only while
// its current (u, g) could still carry it over threshold, while refractory, or while it gets Poisson
// drive. The result is the same as stepping all 138k neurons, at a fraction of the cost.

import type { BrainGraph } from "./data.ts";

export interface LIFParams {
  /** ms */
  dt: number;
  vRest: number;
  vReset: number;
  vThresh: number;
  tauM: number;
  tauS: number;
  tRef: number;
  tDelay: number;
  /** mV per synapse */
  wSyn: number;
  /** mV per Poisson event (w_syn * f_poi) */
  poissonWeight: number;
  /** threshold increase per spike, mV (0 = off, as in the paper) */
  adaptInc: number;
  /** ms */
  adaptTau: number;
}

export const SHIU_PARAMS: LIFParams = {
  dt: 0.1,
  vRest: -52,
  vReset: -52,
  vThresh: -45,
  tauM: 20,
  tauS: 5,
  tRef: 2.2,
  tDelay: 1.8,
  wSyn: 0.275,
  poissonWeight: 0.275 * 250,
  adaptInc: 0,
  adaptTau: 200,
};

/** after this many steps without input a neuron has relaxed to rest (e^-lag*dt/tau_m ~ 0) */
const MAX_LAG = 1 << 14;

export class LIFEngine {
  readonly n: number;
  readonly params: LIFParams;
  readonly delaySteps: number;
  readonly indptr: Uint32Array;
  readonly post: Int32Array;
  /** mV added to g per presynaptic spike */
  readonly w: Float32Array;

  // state relative to rest; for lazy neurons valid at the start of step `last[i]`
  readonly u: Float32Array;
  readonly g: Float32Array;
  readonly theta: Float32Array;
  readonly last: Int32Array;
  readonly refr: Uint16Array;
  /** Poisson drive, Hz */
  readonly rate: Float32Array;

  private readonly hot: Uint8Array;
  private readonly active: Int32Array;
  private nActive = 0;
  private stim: number[] = [];
  private readonly stimSet = new Set<number>();

  private readonly slots: Int32Array[];
  private readonly slotLen: Int32Array;

  /** spikes emitted since the last `drainSpikes`/`takeSpikes`, with the step they happened in */
  spikes = new Int32Array(1 << 16);
  spikeSteps = new Int32Array(1 << 16);
  nSpikes = 0;
  /** per-neuron group id for fast readout counts (-1 = none) */
  readonly groupOf: Int16Array;
  groupCounts: Int32Array = new Int32Array(0);

  step = 0;
  totalSpikes = 0;
  private rng: number;

  // exact-integration coefficients
  private a = 0;
  private b = 0;
  private c = 0;
  private K = 0;
  private peakF = 0;
  private invRate = 0;
  private uTh = 0;
  private uReset = 0;
  private refSteps = 0;
  private adaptDecay = 1;
  private aPow = new Float64Array(0);
  private bPow = new Float64Array(0);
  private cPow = new Float64Array(0);

  constructor(graph: BrainGraph, params: LIFParams = SHIU_PARAMS, seed = 1) {
    this.n = graph.n;
    this.params = { ...params };
    this.indptr = graph.indptr;
    this.post = graph.post;
    this.w = new Float32Array(graph.syn.length);
    this.setWeights(graph.syn);
    const n = this.n;
    this.u = new Float32Array(n);
    this.g = new Float32Array(n);
    this.theta = new Float32Array(n);
    this.last = new Int32Array(n);
    this.refr = new Uint16Array(n);
    this.rate = new Float32Array(n);
    this.hot = new Uint8Array(n);
    this.active = new Int32Array(n);
    this.groupOf = new Int16Array(n).fill(-1);
    this.delaySteps = Math.max(1, Math.round(params.tDelay / params.dt));
    this.slots = Array.from({ length: this.delaySteps }, () => new Int32Array(1024));
    this.slotLen = new Int32Array(this.delaySteps);
    this.rng = seed >>> 0 || 1;
    this.updateCoefficients();
  }

  /** Signed synapse counts -> mV. `scale[j]` multiplies every outgoing connection of neuron j. */
  setWeights(syn: Int16Array, scale?: Float32Array): void {
    const { w, indptr } = this;
    const ws = this.params.wSyn;
    for (let j = 0; j < this.n; j++) {
      const s = scale ? scale[j] * ws : ws;
      for (let k = indptr[j], end = indptr[j + 1]; k < end; k++) w[k] = syn[k] * s;
    }
  }

  /** dt and tDelay are fixed at construction; everything else can change. */
  setParams(p: Partial<Omit<LIFParams, "dt" | "tDelay">>): void {
    this.settle();
    Object.assign(this.params, p);
    this.updateCoefficients();
  }

  private updateCoefficients(): void {
    const p = this.params;
    this.a = Math.exp(-p.dt / p.tauM);
    this.b = Math.exp(-p.dt / p.tauS);
    this.K = p.tauS / (p.tauS - p.tauM);
    this.c = this.K * (this.b - this.a);
    this.peakF = 1 - p.tauS / p.tauM;
    this.invRate = 1 / (1 / p.tauS - 1 / p.tauM);
    this.uTh = p.vThresh - p.vRest;
    this.uReset = p.vReset - p.vRest;
    this.refSteps = Math.round(p.tRef / p.dt);
    this.adaptDecay = Math.exp(-p.dt / p.adaptTau);
    const len = Math.min(MAX_LAG, Math.ceil((30 * p.tauM) / p.dt));
    this.aPow = new Float64Array(len);
    this.bPow = new Float64Array(len);
    this.cPow = new Float64Array(len);
    for (let k = 0; k < len; k++) {
      this.aPow[k] = Math.exp((-k * p.dt) / p.tauM);
      this.bPow[k] = Math.exp((-k * p.dt) / p.tauS);
      this.cPow[k] = this.K * (this.bPow[k] - this.aPow[k]);
    }
  }

  defineGroups(groups: ArrayLike<number>[]): void {
    this.groupOf.fill(-1);
    groups.forEach((ids, gi) => {
      for (let k = 0; k < ids.length; k++) this.groupOf[ids[k]] = gi;
    });
    this.groupCounts = new Int32Array(groups.length);
  }

  /** Poisson drive in Hz for each neuron in `ids`. */
  setRate(ids: ArrayLike<number>, hz: number): void {
    let changed = false;
    for (let k = 0; k < ids.length; k++) {
      const i = ids[k];
      this.rate[i] = hz;
      if (hz > 0) {
        this.makeHot(i);
        if (!this.stimSet.has(i)) {
          this.stimSet.add(i);
          changed = true;
        }
      } else if (this.stimSet.delete(i)) {
        changed = true;
      }
    }
    if (changed) this.stim = [...this.stimSet];
  }

  /** neurons currently integrated every step */
  get activeCount(): number {
    return this.nActive;
  }

  get timeMs(): number {
    return this.step * this.params.dt;
  }

  /** Membrane potential in mV (absolute), without disturbing lazy state. */
  potential(i: number): number {
    let ui = this.u[i];
    if (!this.hot[i]) {
      const lag = this.step - this.last[i];
      if (lag >= this.aPow.length) ui = 0;
      else if (lag > 0) ui = this.aPow[lag] * ui + this.cPow[lag] * this.g[i];
    }
    return ui + this.params.vRest;
  }

  reset(): void {
    this.u.fill(0);
    this.g.fill(0);
    this.theta.fill(0);
    this.refr.fill(0);
    this.hot.fill(0);
    this.last.fill(this.step);
    this.nActive = 0;
    this.slotLen.fill(0);
    for (const i of this.stimSet) this.makeHot(i);
  }

  drainSpikes(): Int32Array {
    const out = this.spikes.slice(0, this.nSpikes);
    this.nSpikes = 0;
    return out;
  }

  takeSpikes(): { ids: Int32Array; steps: Int32Array } {
    const ids = this.spikes.slice(0, this.nSpikes);
    const steps = this.spikeSteps.slice(0, this.nSpikes);
    this.nSpikes = 0;
    return { ids, steps };
  }

  /** bring a lazy neuron up to the current step and mark it hot */
  private makeHot(i: number): void {
    if (this.hot[i]) return;
    this.catchUp(i, this.step);
    this.hot[i] = 1;
    this.active[this.nActive++] = i;
  }

  private catchUp(i: number, t: number): void {
    const lag = t - this.last[i];
    if (lag <= 0) return;
    if (lag >= this.aPow.length) {
      this.u[i] = 0;
      this.g[i] = 0;
    } else {
      const ui = this.u[i];
      const gi = this.g[i];
      this.u[i] = this.aPow[lag] * ui + this.cPow[lag] * gi;
      this.g[i] = this.bPow[lag] * gi;
    }
    if (this.theta[i] !== 0) this.theta[i] *= Math.pow(this.adaptDecay, lag);
    this.last[i] = t;
  }

  /** settle all lazy neurons to the current step (needed before changing coefficients) */
  private settle(): void {
    for (let i = 0; i < this.n; i++) if (!this.hot[i]) this.catchUp(i, this.step);
  }

  private random(): number {
    let x = this.rng; // xorshift32
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng = x >>> 0;
    return this.rng / 4294967296;
  }

  /** Advance the simulation by `steps` time steps. */
  run(steps: number): void {
    const { indptr, post, w, u, g, theta, last, refr, rate, hot, active, slots, slotLen, groupOf } = this;
    const { a, b, c, K, peakF, invRate, uTh, uReset, refSteps, adaptDecay, aPow, bPow, cPow } = this;
    const tauM = this.params.tauM;
    const adaptInc = this.params.adaptInc;
    const pw = this.params.poissonWeight;
    const dtS = this.params.dt / 1000;
    const D = this.delaySteps;
    const maxLag = aPow.length;
    const groupCounts = this.groupCounts;
    const stim = this.stim;

    // could (u, g) cross threshold without further input? (closed-form peak of the PSP)
    const canFire = (ui: number, gi: number): boolean => {
      if (gi <= ui) return false; // du/dt <= 0 and stays so: max is u itself (< threshold)
      const A = ui - K * gi;
      if (peakF * A <= uTh) return false; // cheap upper bound on the peak
      const tStar = Math.log((-K * gi * tauM) / (A * (tauM * (1 - peakF)))) * invRate;
      return A * peakF * Math.exp(-tStar / tauM) > uTh;
    };

    for (let s = 0; s < steps; s++) {
      const t = this.step;
      const slot = t % D;
      let nActive = this.nActive;

      // 1. synaptic events from spikes emitted D steps ago
      const q = slots[slot];
      const ql = slotLen[slot];
      for (let k = 0; k < ql; k++) {
        const j = q[k];
        for (let e = indptr[j], end = indptr[j + 1]; e < end; e++) {
          const p = post[e];
          if (hot[p] === 1) {
            g[p] += w[e];
            continue;
          }
          let up = u[p];
          let gp = g[p];
          const lag = t - last[p];
          if (lag > 0) {
            if (lag >= maxLag) {
              up = 0;
              gp = 0;
            } else if (up !== 0 || gp !== 0) {
              const un = aPow[lag] * up + cPow[lag] * gp;
              gp = bPow[lag] * gp;
              up = un;
            }
            if (theta[p] !== 0) theta[p] *= Math.pow(adaptDecay, lag);
            last[p] = t;
            u[p] = up;
          }
          gp += w[e];
          g[p] = gp;
          if (canFire(up, gp)) {
            hot[p] = 1;
            active[nActive++] = p;
          }
        }
      }

      // 2. Poisson drive
      for (let k = 0; k < stim.length; k++) {
        const i = stim[k];
        if (this.random() < rate[i] * dtS) u[i] += pw;
      }

      // 3. integrate, threshold, reset the hot set
      let qs = q;
      let out = 0;
      let k = 0;
      while (k < nActive) {
        const i = active[k];
        let ui = u[i];
        let gi = g[i];
        let th = theta[i];
        if (refr[i] > 0) {
          refr[i]--;
        } else {
          const un = a * ui + c * gi;
          gi *= b;
          ui = un;
          if (ui > uTh + th) {
            ui = uReset;
            gi = 0;
            th += adaptInc;
            refr[i] = rate[i] > 0 ? 0 : refSteps;
            if (out === qs.length) {
              const grown = new Int32Array(qs.length * 2);
              grown.set(qs);
              slots[slot] = qs = grown;
            }
            qs[out++] = i;
            if (this.nSpikes === this.spikes.length) {
              const grown = new Int32Array(this.spikes.length * 2);
              grown.set(this.spikes);
              this.spikes = grown;
              const grownSteps = new Int32Array(this.spikes.length);
              grownSteps.set(this.spikeSteps);
              this.spikeSteps = grownSteps;
            }
            this.spikeSteps[this.nSpikes] = t;
            this.spikes[this.nSpikes++] = i;
            const gid = groupOf[i];
            if (gid >= 0) groupCounts[gid]++;
          }
        }
        if (th !== 0) th *= adaptDecay;
        u[i] = ui;
        g[i] = gi;
        theta[i] = th;
        if (refr[i] === 0 && rate[i] === 0 && !canFire(ui, gi)) {
          // cool down: continue lazily from the start of the next step
          hot[i] = 0;
          last[i] = t + 1;
          active[k] = active[--nActive];
          continue;
        }
        k++;
      }
      slotLen[slot] = out;
      this.totalSpikes += out;
      this.nActive = nActive;
      this.step++;
    }
  }
}

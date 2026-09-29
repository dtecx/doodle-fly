// Runs the whole-brain model off the main thread.
import { gunzip, parseGraph, parseNeurons, SIDE_LEFT, SIDE_RIGHT, type BrainMeta } from "./data.ts";
import { LIFEngine, SHIU_PARAMS } from "./engine.ts";
import {
  STEER_TYPES,
  TRACKED,
  type Calibration,
  type FromWorker,
  type SensoryInput,
  type ToWorker,
  type TrackedKey,
} from "./protocol.ts";

interface WorkerScope {
  postMessage(msg: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
}
const scope = self as unknown as WorkerScope;
const post = (msg: FromWorker, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);

/** a frame whose brain-wide spike rate exceeds this is treated as a runaway and the state is reset */
const RUNAWAY_HZ = 250_000;

let engine: LIFEngine | null = null;
let groups: Record<TrackedKey, Int32Array>;
let steerL: number[] = [];
let steerR: number[] = [];
let lastInput: SensoryInput = { lc10L: 0, lc10R: 0, loom: 0, sugar: 0 };
let runaway = 0;
let resets = 0;

async function fetchBuffer(url: string, stage: string, from: number, to: number): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total) post({ type: "progress", stage, frac: from + ((to - from) * got) / total });
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out.buffer;
}

function setInput(input: SensoryInput): void {
  const e = engine!;
  if (input.lc10L !== lastInput.lc10L) e.setRate(groups.LC10a_L, input.lc10L);
  if (input.lc10R !== lastInput.lc10R) e.setRate(groups.LC10a_R, input.lc10R);
  if (input.loom !== lastInput.loom)
    for (const k of ["LPLC2_L", "LPLC2_R", "LC4_L", "LC4_R"] as const) e.setRate(groups[k], input.loom);
  if (input.sugar !== lastInput.sugar) {
    e.setRate(groups.sugar_GRN_L, input.sugar);
    e.setRate(groups.sugar_GRN_R, input.sugar);
  }
  lastInput = { ...input };
}

function steerCounts(counts: Int32Array): [number, number] {
  let l = 0;
  let r = 0;
  for (const gi of steerL) l += counts[gi];
  for (const gi of steerR) r += counts[gi];
  return [l, r];
}

/** Stimulate LC10a on each side once and measure how strongly each steering population answers. */
function calibrate(hz = 50, ms = 600): Calibration {
  const e = engine!;
  const measure = (side: "L" | "R") => {
    e.reset();
    setInput({ lc10L: side === "L" ? hz : 0, lc10R: side === "R" ? hz : 0, loom: 0, sugar: 0 });
    e.groupCounts.fill(0);
    e.run(Math.round(ms / e.params.dt));
    const [l, r] = steerCounts(e.groupCounts);
    setInput({ lc10L: 0, lc10R: 0, loom: 0, sugar: 0 });
    e.run(Math.round(300 / e.params.dt));
    e.takeSpikes();
    return (side === "L" ? l : r) / (ms / 1000);
  };
  const respL = measure("L");
  const respR = measure("R");
  e.reset();
  e.groupCounts.fill(0);
  const ref = (respL + respR) / 2;
  return { respL, respR, hz, gainL: ref / Math.max(1, respL), gainR: ref / Math.max(1, respR), ref };
}

async function init(base: string): Promise<void> {
  const t0 = performance.now();
  post({ type: "progress", stage: "Loading the neuron list", frac: 0.01 });
  const meta = (await (await fetch(`${base}data/brain/meta.json`)).json()) as BrainMeta;
  const graphBuf = await fetchBuffer(`${base}data/brain/graph.bin.gz`, "Downloading the connectome", 0.02, 0.7);
  const neuronBuf = await fetchBuffer(`${base}data/brain/neurons.bin.gz`, "Downloading neuron anatomy", 0.7, 0.78);
  post({ type: "progress", stage: "Unpacking 15 million connections", frac: 0.8 });
  const graph = parseGraph(await gunzip(graphBuf), meta);
  const info = parseNeurons(await gunzip(neuronBuf), meta.neurons);

  post({ type: "progress", stage: "Building the brain model", frac: 0.9 });
  engine = new LIFEngine(graph, SHIU_PARAMS, 20240912);

  const byTypeSide = (type: string, side: number) => {
    const ti = meta.types.indexOf(type);
    const out: number[] = [];
    for (let i = 0; i < meta.neurons; i++) if (info.type[i] === ti && info.side[i] === side) out.push(i);
    return Int32Array.from(out);
  };
  groups = {} as Record<TrackedKey, Int32Array>;
  for (const key of TRACKED) {
    if (meta.groups[key]) groups[key] = Int32Array.from(meta.groups[key]);
    else {
      const m = /^(.*)_([LR])$/.exec(key)!;
      groups[key] = byTypeSide(m[1], m[2] === "L" ? SIDE_LEFT : SIDE_RIGHT);
    }
  }
  engine.defineGroups(TRACKED.map((k) => groups[k]));
  steerL = STEER_TYPES.map((t) => TRACKED.indexOf(`${t}_L`));
  steerR = STEER_TYPES.map((t) => TRACKED.indexOf(`${t}_R`));

  post({ type: "progress", stage: "Calibrating the steering neurons", frac: 0.95 });
  const calibration = calibrate();

  const p = engine.params;
  post(
    {
      type: "ready",
      info: {
        dataset: meta.dataset,
        neurons: meta.neurons,
        connections: meta.connections,
        synapses: meta.synapses,
        dt: p.dt,
        params: { ...p },
        types: meta.types,
        superclasses: meta.superclasses,
        typeIdx: info.type,
        superclass: info.superclass,
        side: info.side,
        soma: info.soma,
        anchor: info.anchor,
        groups,
        calibration,
        loadMs: performance.now() - t0,
      },
    },
    [info.soma.buffer, info.anchor.buffer],
  );
}

function step(id: number, ms: number, input: SensoryInput): void {
  const e = engine!;
  const t0 = performance.now();
  setInput(input);
  e.groupCounts.fill(0);
  const startStep = e.step;
  e.run(Math.round(ms / e.params.dt));
  const { ids, steps } = e.takeSpikes();
  const spikeT = new Float32Array(steps.length);
  for (let k = 0; k < steps.length; k++) spikeT[k] = (steps[k] - startStep) * e.params.dt;

  // runaway guard (never observed with the published parameters, but cheap insurance)
  if (ids.length / (ms / 1000) > RUNAWAY_HZ) {
    if (++runaway >= 5) {
      e.reset();
      runaway = 0;
      resets++;
    }
  } else runaway = 0;

  const counts = e.groupCounts.slice();
  post(
    {
      type: "frame",
      frame: {
        id,
        simMs: e.timeMs,
        frameMs: ms,
        wallMs: performance.now() - t0,
        spikes: ids,
        spikeT,
        counts,
        active: e.activeCount,
        totalSpikes: e.totalSpikes,
        resets,
      },
    },
    [ids.buffer, spikeT.buffer, counts.buffer],
  );
}

scope.onmessage = (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === "init") void init(msg.base).catch((err) => post({ type: "error", message: String(err?.stack ?? err) }));
    else if (msg.type === "step") step(msg.id, msg.ms, msg.input);
  } catch (err) {
    post({ type: "error", message: String((err as Error)?.stack ?? err) });
  }
};

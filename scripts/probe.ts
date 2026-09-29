// Headless experiments on the whole-brain model (runs in node inside the tools container):
//   docker compose run --rm tools node scripts/probe.ts [--dt 0.1] [--adapt 0] [--mod on|off]
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseGraph, parseNeurons, type BrainMeta } from "../src/brain/data.ts";
import { LIFEngine, SHIU_PARAMS } from "../src/brain/engine.ts";

const DIR = new URL("../public/data/brain/", import.meta.url);
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const dt = Number(arg("dt", "0.1"));
const adapt = Number(arg("adapt", "0"));
const mod = arg("mod", "on");
const only = arg("only", "");

const toAB = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
let t0 = performance.now();
const meta = JSON.parse(readFileSync(new URL("meta.json", DIR), "utf8")) as BrainMeta;
const graph = parseGraph(toAB(gunzipSync(readFileSync(new URL("graph.bin.gz", DIR)))), meta);
const info = parseNeurons(toAB(gunzipSync(readFileSync(new URL("neurons.bin.gz", DIR)))), meta.neurons);
console.log(`loaded ${meta.neurons} neurons / ${meta.connections} connections in ${(performance.now() - t0).toFixed(0)} ms`);

// sign vs presynaptic transmitter
{
  const tally = new Map<string, [number, number]>();
  for (let j = 0; j < graph.n; j++) {
    const nt = meta.nts[info.nt[j]];
    const t = tally.get(nt) ?? [0, 0];
    for (let k = graph.indptr[j]; k < graph.indptr[j + 1]; k++) t[graph.syn[k] > 0 ? 0 : 1] += Math.abs(graph.syn[k]);
    tally.set(nt, t);
  }
  console.log("synapses by presynaptic NT [excitatory, inhibitory]:", Object.fromEntries(tally));
}

const engine = new LIFEngine(graph, { ...SHIU_PARAMS, dt, adaptInc: adapt }, 7);
if (mod === "off") {
  const scale = new Float32Array(graph.n);
  for (let j = 0; j < graph.n; j++) scale[j] = info.nt[j] >= 4 ? 0 : 1; // dopamine, serotonin, octopamine
  engine.setWeights(graph.syn, scale);
}

const G = meta.groups;
const names = Object.keys(G);
engine.defineGroups(names.map((k) => G[k]));

function run(label: string, ms: number, stim: Record<string, number>) {
  for (const k of names) engine.setRate(G[k], 0);
  for (const [k, hz] of Object.entries(stim)) engine.setRate(G[k], hz);
  engine.groupCounts.fill(0);
  engine.drainSpikes();
  const spikes0 = engine.totalSpikes;
  const steps = Math.round(ms / dt);
  let maxActive = 0;
  const wall0 = performance.now();
  const chunk = Math.max(1, Math.round(10 / dt));
  const perType = new Map<number, number>();
  for (let s = 0; s < steps; s += chunk) {
    engine.run(Math.min(chunk, steps - s));
    maxActive = Math.max(maxActive, engine.activeCount);
    const sp = engine.drainSpikes();
    for (const i of sp) perType.set(info.type[i], (perType.get(info.type[i]) ?? 0) + 1);
  }
  const wall = performance.now() - wall0;
  const sec = ms / 1000;
  const rates = names
    .map((k, gi) => [k, engine.groupCounts[gi] / G[k].length / sec] as const)
    .filter(([, r]) => r > 0)
    .map(([k, r]) => `${k}=${r.toFixed(1)}`)
    .join(" ");
  const top = [...perType.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 12)
    .map(([t, c]) => `${meta.types[t] || "?"}:${c}`)
    .join(" ");
  console.log(
    `\n[${label}] ${ms}ms  wall ${wall.toFixed(0)}ms (${(ms / wall).toFixed(2)}x realtime)  spikes/s ${((engine.totalSpikes - spikes0) / sec).toFixed(0)}  maxActive ${maxActive}`,
  );
  console.log(`  rates(Hz/neuron): ${rates || "-"}`);
  console.log(`  top types by spikes: ${top}`);
}

const exps: [string, number, Record<string, number>][] = [
  ["baseline", 300, {}],
  ["LC10a_L 150Hz", 1000, { LC10a_L: 150 }],
  ["after", 500, {}],
  ["LC10a_R 150Hz", 1000, { LC10a_R: 150 }],
  ["after", 500, {}],
  ["LC10a_L 50Hz", 1000, { LC10a_L: 50 }],
  ["LC10a_R 50Hz", 1000, { LC10a_R: 50 }],
  ["LC10a_L 20Hz", 1000, { LC10a_L: 20 }],
  ["after", 500, {}],
  ["sugar both 150Hz", 1000, { sugar_GRN_L: 150, sugar_GRN_R: 150 }],
  ["after", 500, {}],
  ["looming both 150Hz", 1000, { LPLC2_L: 150, LPLC2_R: 150, LC4_L: 150, LC4_R: 150 }],
  ["after", 1000, {}],
];
for (const [label, ms, stim] of exps) if (!only || label.startsWith(only)) run(label, ms, stim);

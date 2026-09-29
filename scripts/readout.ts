// Dose-response, latency and left/right competition of the steering readout.
//   docker compose run --rm tools node scripts/readout.ts
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseGraph, parseNeurons, SIDE_LEFT, SIDE_RIGHT, type BrainMeta } from "../src/brain/data.ts";
import { LIFEngine, SHIU_PARAMS } from "../src/brain/engine.ts";

const DIR = new URL("../public/data/brain/", import.meta.url);
const toAB = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const meta = JSON.parse(readFileSync(new URL("meta.json", DIR), "utf8")) as BrainMeta;
const graph = parseGraph(toAB(gunzipSync(readFileSync(new URL("graph.bin.gz", DIR)))), meta);
const info = parseNeurons(toAB(gunzipSync(readFileSync(new URL("neurons.bin.gz", DIR)))), meta.neurons);
const G = meta.groups;
const dt = SHIU_PARAMS.dt;

const STEER_TYPES = (process.argv[2] ?? "DNa02,DNa01,DNae002,DNg111,DNb01,DNge043").split(",");
const pick = (side: number) => {
  const out: number[] = [];
  for (let i = 0; i < graph.n; i++)
    if (info.side[i] === side && STEER_TYPES.includes(meta.types[info.type[i]])) out.push(i);
  return out;
};
const popL = pick(SIDE_LEFT);
const popR = pick(SIDE_RIGHT);
console.log(`steering population: ${STEER_TYPES.join(", ")}  (${popL.length} left, ${popR.length} right)`);

const engine = new LIFEngine(graph, SHIU_PARAMS, 3);
engine.defineGroups([popL, popR]);

function trial(hzL: number, hzR: number, ms = 1000) {
  engine.reset();
  engine.setRate(G.LC10a_L, hzL);
  engine.setRate(G.LC10a_R, hzR);
  engine.groupCounts.fill(0);
  let firstL = -1;
  let firstR = -1;
  const steps = Math.round(ms / dt);
  for (let s = 0; s < steps; s++) {
    engine.run(1);
    if (firstL < 0 && engine.groupCounts[0] > 0) firstL = s * dt;
    if (firstR < 0 && engine.groupCounts[1] > 0) firstR = s * dt;
  }
  engine.drainSpikes();
  const out = { l: engine.groupCounts[0] / (ms / 1000), r: engine.groupCounts[1] / (ms / 1000), firstL, firstR };
  engine.setRate(G.LC10a_L, 0);
  engine.setRate(G.LC10a_R, 0);
  engine.run(Math.round(300 / dt));
  engine.drainSpikes();
  return out;
}

console.log("\ndose-response (population spikes/s):");
for (const hz of [2, 5, 10, 20, 40, 60, 80, 120]) {
  const a = trial(hz, 0);
  const b = trial(0, hz);
  console.log(
    `  ${String(hz).padStart(4)} Hz   left stim -> L ${a.l.toFixed(0).padStart(4)} R ${a.r.toFixed(0).padStart(4)} (first L spike ${a.firstL.toFixed(1)} ms)` +
      `   right stim -> L ${b.l.toFixed(0).padStart(4)} R ${b.r.toFixed(0).padStart(4)} (first R spike ${b.firstR.toFixed(1)} ms)`,
  );
}

console.log("\ncompetition (both eyes):");
for (const [l, r] of [
  [40, 40],
  [60, 20],
  [20, 60],
  [80, 40],
  [40, 80],
  [10, 10],
]) {
  const x = trial(l, r);
  console.log(`  L ${l} Hz / R ${r} Hz  ->  pop L ${x.l.toFixed(0).padStart(4)}  pop R ${x.r.toFixed(0).padStart(4)}`);
}

// how fast does the readout follow a switch from left to right?
console.log("\nswitch L->R at t=500ms (40 Hz), population spikes per 20 ms bin:");
engine.reset();
engine.setRate(G.LC10a_L, 40);
const bins: string[] = [];
for (let b = 0; b < 60; b++) {
  if (b === 25) {
    engine.setRate(G.LC10a_L, 0);
    engine.setRate(G.LC10a_R, 40);
  }
  engine.groupCounts.fill(0);
  engine.run(Math.round(20 / dt));
  engine.drainSpikes();
  bins.push(`${engine.groupCounts[0]}/${engine.groupCounts[1]}`);
}
console.log("  " + bins.join(" "));

// Which descending neurons carry "target left / target right"?
//   docker compose run --rm tools node scripts/survey.ts [--hz 60] [--ms 1000]
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseGraph, parseNeurons, SIDE_LEFT, SIDE_RIGHT, type BrainMeta } from "../src/brain/data.ts";
import { LIFEngine, SHIU_PARAMS } from "../src/brain/engine.ts";

const DIR = new URL("../public/data/brain/", import.meta.url);
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const toAB = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const meta = JSON.parse(readFileSync(new URL("meta.json", DIR), "utf8")) as BrainMeta;
const graph = parseGraph(toAB(gunzipSync(readFileSync(new URL("graph.bin.gz", DIR)))), meta);
const info = parseNeurons(toAB(gunzipSync(readFileSync(new URL("neurons.bin.gz", DIR)))), meta.neurons);

const inputs = (arg("in", "LC10a")).split(",");
const hzList = arg("hz", "30,60,120").split(",").map(Number);
const ms = Number(arg("ms", "1000"));
const trials = Number(arg("trials", "2"));
const engine = new LIFEngine(graph, SHIU_PARAMS, 11);
const dn = meta.superclasses.indexOf("descending");

const G = meta.groups;
function response(side: "L" | "R", hz: number): Float64Array {
  const counts = new Float64Array(graph.n);
  for (let tr = 0; tr < trials; tr++) {
    engine.reset();
    for (const k of Object.keys(G)) engine.setRate(G[k], 0);
    for (const inp of inputs) engine.setRate(G[`${inp}_${side}`], hz);
    const steps = Math.round(ms / SHIU_PARAMS.dt);
    for (let s = 0; s < steps; s += 100) {
      engine.run(100);
      for (const i of engine.drainSpikes()) counts[i]++;
    }
    for (const k of Object.keys(G)) engine.setRate(G[k], 0);
    engine.run(Math.round(300 / SHIU_PARAMS.dt)); // wash out
    engine.drainSpikes();
  }
  for (let i = 0; i < graph.n; i++) counts[i] /= (ms / 1000) * trials;
  return counts;
}

for (const hz of hzList) {
  const L = response("L", hz);
  const R = response("R", hz);
  // per descending type and side: rate under left vs right stimulus
  const rows: { type: string; side: string; l: number; r: number }[] = [];
  for (let i = 0; i < graph.n; i++) {
    if (info.superclass[i] !== dn) continue;
    if (L[i] < 3 && R[i] < 3) continue;
    const side = info.side[i] === SIDE_LEFT ? "L" : info.side[i] === SIDE_RIGHT ? "R" : "?";
    rows.push({ type: meta.types[info.type[i]], side, l: L[i], r: R[i] });
  }
  rows.sort((x, y) => Math.max(y.l, y.r) - Math.max(x.l, x.r));
  console.log(`\n=== ${inputs.join("+")} at ${hz} Hz: descending neurons with >3 Hz (rate under LEFT stim / RIGHT stim)`);
  for (const r of rows.slice(0, 40))
    console.log(`  ${r.type.padEnd(12)} ${r.side}   L-stim ${r.l.toFixed(1).padStart(6)}   R-stim ${r.r.toFixed(1).padStart(6)}`);
  const active = (x: Float64Array) => x.reduce((acc, v) => acc + (v > 0 ? 1 : 0), 0);
  console.log(`  neurons active: L-stim ${active(L)}  R-stim ${active(R)}`);
}

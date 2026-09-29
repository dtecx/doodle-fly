// Headless closed loop: the connectome plays the game with no graphics.
//   node scripts/play.ts [--seconds 120] [--swap] [--blind] [--seed 7]
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseGraph, parseNeurons, SIDE_LEFT, SIDE_RIGHT, type BrainMeta } from "../src/brain/data.ts";
import { LIFEngine, SHIU_PARAMS } from "../src/brain/engine.ts";
import { STEER_TYPES } from "../src/brain/protocol.ts";
import { makeInput, SteeringDecoder } from "../src/control.ts";
import { DoodleGame } from "../src/game/game.ts";

const DIR = new URL("../public/data/brain/", import.meta.url);
const flag = (n: string) => process.argv.includes(`--${n}`);
const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const toAB = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const meta = JSON.parse(readFileSync(new URL("meta.json", DIR), "utf8")) as BrainMeta;
const graph = parseGraph(toAB(gunzipSync(readFileSync(new URL("graph.bin.gz", DIR)))), meta);
const info = parseNeurons(toAB(gunzipSync(readFileSync(new URL("neurons.bin.gz", DIR)))), meta.neurons);

const engine = new LIFEngine(graph, SHIU_PARAMS, 99);
const pick = (side: number) => {
  const out: number[] = [];
  for (let i = 0; i < graph.n; i++)
    if (info.side[i] === side && (STEER_TYPES as readonly string[]).includes(meta.types[info.type[i]])) out.push(i);
  return out;
};
engine.defineGroups([pick(SIDE_LEFT), pick(SIDE_RIGHT)]);
const G = meta.groups;

// calibration, as in the worker
const measure = (side: "L" | "R", hz = 50, ms = 600) => {
  engine.reset();
  engine.setRate(G.LC10a_L, side === "L" ? hz : 0);
  engine.setRate(G.LC10a_R, side === "R" ? hz : 0);
  engine.groupCounts.fill(0);
  engine.run(Math.round(ms / SHIU_PARAMS.dt));
  const v = engine.groupCounts[side === "L" ? 0 : 1] / (ms / 1000);
  engine.setRate(G.LC10a_L, 0);
  engine.setRate(G.LC10a_R, 0);
  engine.run(3000);
  engine.drainSpikes();
  return v;
};
const respL = measure("L");
const respR = measure("R");
const ref = (respL + respR) / 2;
const cal = { respL, respR, hz: 50, gainL: ref / respL, gainR: ref / respR, ref };
console.log(`calibration: L ${respL.toFixed(0)}/s  R ${respR.toFixed(0)}/s  gainR ${cal.gainR.toFixed(2)}`);

const game = new DoodleGame(640, Number(arg("seed", "7")));
const decoder = new SteeringDecoder();
const frameMs = 1000 / 60;
const seconds = Number(arg("seconds", "120"));
const frames = Math.round((seconds * 1000) / frameMs);
const scores: number[] = [];
let steer = 0;
let absDx = 0;
let n = 0;
const wall0 = performance.now();
for (let fr = 0; fr < frames; fr++) {
  const s = game.sense;
  const input = makeInput(s.target ? s.dx : null, { swapEyes: flag("swap"), blind: flag("blind"), loom: 0, sugar: 0 });
  engine.setRate(G.LC10a_L, input.lc10L);
  engine.setRate(G.LC10a_R, input.lc10R);
  engine.groupCounts.fill(0);
  engine.run(Math.round(frameMs / SHIU_PARAMS.dt));
  engine.drainSpikes();
  steer = decoder.update(engine.groupCounts[0], engine.groupCounts[1], frameMs, cal);
  game.step(frameMs / 1000, steer);
  if (s.target) {
    absDx += Math.abs(s.dx);
    n++;
  }
  for (const ev of game.takeEvents()) if (ev.kind === "fall") scores.push(game.score);
  if (flag("debug") && fr % 600 === 0) {
    const f = game.fly;
    const near = game.platforms
      .filter((p) => p.y > f.y - 80 && p.y < f.y + 300)
      .map((p) => `${p.kind[0]}(${p.x.toFixed(0)},${p.y.toFixed(0)}${p.gone ? ",gone" : ""})`)
      .join(" ");
    console.log(
      `t=${(fr * frameMs / 1000).toFixed(0)}s fly(${f.x.toFixed(0)},${f.y.toFixed(0)}) vy=${f.vy.toFixed(0)} score=${game.score} ` +
        `target=${s.target ? `(${s.target.x.toFixed(0)},${s.target.y.toFixed(0)})` : "-"} dx=${s.dx.toFixed(0)} steer=${steer.toFixed(2)} | ${near}`,
    );
  }
}
const wall = (performance.now() - wall0) / 1000;
scores.push(game.score);
console.log(
  `${seconds}s game time in ${wall.toFixed(1)}s wall (${(seconds / wall).toFixed(1)}x)  games ${scores.length}  ` +
    `scores ${scores.join(", ")}  best ${Math.max(...scores)}  jumps ${game.jumps}  mean |dx| ${(absDx / Math.max(1, n)).toFixed(0)}`,
);

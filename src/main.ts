import "./style.css";
import { Sfx } from "./audio.ts";
import { BrainClient } from "./brain/client.ts";
import { STEER_TYPES, TRACKED, type FrameResult, type ReadyInfo, type SensoryInput } from "./brain/protocol.ts";
import { makeInput, SteeringDecoder } from "./control.ts";
import { ArcadeScene } from "./fly3d/scene.ts";
import { DoodleGame, VIEW_H } from "./game/game.ts";
import { GameRenderer } from "./game/render.ts";
import { BrainMap } from "./stats/brainmap.ts";
import { PathwayView } from "./ui/pathway.ts";
import { SpikesView } from "./ui/spikes.ts";

/** one brain step = one game frame of simulated time */
const FRAME_MS = 1000 / 60;
const SUGAR_MS = 450;
const SUGAR_HZ = 150;
const LOOM_HZ = 120;
const BEST_KEY = "doodle-fly:best";
/** hysteresis for the arcade-button click sound */
const PRESS_ON = 0.18;
const PRESS_OFF = 0.08;

type Toggle = "showTarget" | "swapEyes" | "blind";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const gameCanvas = $<HTMLCanvasElement>("game");
const screenCanvas = document.createElement("canvas");
const loader = $("loader");

const opts = { showTarget: true, swapEyes: false, blind: false, speed: 1, paused: false };

const brain = new BrainClient();
const game = new DoodleGame(640, (Math.random() * 1e9) | 0);
const gameRenderer = new GameRenderer(gameCanvas);
const decoder = new SteeringDecoder();
const sfx = new Sfx();
let arcade: ArcadeScene;
let brainMap: BrainMap;
let pathway: PathwayView;
let spikes: SpikesView;
let info: ReadyInfo;

let budget = 0;
let lastNow = performance.now();
let sugarLeft = 0;
let bounce = false;
let startle = 0;
let proboscis = 0;
let pressed: -1 | 0 | 1 = 0;
let lastInput: SensoryInput = { lc10L: 0, lc10R: 0, loom: 0, sugar: 0 };
const speedWindow: { real: number; sim: number }[] = [];
let simTotal = 0;
/** brain clock of the latest frame (includes the start-up calibration) */
let brainNow = 0;
let gameSpeed = 1;
let factsAt = 0;

try {
  game.best = Number(localStorage.getItem(BEST_KEY)) || 0;
} catch {
  game.best = 0;
}

function currentInput(): SensoryInput {
  const f = game.fly;
  const s = game.sense;
  const dx = f.alive && s.target ? s.dx : null;
  const loom = !f.alive ? (f.deadT < 0.5 ? LOOM_HZ : 0) : s.danger ? LOOM_HZ : 0;
  return makeInput(dx, { swapEyes: opts.swapEyes, blind: opts.blind, loom, sugar: sugarLeft > 0 ? SUGAR_HZ : 0 });
}

function sendStep(): void {
  lastInput = currentInput();
  brain.step(FRAME_MS, lastInput);
}

function onFrame(frame: FrameResult): void {
  budget -= frame.frameMs;
  const counts: Record<string, number> = {};
  TRACKED.forEach((k, i) => (counts[k] = frame.counts[i]));
  let l = 0;
  let r = 0;
  for (const t of STEER_TYPES) {
    l += counts[`${t}_L`];
    r += counts[`${t}_R`];
  }
  const steer = decoder.update(l, r, frame.frameMs, info.calibration);
  const dx = game.fly.alive && game.sense.target ? game.sense.dx : null;
  game.step(frame.frameMs / 1000, steer);
  sugarLeft = Math.max(0, sugarLeft - frame.frameMs);
  const pan = (game.fly.x / game.W) * 1.2 - 0.6;
  for (const ev of game.takeEvents()) {
    if (ev.kind === "sugar") {
      sugarLeft = SUGAR_MS;
      sfx.sugar(pan);
    } else if (ev.kind === "bounce") {
      bounce = true;
      sfx.bounce(pan);
    } else if (ev.kind === "spring") {
      bounce = true;
      sfx.spring(pan);
    } else if (ev.kind === "break") sfx.crack(pan);
    else if (ev.kind === "fall") {
      sfx.fall();
      try {
        localStorage.setItem(BEST_KEY, String(game.best));
      } catch {
        /* not persisted */
      }
    } else if (ev.kind === "restart") {
      decoder.reset();
      sfx.restart();
    }
  }
  // the 3D fly clicks an arcade button whenever the steering command crosses the press threshold
  const want: -1 | 0 | 1 = steer < -PRESS_ON ? -1 : steer > PRESS_ON ? 1 : Math.abs(steer) < PRESS_OFF ? 0 : pressed;
  if (want !== pressed && want !== 0) sfx.click(want * 0.5);
  pressed = want;

  // body readouts: giant fibre -> startle, proboscis motor neurons -> proboscis
  const k = 1 - Math.exp(-frame.frameMs / 90);
  const gfHz = ((counts.DNp01_L + counts.DNp01_R) * 1000) / frame.frameMs / 2;
  startle += (Math.min(1, gfHz / 120) - startle) * k;
  const mnHz = (counts.proboscis_MN * 1000) / frame.frameMs / Math.max(1, info.groups.proboscis_MN.length);
  proboscis += (Math.min(1, mnHz / 14) - proboscis) * (1 - Math.exp(-frame.frameMs / 140));

  simTotal += frame.frameMs;
  brainNow = frame.simMs;
  brainMap.addSpikes(frame.spikes, frame.spikeT, frame.simMs - frame.frameMs);
  spikes.onFrame(frame, { steer, rateL: decoder.rateL, rateR: decoder.rateR, gameSpeed, paused: opts.paused });
  pathway.onFrame({
    input: lastInput,
    counts,
    frameMs: frame.frameMs,
    steer,
    rateL: decoder.rateL,
    rateR: decoder.rateR,
    dx,
    swapEyes: opts.swapEyes,
    blind: opts.blind,
  });
  if (!opts.paused && budget >= FRAME_MS) sendStep();
}

function tick(now: number): void {
  const realDt = Math.min(100, now - lastNow);
  lastNow = now;
  if (!opts.paused) budget = Math.min(budget + realDt * opts.speed, FRAME_MS * 4 * opts.speed);
  if (!opts.paused && !brain.pending && budget >= FRAME_MS) sendStep();

  speedWindow.push({ real: now, sim: simTotal });
  while (speedWindow.length > 2 && now - speedWindow[0].real > 1000) speedWindow.shift();
  const w0 = speedWindow[0];
  if (now - w0.real > 200) gameSpeed = (simTotal - w0.sim) / (now - w0.real);

  const f = game.fly;
  const buzz = opts.paused ? 0 : f.alive ? (f.vy > 700 ? 1 : 0) : Math.max(0, 1 - f.deadT);
  sfx.buzz(Math.max(buzz, startle * 0.6));
  gameRenderer.draw(game, opts.paused ? 0 : realDt / 1000, { proboscis, startle, showTarget: opts.showTarget, paused: opts.paused });
  const sctx = screenCanvas.getContext("2d")!;
  sctx.drawImage(gameCanvas, 0, 0, screenCanvas.width, screenCanvas.height);
  arcade.render(realDt / 1000, { steer: decoder.steer, proboscis, startle, buzz, bounce });
  bounce = false;
  brainMap.render(brainNow);
  pathway.draw(now);
  spikes.render();
  if (now - factsAt > 250) {
    factsAt = now;
    $("facts").innerHTML = spikes.facts();
    const st = $("steer-value");
    const s = decoder.steer;
    st.textContent = s < -0.1 ? `◀ left ${s.toFixed(2)}` : s > 0.1 ? `right ▶ +${s.toFixed(2)}` : "straight";
    st.className = `steer ${s < -0.1 ? "left" : s > 0.1 ? "right" : ""}`;
  }
  requestAnimationFrame(tick);
}

function resize(): void {
  const w = gameRenderer.resize(VIEW_H);
  game.setWidth(w);
  const aspect = gameCanvas.clientWidth / Math.max(1, gameCanvas.clientHeight);
  screenCanvas.height = 560;
  screenCanvas.width = Math.round(560 * aspect);
  arcade?.setScreenAspect(aspect);
  arcade?.resize();
  brainMap?.resize();
  pathway?.resize();
  spikes?.resize();
}

function bindUi(): void {
  const toggles = document.querySelectorAll<HTMLButtonElement>("[data-opt]");
  const segs = [...document.querySelectorAll<HTMLButtonElement>(".seg button")];
  const play = $("play");
  const mute = $("mute-btn");
  const hint = $("sound-hint");
  const sync = () => {
    toggles.forEach((b) => b.setAttribute("aria-pressed", String(Boolean(opts[b.dataset.opt as Toggle]))));
    segs.forEach((b) => b.setAttribute("aria-checked", String(Number(b.dataset.speed) === opts.speed)));
    play.classList.toggle("paused", opts.paused);
    play.setAttribute("aria-label", opts.paused ? "Play" : "Pause");
    mute.classList.toggle("muted", sfx.muted);
    mute.setAttribute("aria-pressed", String(sfx.muted));
    mute.title = sfx.muted ? "Sound off — click to unmute (M)" : "Sound on — click to mute (M)";
    hint.hidden = sfx.muted || sfx.unlocked;
  };
  const toggle = (key: Toggle) => {
    opts[key] = !opts[key];
    sync();
  };
  toggles.forEach((b) => b.addEventListener("click", () => toggle(b.dataset.opt as Toggle)));
  segs.forEach((b) =>
    b.addEventListener("click", () => {
      opts.speed = Number(b.dataset.speed);
      sync();
    }),
  );
  const cycleSpeed = () => {
    opts.speed = opts.speed === 1 ? 2 : opts.speed === 2 ? 4 : 1;
    sync();
  };
  const togglePause = () => {
    opts.paused = !opts.paused;
    sync();
  };
  const toggleMute = () => {
    sfx.setMuted(!sfx.muted);
    sync();
  };
  play.addEventListener("click", togglePause);
  mute.addEventListener("click", (e) => {
    e.stopPropagation();
    sfx.unlock();
    toggleMute();
  });
  const about = $<HTMLDialogElement>("about");
  $("about-btn").addEventListener("click", () => about.showModal());
  about.addEventListener("click", (e) => {
    if (e.target === about) about.close();
  });
  // audio may only start from a user gesture
  const unlock = () => {
    sfx.unlock();
    setTimeout(sync, 50);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", (e) => {
    unlock();
    if (e.target instanceof HTMLInputElement || about.open) return;
    if (e.code === "Space") {
      e.preventDefault();
      togglePause();
    } else if (e.code === "KeyS") toggle("swapEyes");
    else if (e.code === "KeyB") toggle("blind");
    else if (e.code === "KeyT") toggle("showTarget");
    else if (e.code === "KeyF") cycleSpeed();
    else if (e.code === "KeyM") toggleMute();
  });
  sync();
}

async function main(): Promise<void> {
  resize();
  brain.onProgress = (stage, frac) => {
    $("loader-stage").textContent = stage;
    $("loader-bar").style.width = `${Math.round(frac * 100)}%`;
  };
  brain.onError = (msg) => {
    $("loader-stage").textContent = `Error: ${msg}`;
    loader.classList.add("error");
  };
  brain.onFrame = onFrame;
  // the worker resolves URLs against its own script, so hand it an absolute base
  info = await brain.init(new URL(import.meta.env.BASE_URL, location.href).href);
  await Promise.race([
    Promise.all([
      document.fonts.load("40px Pangolin"),
      document.fonts.load('italic 500 40px "Newsreader"'),
      document.fonts.load('600 13px "IBM Plex Sans"'),
      document.fonts.load('500 12px "IBM Plex Mono"'),
    ]),
    new Promise((r) => setTimeout(r, 2000)),
  ]);
  arcade = new ArcadeScene($<HTMLCanvasElement>("arcade"), screenCanvas);
  brainMap = new BrainMap($<HTMLCanvasElement>("brainmap"), info);
  pathway = new PathwayView($<HTMLCanvasElement>("pathway"), info);
  spikes = new SpikesView(info);
  bindUi();
  resize();
  window.addEventListener("resize", resize);
  loader.classList.add("done");
  if (import.meta.env.DEV) Object.assign(window, { __doodle: { game, brainMap, arcade, spikes, pathway, info, opts, decoder, sfx } });
  lastNow = performance.now();
  requestAnimationFrame(tick);
}

void main();

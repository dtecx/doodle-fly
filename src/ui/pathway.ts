// Panel c: the steering pathway, live. Two mirrored columns, the fly's left and right: the target drives LC10a in
// one eye, the signal runs through the anterior optic tubercle (AOTU) to six types of descending neurons, and the
// stronger side presses its button. Beside them, the two other circuits the game touches: taste and escape.
//
// Two layouts: on a wide canvas taste and escape sit between the columns; on a phone they move underneath.
import type { ReadyInfo, SensoryInput } from "../brain/protocol.ts";
import { C, F, fitCanvas } from "./theme.ts";

/** smallest label on screen, CSS px */
const MIN_PX = 10.5;
/** below this canvas width (CSS px) the phone layout is used */
const PHONE_BELOW = 560;

export interface PathwayFrame {
  input: SensoryInput;
  /** spikes of every tracked group in this frame */
  counts: Record<string, number>;
  frameMs: number;
  steer: number;
  /** population rate of the steering neurons, spikes/s */
  rateL: number;
  rateR: number;
  /** horizontal offset of the target platform (game units), null if none */
  dx: number | null;
  swapEyes: boolean;
  blind: boolean;
}

interface Node {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Layout {
  vw: number;
  vh: number;
  col: { L: number; R: number };
  rows: { eye: number; aotu: number; dn: number; button: number };
  box: { w: number; h: number };
  /** taste and escape: where their labels and the two cells of each sit */
  side: {
    taste: { x: number; label: number; a: number; b: number };
    escape: { x: number; label: number; a: number; b: number };
    w: number;
  };
}

const WIDE: Layout = {
  vw: 600,
  vh: 410,
  col: { L: 124, R: 476 },
  rows: { eye: 70, aotu: 166, dn: 262, button: 354 },
  box: { w: 204, h: 60 },
  side: { taste: { x: 300, label: 58, a: 86, b: 144 }, escape: { x: 300, label: 198, a: 226, b: 284 }, w: 104 },
};

const PHONE: Layout = {
  vw: 380,
  vh: 540,
  col: { L: 94, R: 286 },
  rows: { eye: 70, aotu: 158, dn: 246, button: 330 },
  box: { w: 178, h: 58 },
  side: { taste: { x: 94, label: 412, a: 442, b: 496 }, escape: { x: 286, label: 412, a: 442, b: 496 }, w: 150 },
};

export class PathwayView {
  private readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private readonly size: Record<string, number> = {};
  private readonly rate: Record<string, number> = {};
  private L: Layout = WIDE;
  private f: PathwayFrame | null = null;
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private dpr = 1;
  private phase = { L: 0, R: 0 };
  private last = performance.now();

  constructor(canvas: HTMLCanvasElement, info: ReadyInfo) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    for (const [k, ids] of Object.entries(info.groups)) this.size[k] = ids.length;
  }

  resize(): void {
    const width = this.canvas.getBoundingClientRect().width;
    this.L = width < PHONE_BELOW ? PHONE : WIDE;
    // a phone gets a canvas as tall as the drawing needs
    this.canvas.style.height = this.L === PHONE ? `${Math.round((width * this.L.vh) / this.L.vw)}px` : "";
    const { w, h, dpr, ctx } = fitCanvas(this.canvas);
    this.ctx = ctx;
    this.dpr = dpr;
    this.scale = Math.min(w / this.L.vw, h / this.L.vh);
    this.ox = (w - this.L.vw * this.scale) / 2;
    this.oy = this.L === PHONE ? 0 : (h - this.L.vh * this.scale) / 2;
  }

  onFrame(f: PathwayFrame): void {
    this.f = f;
    const k = 1 - Math.exp(-f.frameMs / 150);
    for (const [key, c] of Object.entries(f.counts)) {
      const hz = (c * 1000) / f.frameMs / Math.max(1, this.size[key] ?? 1);
      this.rate[key] = (this.rate[key] ?? 0) + (hz - (this.rate[key] ?? 0)) * k;
    }
  }

  private hz(...keys: string[]): number {
    return keys.reduce((s, k) => s + (this.rate[k] ?? 0), 0) / keys.length;
  }

  private text(s: string, x: number, y: number, font: string, color: string, align: CanvasTextAlign = "left"): void {
    const ctx = this.ctx;
    ctx.font = font.replace(/(\d+(?:\.\d+)?)px/, (_, n: string) => `${Math.max(Number(n), MIN_PX / this.scale).toFixed(1)}px`);
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(s, x, y);
  }

  private box(n: Node, color: string, level: number, title: string, detail: string, value: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = "#ece5d7";
    ctx.strokeStyle = "rgba(28, 26, 23, 0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(n.x - n.w / 2, n.y - n.h / 2, n.w, n.h, 6);
    ctx.fill();
    ctx.stroke();
    // activity: a bar along the bottom edge
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.roundRect(n.x - n.w / 2 + 6, n.y + n.h / 2 - 9, (n.w - 12) * Math.min(1, level), 4, 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    this.text(title, n.x - n.w / 2 + 10, n.y - n.h / 2 + 20, `600 14px ${F.sans}`, C.ink);
    this.text(detail, n.x - n.w / 2 + 10, n.y - n.h / 2 + 37, `400 11.5px ${F.sans}`, C.ink3);
    this.text(value, n.x + n.w / 2 - 10, n.y - n.h / 2 + 20, `500 12.5px ${F.mono}`, C.ink2, "right");
  }

  /** a connection, with dots that run faster the more the downstream cells fire */
  private wire(x: number, y0: number, y1: number, color: string, level: number, phase: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.18 + 0.5 * Math.min(1, level);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
    ctx.stroke();
    ctx.globalAlpha = Math.min(1, level * 1.4);
    ctx.fillStyle = color;
    for (let i = 0; i < 3; i++) {
      const t = (phase + i / 3) % 1;
      ctx.beginPath();
      ctx.arc(x, y0 + (y1 - y0) * t, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // arrowhead
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(x - 4, y1 - 6);
    ctx.lineTo(x, y1);
    ctx.lineTo(x + 4, y1 - 6);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /** one of the four small cells of the taste and escape circuits */
  private mini(x: number, y: number, title: string, value: string, level: number, color: string): void {
    const ctx = this.ctx;
    const w = this.L.side.w;
    const h = 40;
    ctx.fillStyle = "#ece5d7";
    ctx.strokeStyle = "rgba(28, 26, 23, 0.18)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h / 2, w, h, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.25 + 0.75 * Math.min(1, level);
    ctx.beginPath();
    ctx.roundRect(x - w / 2 + 6, y + h / 2 - 8, (w - 12) * Math.min(1, level), 3.5, 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    this.text(title, x, y - 3, `500 11px ${F.sans}`, C.ink2, "center");
    this.text(value, x, y + 10, `500 11px ${F.mono}`, C.ink, "center");
  }

  draw(now: number): void {
    const ctx = this.ctx;
    const L = this.L;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr * this.scale, 0, 0, this.dpr * this.scale, this.dpr * this.ox, this.dpr * this.oy);
    ctx.lineCap = "round";
    const f = this.f;
    if (!f) return;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;

    // what the eyes see
    let seen = "no platform in reach";
    if (f.blind) seen = "blind: no input to LC10a";
    else if (f.dx !== null) seen = Math.abs(f.dx) < 13 ? "target straight ahead" : `target ${Math.round(Math.abs(f.dx))} px to the ${f.dx < 0 ? "left" : "right"}`;
    this.text(seen + (f.swapEyes ? " · eyes swapped" : ""), L.vw / 2, 18, `italic 400 14px ${F.serif}`, f.swapEyes || f.blind ? C.escape : C.ink2, "center");

    const sides = [
      { s: "L" as const, x: L.col.L, color: C.left, drive: f.input.lc10L, rate: f.rateL },
      { s: "R" as const, x: L.col.R, color: C.right, drive: f.input.lc10R, rate: f.rateR },
    ];
    const { box: B, rows: R } = L;
    for (const side of sides) {
      const lc = this.hz(`LC10a_${side.s}`);
      const aotu = this.hz(`AOTU019_${side.s}`, `AOTU025_${side.s}`);
      const lvLc = lc / 60;
      const lvAotu = aotu / 120;
      const lvDn = side.rate / 450;
      this.phase[side.s] = (this.phase[side.s] + dt * (0.4 + 2.2 * Math.min(1, lvDn + lvAotu * 0.5))) % 1;
      const ph = this.phase[side.s];
      const at = (y: number): Node => ({ x: side.x, y, w: B.w, h: B.h });
      this.text(`${side.s === "L" ? "left" : "right"} eye`, side.x, R.eye - B.h / 2 - 14, `500 12px ${F.sans}`, side.color, "center");
      this.box(at(R.eye), side.color, lvLc, "LC10a", `${this.size[`LC10a_${side.s}`]} cells · drive ${Math.round(side.drive)} Hz`, `${lc.toFixed(1)} Hz`);
      this.wire(side.x, R.eye + B.h / 2 + 2, R.aotu - B.h / 2 - 2, side.color, lvAotu, ph);
      this.box(at(R.aotu), side.color, lvAotu, "AOTU", "019 + 025, optic tubercle", `${aotu.toFixed(1)} Hz`);
      this.wire(side.x, R.aotu + B.h / 2 + 2, R.dn - B.h / 2 - 2, side.color, lvDn, ph);
      this.box(at(R.dn), side.color, lvDn, "steering", "DNa02 + 5 descending types", `${Math.round(side.rate)} sp/s`);
      this.wire(side.x, R.dn + B.h / 2 + 2, R.button - 30, side.color, lvDn, ph);
      // the button
      const pressed = side.s === "L" ? f.steer < -0.18 : f.steer > 0.18;
      ctx.beginPath();
      ctx.arc(side.x, R.button, 26, 0, Math.PI * 2);
      ctx.fillStyle = pressed ? side.color : "#ece5d7";
      ctx.fill();
      ctx.strokeStyle = side.color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      this.text(side.s === "L" ? "◀" : "▶", side.x, R.button + 6, `600 17px ${F.sans}`, pressed ? "#fffaf2" : side.color, "center");
    }

    // steering: right minus left
    const gx0 = L.col.L + 46;
    const gx1 = L.col.R - 46;
    const gy = R.button;
    const mid = (gx0 + gx1) / 2;
    ctx.strokeStyle = C.rule;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(gx0, gy);
    ctx.lineTo(gx1, gy);
    ctx.stroke();
    const s = Math.max(-1.4, Math.min(1.4, f.steer));
    const sx = mid + (s / 1.4) * ((gx1 - gx0) / 2);
    ctx.strokeStyle = s < 0 ? C.left : C.right;
    ctx.beginPath();
    ctx.moveTo(mid, gy);
    ctx.lineTo(sx, gy);
    ctx.stroke();
    ctx.fillStyle = C.ink;
    ctx.fillRect(mid - 0.75, gy - 9, 1.5, 18);
    const value = `${f.steer >= 0 ? "+" : "−"}${Math.abs(f.steer).toFixed(2)}`;
    this.text(L === PHONE ? `steer ${value}` : `steer = right − left  ${value}`, mid, gy + 30, `500 12px ${F.mono}`, C.ink2, "center");

    // taste and escape
    const sugar = this.hz("sugar_GRN_L", "sugar_GRN_R");
    const mn = this.hz("proboscis_MN");
    const loom = this.hz("LPLC2_L", "LPLC2_R", "LC4_L", "LC4_R");
    const gf = this.hz("DNp01_L", "DNp01_R");
    const { taste, escape } = L.side;
    this.text("taste", taste.x, taste.label, `500 12px ${F.sans}`, C.taste, "center");
    this.mini(taste.x, taste.a, "sugar neurons", `${sugar.toFixed(1)} Hz`, sugar / 120, C.taste);
    this.mini(taste.x, taste.b, "proboscis", `${mn.toFixed(1)} Hz`, mn / 14, C.taste);
    this.text("escape", escape.x, escape.label, `500 12px ${F.sans}`, C.escape, "center");
    this.mini(escape.x, escape.a, "looming", `${loom.toFixed(1)} Hz`, loom / 100, C.escape);
    this.mini(escape.x, escape.b, "giant fibre", `${gf.toFixed(1)} Hz`, gf / 120, C.escape);
    ctx.strokeStyle = C.rule;
    ctx.lineWidth = 1;
    for (const c of [taste, escape]) {
      ctx.beginPath();
      ctx.moveTo(c.x, c.a + 20);
      ctx.lineTo(c.x, c.b - 20);
      ctx.stroke();
    }
  }
}

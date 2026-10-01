// Panel d: a spike raster of identified neurons and the steering trace, drawn like a recording on paper; plus the
// running numbers for the footnote line.
import { STEER_TYPES, type FrameResult, type ReadyInfo, type TrackedKey } from "../brain/protocol.ts";
import { C, F, fitCanvas } from "./theme.ts";

interface Block {
  label: string;
  keys: TrackedKey[];
  sample: number;
  color: string;
}

const L = (t: string) => `${t}_L` as TrackedKey;
const R = (t: string) => `${t}_R` as TrackedKey;

const BLOCKS: Block[] = [
  { label: "LC10a · left eye", keys: ["LC10a_L"], sample: 8, color: C.left },
  { label: "LC10a · right eye", keys: ["LC10a_R"], sample: 8, color: C.right },
  { label: "AOTU · left", keys: ["AOTU019_L", "AOTU025_L"], sample: 2, color: C.left },
  { label: "AOTU · right", keys: ["AOTU019_R", "AOTU025_R"], sample: 2, color: C.right },
  { label: "steering · left", keys: STEER_TYPES.map(L), sample: 6, color: C.left },
  { label: "steering · right", keys: STEER_TYPES.map(R), sample: 6, color: C.right },
  { label: "giant fibre", keys: ["DNp01_L", "DNp01_R"], sample: 2, color: C.escape },
  { label: "sugar neurons", keys: ["sugar_GRN_L", "sugar_GRN_R"], sample: 6, color: C.taste },
  { label: "proboscis", keys: ["proboscis_MN"], sample: 6, color: C.taste },
];

const RASTER_MS = 2500;
const TRACE_MS = 8000;
const MIN_ROW_BLOCK = 11;

export interface Derived {
  steer: number;
  rateL: number;
  rateR: number;
  gameSpeed: number;
  paused: boolean;
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

export class SpikesView {
  private readonly info: ReadyInfo;
  private readonly raster: HTMLCanvasElement;
  private readonly traces: HTMLCanvasElement;
  private rctx: CanvasRenderingContext2D;
  private tctx: CanvasRenderingContext2D;
  private readonly rowOf: Int16Array;
  private readonly rowColor: string[] = [];
  private readonly blocks: { block: Block; first: number; count: number }[] = [];
  private nRows = 0;
  private readonly evT = new Float64Array(30000);
  private readonly evRow = new Int16Array(30000);
  private evHead = 0;
  private evCount = 0;
  private readonly trace: { t: number; steer: number; l: number; r: number }[] = [];
  private readonly lastSpike: Float32Array;
  private readonly everFired: Uint8Array;
  private everCount = 0;
  private brainRate = 0;
  private simNow = 0;
  private last: FrameResult | null = null;
  private derived: Derived | null = null;

  constructor(info: ReadyInfo) {
    this.info = info;
    this.raster = document.getElementById("raster") as HTMLCanvasElement;
    this.traces = document.getElementById("traces") as HTMLCanvasElement;
    this.rctx = fitCanvas(this.raster).ctx;
    this.tctx = fitCanvas(this.traces).ctx;
    this.rowOf = new Int16Array(info.neurons).fill(-1);
    for (const block of BLOCKS) {
      const ids: number[] = [];
      for (const k of block.keys) ids.push(...info.groups[k]);
      const pick = ids.slice(0, block.sample);
      this.blocks.push({ block, first: this.nRows, count: pick.length });
      for (const i of pick) {
        this.rowOf[i] = this.nRows++;
        this.rowColor.push(block.color);
      }
    }
    this.lastSpike = new Float32Array(info.neurons).fill(-1e9);
    this.everFired = new Uint8Array(info.neurons);
  }

  resize(): void {
    this.rctx = fitCanvas(this.raster).ctx;
    this.tctx = fitCanvas(this.traces).ctx;
  }

  onFrame(frame: FrameResult, d: Derived): void {
    this.last = frame;
    this.derived = d;
    const start = frame.simMs - frame.frameMs;
    this.simNow = frame.simMs;
    const { spikes, spikeT } = frame;
    for (let k = 0; k < spikes.length; k++) {
      const i = spikes[k];
      const t = start + spikeT[k];
      this.lastSpike[i] = t;
      if (!this.everFired[i]) {
        this.everFired[i] = 1;
        this.everCount++;
      }
      const row = this.rowOf[i];
      if (row >= 0) {
        this.evT[this.evHead] = t;
        this.evRow[this.evHead] = row;
        this.evHead = (this.evHead + 1) % this.evT.length;
        this.evCount = Math.min(this.evCount + 1, this.evT.length);
      }
    }
    const k = 1 - Math.exp(-frame.frameMs / 250);
    this.brainRate += ((spikes.length * 1000) / frame.frameMs - this.brainRate) * k;
    this.trace.push({ t: frame.simMs, steer: d.steer, l: d.rateL, r: d.rateR });
    while (this.trace.length && this.trace[0].t < frame.simMs - TRACE_MS) this.trace.shift();
  }

  render(): void {
    this.drawRaster();
    this.drawTraces();
  }

  /** the footnote line */
  facts(): string {
    const f = this.last;
    const d = this.derived;
    if (!f || !d) return "";
    const s = f.simMs / 1000;
    const time = `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
    let active = 0;
    const cut = f.simMs - 1000;
    for (let i = 0; i < this.lastSpike.length; i++) if (this.lastSpike[i] > cut) active++;
    const c = this.info.calibration;
    return (
      `Brain time <b>${time}</b> · ${d.paused ? "paused" : `game speed ×${d.gameSpeed.toFixed(2)}`} · headroom ×${(f.frameMs / Math.max(0.05, f.wallMs)).toFixed(1)}` +
      ` · <b>${fmt(this.brainRate)}</b> spikes/s · ${fmt(active)} neurons active in the last second · ${fmt(f.active)} integrated every step` +
      ` · ${fmt(f.totalSpikes)} spikes so far, ${fmt(this.everCount)} neurons have fired (${((100 * this.everCount) / this.info.neurons).toFixed(1)} %)` +
      ` · steering calibration L ${fmt(c.respL)} / R ${fmt(c.respR)} sp/s → right ×${c.gainR.toFixed(2)}`
    );
  }

  private rows(h: number): { y: Float32Array; hgt: Float32Array } {
    const total = this.blocks.reduce((s, b) => s + b.count, 0);
    const free = Math.max(0, h - this.blocks.length * MIN_ROW_BLOCK);
    const y = new Float32Array(this.nRows);
    const hgt = new Float32Array(this.nRows);
    let at = 0;
    for (const b of this.blocks) {
      const bh = MIN_ROW_BLOCK + (free * b.count) / Math.max(1, total);
      for (let r = 0; r < b.count; r++) {
        y[b.first + r] = at + (bh * r) / b.count;
        hgt[b.first + r] = bh / b.count;
      }
      at += bh;
    }
    return { y, hgt };
  }

  private drawRaster(): void {
    const ctx = this.rctx;
    const w = this.raster.clientWidth;
    const h = this.raster.clientHeight;
    ctx.clearRect(0, 0, w, h);
    const labelW = 116;
    const plotW = w - labelW - 4;
    const plotH = h - 16;
    const { y: rowY, hgt: rowH } = this.rows(plotH);
    ctx.font = `400 11px ${F.sans}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    this.blocks.forEach(({ block, first, count }, bi) => {
      if (!count) return;
      const y0 = rowY[first];
      const bh = rowY[first + count - 1] + rowH[first + count - 1] - y0;
      if (bi % 2 === 0) {
        ctx.fillStyle = "rgba(28, 26, 23, 0.035)";
        ctx.fillRect(labelW, y0, plotW, bh);
      }
      ctx.fillStyle = block.color;
      ctx.fillText(block.label, labelW - 8, y0 + bh / 2);
    });
    const now = this.simNow;
    for (let k = 0; k < this.evCount; k++) {
      const idx = (this.evHead - 1 - k + this.evT.length) % this.evT.length;
      const age = now - this.evT[idx];
      if (age > RASTER_MS) break;
      const x = labelW + plotW * (1 - age / RASTER_MS);
      const row = this.evRow[idx];
      ctx.fillStyle = this.rowColor[row];
      ctx.fillRect(x, rowY[row] + 0.5, 1.5, Math.max(1.5, rowH[row] - 1));
    }
    ctx.fillStyle = C.ink3;
    ctx.font = `400 11px ${F.mono}`;
    ctx.textAlign = "left";
    ctx.fillText(`−${RASTER_MS / 1000} s`, labelW, h - 6);
    ctx.textAlign = "right";
    ctx.fillText("now", w - 2, h - 6);
  }

  private drawTraces(): void {
    const ctx = this.tctx;
    const w = this.traces.clientWidth;
    const h = this.traces.clientHeight;
    ctx.clearRect(0, 0, w, h);
    if (!this.trace.length) return;
    const now = this.simNow;
    const top = 18;
    const plotH = h - top - 2;
    const mid = top + plotH / 2;
    ctx.strokeStyle = C.faint;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(mid) + 0.5);
    ctx.lineTo(w, Math.round(mid) + 0.5);
    ctx.stroke();
    let maxRate = 300;
    for (const p of this.trace) maxRate = Math.max(maxRate, p.l, p.r);
    const line = (get: (p: (typeof this.trace)[number]) => number, color: string, width: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineJoin = "round";
      ctx.beginPath();
      this.trace.forEach((p, i) => {
        const x = w * (1 - (now - p.t) / TRACE_MS);
        if (i === 0) ctx.moveTo(x, get(p));
        else ctx.lineTo(x, get(p));
      });
      ctx.stroke();
    };
    ctx.globalAlpha = 0.55;
    line((p) => h - 2 - (p.l / maxRate) * plotH, C.left, 1.2);
    line((p) => h - 2 - (p.r / maxRate) * plotH, C.right, 1.2);
    ctx.globalAlpha = 1;
    line((p) => mid - (Math.max(-1.4, Math.min(1.4, p.steer)) / 1.4) * (plotH / 2), C.ink, 1.6);
    ctx.font = `400 11px ${F.sans}`;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    let x = 0;
    for (const [text, color] of [
      ["steering neurons, left", C.left],
      ["right", C.right],
      ["steer = right − left", C.ink],
    ] as const) {
      ctx.fillStyle = color;
      ctx.fillText(text, x, 1);
      x += ctx.measureText(text).width + 14;
    }
    ctx.fillStyle = C.ink3;
    ctx.textAlign = "right";
    ctx.fillText(`last ${TRACE_MS / 1000} s`, w, 1);
  }
}

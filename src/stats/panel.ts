// Live brain statistics: pipeline meters, spike raster, rate traces, activity by class and cell type.
import { STEER_TYPES, type FrameResult, type ReadyInfo, type SensoryInput, type TrackedKey } from "../brain/protocol.ts";

export interface Derived {
  input: SensoryInput;
  steer: number;
  rateL: number;
  rateR: number;
  /** sim ms advanced per real ms over the last second */
  gameSpeed: number;
  paused: boolean;
}

interface RasterBlock {
  label: string;
  keys: TrackedKey[];
  sample: number;
  color: string;
}

const L = (t: string) => `${t}_L` as TrackedKey;
const R = (t: string) => `${t}_R` as TrackedKey;

const RASTER: RasterBlock[] = [
  { label: "LC10a  L", keys: ["LC10a_L"], sample: 8, color: "#5ee7ff" },
  { label: "LC10a  R", keys: ["LC10a_R"], sample: 8, color: "#5ee7ff" },
  { label: "AOTU  L", keys: ["AOTU019_L", "AOTU025_L"], sample: 2, color: "#b197fc" },
  { label: "AOTU  R", keys: ["AOTU019_R", "AOTU025_R"], sample: 2, color: "#b197fc" },
  { label: "steer DN  L", keys: STEER_TYPES.map(L), sample: 6, color: "#4dabf7" },
  { label: "steer DN  R", keys: STEER_TYPES.map(R), sample: 6, color: "#ff922b" },
  { label: "DNp01 escape", keys: ["DNp01_L", "DNp01_R"], sample: 2, color: "#ff6b81" },
  { label: "sugar GRN", keys: ["sugar_GRN_L", "sugar_GRN_R"], sample: 6, color: "#faa2c1" },
  { label: "proboscis MN", keys: ["proboscis_MN"], sample: 6, color: "#f06595" },
];

const CLASS_NAMES: Record<string, string> = {
  optic: "optic lobes",
  central: "central brain",
  sensory: "sensory",
  visual_projection: "visual projection",
  visual_centrifugal: "visual centrifugal",
  ascending: "ascending",
  descending: "descending",
  sensory_ascending: "sensory ascending",
  motor: "motor",
  endocrine: "endocrine",
  unknown: "unclassified",
};

const RASTER_WINDOW = 2500;
const TRACE_WINDOW = 8000;
/** every raster block gets at least this many px, so labels never collide */
const MIN_BLOCK_PX = 11;

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function setupCanvas(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const r = c.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = Math.max(1, Math.round(r.width * dpr));
  c.height = Math.max(1, Math.round(r.height * dpr));
  const ctx = c.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export class StatsPanel {
  private readonly info: ReadyInfo;
  private readonly el: Record<string, HTMLElement> = {};
  private readonly raster: HTMLCanvasElement;
  private readonly traces: HTMLCanvasElement;
  private rctx: CanvasRenderingContext2D;
  private tctx: CanvasRenderingContext2D;

  // raster
  private readonly rowOf: Int16Array;
  private readonly rowColor: string[] = [];
  private readonly rowBlock: number[] = [];
  private readonly blockRows: { block: RasterBlock; first: number; count: number }[] = [];
  private nRows = 0;
  private readonly evT = new Float64Array(30000);
  private readonly evRow = new Int16Array(30000);
  private evHead = 0;
  private evCount = 0;

  // traces
  private readonly trace: { t: number; steer: number; l: number; r: number }[] = [];

  // activity accounting
  private readonly classCount: Float64Array;
  private readonly classRate: Float64Array;
  private readonly classSize: Int32Array;
  private readonly typeCount: Float64Array;
  private readonly typeRate: Float64Array;
  private readonly typeSize: Int32Array;
  private readonly lastSpike: Float32Array;
  private readonly everFired: Uint8Array;
  private everCount = 0;
  private accumMs = 0;
  private brainRate = 0;
  private simNow = 0;
  private last: FrameResult | null = null;
  private derived: Derived | null = null;
  private domTimer = 0;
  private readonly groupRate: Record<string, number> = {};
  private readonly groupSize: Record<string, number> = {};

  constructor(info: ReadyInfo) {
    this.info = info;
    for (const id of [
      "dataset",
      "sim-time",
      "speed",
      "headroom",
      "brain-rate",
      "active-1s",
      "hot",
      "total",
      "ever",
      "calib",
      "pipeline",
      "classes",
      "types",
      "steer-value",
    ])
      this.el[id] = document.getElementById(id)!;
    this.raster = document.getElementById("raster") as HTMLCanvasElement;
    this.traces = document.getElementById("traces") as HTMLCanvasElement;
    this.rctx = setupCanvas(this.raster);
    this.tctx = setupCanvas(this.traces);

    const n = info.neurons;
    this.rowOf = new Int16Array(n).fill(-1);
    RASTER.forEach((block, bi) => {
      const ids: number[] = [];
      for (const k of block.keys) ids.push(...info.groups[k]);
      const pick = ids.slice(0, block.sample);
      this.blockRows.push({ block, first: this.nRows, count: pick.length });
      for (const i of pick) {
        this.rowOf[i] = this.nRows++;
        this.rowColor.push(block.color);
        this.rowBlock.push(bi);
      }
    });
    for (const [k, ids] of Object.entries(info.groups)) this.groupSize[k] = ids.length;

    this.classCount = new Float64Array(info.superclasses.length);
    this.classRate = new Float64Array(info.superclasses.length);
    this.classSize = new Int32Array(info.superclasses.length);
    for (let i = 0; i < n; i++) this.classSize[info.superclass[i]]++;
    this.typeCount = new Float64Array(info.types.length);
    this.typeRate = new Float64Array(info.types.length);
    this.typeSize = new Int32Array(info.types.length);
    for (let i = 0; i < n; i++) this.typeSize[info.typeIdx[i]]++;
    this.lastSpike = new Float32Array(n).fill(-1e9);
    this.everFired = new Uint8Array(n);

    const c = info.calibration;
    this.el.dataset.textContent =
      `${info.dataset} · ${fmt(info.neurons)} neurons · ${fmt(info.connections)} connections · ` +
      `${(info.synapses / 1e6).toFixed(1)}M synapses · LIF model (Shiu et al. 2024), dt ${info.dt} ms`;
    this.el.calib.textContent = `L ${fmt(c.respL)} / R ${fmt(c.respR)} sp/s at ${c.hz} Hz → R ×${c.gainR.toFixed(2)}`;
  }

  resize(): void {
    this.rctx = setupCanvas(this.raster);
    this.tctx = setupCanvas(this.traces);
  }

  onFrame(frame: FrameResult, d: Derived, groupCounts: Record<string, number>): void {
    this.last = frame;
    this.derived = d;
    const start = frame.simMs - frame.frameMs;
    this.simNow = frame.simMs;
    const { spikes, spikeT } = frame;
    const sc = this.info.superclass;
    const ty = this.info.typeIdx;
    for (let k = 0; k < spikes.length; k++) {
      const i = spikes[k];
      const t = start + spikeT[k];
      this.classCount[sc[i]]++;
      this.typeCount[ty[i]]++;
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
    const kk = 1 - Math.exp(-frame.frameMs / 250);
    this.brainRate += ((spikes.length * 1000) / frame.frameMs - this.brainRate) * kk;
    const kg = 1 - Math.exp(-frame.frameMs / 150);
    for (const [key, c] of Object.entries(groupCounts)) {
      const hz = (c * 1000) / frame.frameMs / Math.max(1, this.groupSize[key] ?? 1);
      const prev = this.groupRate[key] ?? 0;
      this.groupRate[key] = prev + (hz - prev) * kg;
    }
    this.accumMs += frame.frameMs;
    if (this.accumMs >= 250) {
      const a = 1 - Math.exp(-this.accumMs / 600);
      for (let c = 0; c < this.classCount.length; c++) {
        this.classRate[c] += ((this.classCount[c] * 1000) / this.accumMs - this.classRate[c]) * a;
        this.classCount[c] = 0;
      }
      for (let t = 0; t < this.typeCount.length; t++) {
        const v = (this.typeCount[t] * 1000) / this.accumMs;
        if (v > 0 || this.typeRate[t] > 0.01) this.typeRate[t] += (v - this.typeRate[t]) * a;
        this.typeCount[t] = 0;
      }
      this.accumMs = 0;
    }
    this.trace.push({ t: frame.simMs, steer: d.steer, l: d.rateL, r: d.rateR });
    while (this.trace.length && this.trace[0].t < frame.simMs - TRACE_WINDOW) this.trace.shift();
  }

  render(): void {
    this.drawRaster();
    this.drawTraces();
    const now = performance.now();
    if (now - this.domTimer > 125) {
      this.domTimer = now;
      this.updateDom();
    }
  }

  /** y offset and height of each raster row: rows share their block's height, blocks have a minimum height */
  private rowLayout(h: number): { y: Float32Array; hgt: Float32Array } {
    const blocks = this.blockRows;
    const total = blocks.reduce((s, b) => s + b.count, 0);
    const minTotal = blocks.length * MIN_BLOCK_PX;
    const free = Math.max(0, h - minTotal);
    const y = new Float32Array(this.nRows);
    const hgt = new Float32Array(this.nRows);
    let at = 0;
    for (const b of blocks) {
      const bh = MIN_BLOCK_PX + (free * b.count) / Math.max(1, total);
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
    const labelW = 100;
    const plotW = w - labelW - 6;
    const plotH = h - 14;
    const { y: rowY, hgt: rowH } = this.rowLayout(plotH);
    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.textBaseline = "middle";
    this.blockRows.forEach(({ block, first, count }, bi) => {
      if (!count) return;
      const y0 = rowY[first];
      const bh = rowY[first + count - 1] + rowH[first + count - 1] - y0;
      if (bi % 2 === 0) {
        ctx.fillStyle = "rgba(255,255,255,0.03)";
        ctx.fillRect(labelW, y0, plotW, bh);
      }
      ctx.fillStyle = block.color;
      ctx.globalAlpha = 0.85;
      ctx.textAlign = "right";
      ctx.fillText(block.label, labelW - 8, y0 + bh / 2);
      ctx.globalAlpha = 1;
    });
    const now = this.simNow;
    for (let k = 0; k < this.evCount; k++) {
      const idx = (this.evHead - 1 - k + this.evT.length) % this.evT.length;
      const age = now - this.evT[idx];
      if (age > RASTER_WINDOW) break;
      const x = labelW + plotW * (1 - age / RASTER_WINDOW);
      const row = this.evRow[idx];
      ctx.fillStyle = this.rowColor[row];
      ctx.fillRect(x, rowY[row] + 0.5, 1.6, Math.max(1.5, rowH[row] - 1));
    }
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.textAlign = "right";
    ctx.fillText("now", w - 4, h - 6);
    ctx.textAlign = "left";
    ctx.fillText(`−${RASTER_WINDOW / 1000} s`, labelW + 2, h - 6);
  }

  private drawTraces(): void {
    const ctx = this.tctx;
    const w = this.traces.clientWidth;
    const h = this.traces.clientHeight;
    ctx.clearRect(0, 0, w, h);
    if (!this.trace.length) return;
    const now = this.simNow;
    const mid = h * 0.5;
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();
    let maxRate = 300;
    for (const p of this.trace) maxRate = Math.max(maxRate, p.l, p.r);
    const line = (get: (p: (typeof this.trace)[number]) => number, color: string, width: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      this.trace.forEach((p, i) => {
        const x = w * (1 - (now - p.t) / TRACE_WINDOW);
        const y = get(p);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };
    line((p) => h - 2 - (p.l / maxRate) * (h - 6), "rgba(77,171,247,0.8)", 1.3);
    line((p) => h - 2 - (p.r / maxRate) * (h - 6), "rgba(255,146,43,0.8)", 1.3);
    line((p) => mid - Math.max(-1.4, Math.min(1.4, p.steer)) * (h * 0.33), "#f8f9fa", 1.8);
    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillStyle = "#4dabf7";
    ctx.fillText("steer DN L, sp/s", 6, 4);
    ctx.fillStyle = "#ff922b";
    ctx.fillText("steer DN R, sp/s", 124, 4);
    ctx.fillStyle = "#f8f9fa";
    ctx.fillText("steering = R − L", 242, 4);
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.textAlign = "right";
    ctx.fillText(`${TRACE_WINDOW / 1000} s`, w - 4, 4);
  }

  private bar(label: string, value: number, max: number, color: string, unit = "Hz", title = ""): string {
    const pct = Math.max(0, Math.min(100, (value / max) * 100));
    return `<div class="meter" title="${title}"><span class="m-label">${label}</span><span class="m-track"><span class="m-fill" style="width:${pct.toFixed(1)}%;background:${color}"></span></span><span class="m-val">${value >= 10 ? Math.round(value) : value.toFixed(1)} ${unit}</span></div>`;
  }

  private pair(label: string, l: number, r: number, max: number, cl: string, cr: string, unit = "Hz", title = ""): string {
    const pl = Math.max(0, Math.min(100, (l / max) * 100));
    const pr = Math.max(0, Math.min(100, (r / max) * 100));
    const v = (x: number) => (x >= 10 ? Math.round(x) : x.toFixed(1));
    return `<div class="pair" title="${title}"><span class="m-label">${label}</span><span class="p-val l">${v(l)}</span><span class="p-track l"><span style="width:${pl.toFixed(1)}%;background:${cl}"></span></span><span class="p-track r"><span style="width:${pr.toFixed(1)}%;background:${cr}"></span></span><span class="p-val r">${v(r)}</span><span class="p-unit">${unit}</span></div>`;
  }

  private updateDom(): void {
    const f = this.last;
    const d = this.derived;
    if (!f || !d) return;
    const g = this.groupRate;
    const s = f.simMs / 1000;
    const mm = Math.floor(s / 60);
    this.el["sim-time"].textContent = `${mm}:${(s % 60).toFixed(1).padStart(4, "0")}`;
    this.el.speed.textContent = d.paused ? "paused" : `×${d.gameSpeed.toFixed(2)}`;
    this.el.headroom.textContent = `×${(f.frameMs / Math.max(0.05, f.wallMs)).toFixed(1)}`;
    this.el["brain-rate"].textContent = fmt(this.brainRate);
    let active = 0;
    const cut = f.simMs - 1000;
    for (let i = 0; i < this.lastSpike.length; i++) if (this.lastSpike[i] > cut) active++;
    this.el["active-1s"].textContent = fmt(active);
    this.el.hot.textContent = fmt(f.active);
    this.el.total.textContent = fmt(f.totalSpikes);
    this.el.ever.textContent = `${fmt(this.everCount)} (${((100 * this.everCount) / this.info.neurons).toFixed(1)}%)`;

    const inp = d.input;
    const side = d.steer < -0.1 ? "◀ left" : d.steer > 0.1 ? "right ▶" : "straight";
    this.el["steer-value"].textContent = `${side}  ${d.steer >= 0 ? "+" : ""}${d.steer.toFixed(2)}`;
    this.el["steer-value"].className = d.steer < -0.1 ? "left" : d.steer > 0.1 ? "right" : "";
    const aotuL = ((g.AOTU019_L ?? 0) + (g.AOTU025_L ?? 0)) / 2;
    const aotuR = ((g.AOTU019_R ?? 0) + (g.AOTU025_R ?? 0)) / 2;
    const gf = ((g.DNp01_L ?? 0) + (g.DNp01_R ?? 0)) / 2;
    const sugar = ((g.sugar_GRN_L ?? 0) + (g.sugar_GRN_R ?? 0)) / 2;
    this.el.pipeline.innerHTML = [
      `<div class="stage">eyes · input</div>`,
      this.pair("LC10a drive", inp.lc10L, inp.lc10R, 80, "#5ee7ff", "#5ee7ff", "Hz", "Poisson drive of LC10a: target on the left or on the right"),
      this.pair("LC10a spikes", g.LC10a_L ?? 0, g.LC10a_R ?? 0, 80, "#22b8cf", "#22b8cf", "Hz", "Mean rate per LC10a neuron (115 left, 119 right)"),
      `<div class="stage">brain · connectome</div>`,
      this.pair("AOTU019/025", aotuL, aotuR, 250, "#b197fc", "#b197fc", "Hz", "Anterior optic tubercle relays between LC10a and the descending neurons"),
      this.pair("DNa02", g.DNa02_L ?? 0, g.DNa02_R ?? 0, 150, "#4dabf7", "#ff922b", "Hz", "Known steering neuron (Rayshubskiy et al. 2020)"),
      this.pair("steer DN Σ", d.rateL, d.rateR, 500, "#4dabf7", "#ff922b", "sp/s", STEER_TYPES.join(", ")),
      `<div class="stage">body · output</div>`,
      this.bar("DNp01 escape", gf, 250, "#ff6b81", "Hz", "Giant fibre: responds to looming (the fly is falling)"),
      this.bar("sugar GRN", sugar, 160, "#faa2c1", "Hz", "Sugar-sensing gustatory neurons (driven when the fly eats a sugar cube)"),
      this.bar("proboscis MN", g.proboscis_MN ?? 0, 40, "#f06595", "Hz", "Proboscis motor neurons (24 cells)"),
    ].join("");

    // super-class activity (log bars)
    const rows: string[] = [];
    const order = [...this.classRate.keys()].filter((c) => this.classSize[c] > 0).sort((a, b) => this.classRate[b] - this.classRate[a]);
    const maxLog = Math.log10(1 + Math.max(10, ...this.classRate));
    for (const c of order) {
      const name = this.info.superclasses[c];
      const v = this.classRate[c];
      const pct = (Math.log10(1 + v) / maxLog) * 100;
      rows.push(
        `<div class="cls"><span class="c-name">${CLASS_NAMES[name] ?? name}</span><span class="c-track"><span style="width:${pct.toFixed(1)}%"></span></span><span class="c-val">${fmt(v)}</span></div>`,
      );
    }
    this.el.classes.innerHTML = rows.join("");

    // most active cell types
    const top: number[] = [];
    for (let t = 1; t < this.typeRate.length; t++) if (this.typeRate[t] >= 1) top.push(t);
    top.sort((a, b) => this.typeRate[b] - this.typeRate[a]);
    this.el.types.innerHTML = top
      .slice(0, 9)
      .map((t) => {
        const perNeuron = this.typeRate[t] / Math.max(1, this.typeSize[t]);
        return `<div class="type"><span class="t-name">${this.info.types[t]}</span><span class="t-n">×${this.typeSize[t]}</span><span class="t-val">${perNeuron >= 10 ? Math.round(perNeuron) : perNeuron.toFixed(1)} Hz</span></div>`;
      })
      .join("");
  }
}

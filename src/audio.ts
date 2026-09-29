// Synthesized sound effects (Web Audio, no samples). Browsers keep audio locked until the first click or key.

const MUTE_KEY = "doodle-fly:muted";
const VOLUME = 0.55;

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buzzGain: GainNode | null = null;
  private readonly last: Record<string, number> = {};
  muted = false;

  constructor() {
    try {
      this.muted = localStorage.getItem(MUTE_KEY) === "1";
    } catch {
      this.muted = false;
    }
  }

  get unlocked(): boolean {
    return this.ctx?.state === "running";
  }

  /** call from a user gesture */
  unlock(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : VOLUME;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.ratio.value = 4;
      this.master.connect(comp).connect(this.ctx.destination);
      this.startBuzz();
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    try {
      localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
    } catch {
      /* private mode: fine, just not remembered */
    }
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(muted ? 0 : VOLUME, this.ctx.currentTime, 0.03);
  }

  private ready(key: string, minMs: number): AudioContext | null {
    if (!this.ctx || this.ctx.state !== "running" || this.muted) return null;
    const now = performance.now();
    if (now - (this.last[key] ?? -1e9) < minMs) return null;
    this.last[key] = now;
    return this.ctx;
  }

  private out(ctx: AudioContext, pan: number): AudioNode {
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(this.master!);
    return p;
  }

  private tone(
    ctx: AudioContext,
    dest: AudioNode,
    type: OscillatorType,
    f0: number,
    f1: number,
    t0: number,
    dur: number,
    vol: number,
  ): OscillatorNode {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + Math.min(0.01, dur / 4));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(dest);
    o.start(t0);
    o.stop(t0 + dur + 0.03);
    return o;
  }

  private noise(ctx: AudioContext, dest: AudioNode, t0: number, dur: number, vol: number, type: BiquadFilterType, freq: number, q = 0.8): void {
    const len = Math.max(1, Math.ceil(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(dest);
    src.start(t0);
  }

  /** landing on a platform */
  bounce(pan = 0): void {
    const ctx = this.ready("bounce", 45);
    if (!ctx) return;
    const t = ctx.currentTime;
    const dest = this.out(ctx, pan);
    this.tone(ctx, dest, "sine", 300, 720, t, 0.12, 0.32);
    this.tone(ctx, dest, "triangle", 620, 1500, t, 0.05, 0.07);
  }

  /** big spring launch */
  spring(pan = 0): void {
    const ctx = this.ready("spring", 80);
    if (!ctx) return;
    const t = ctx.currentTime;
    const dest = this.out(ctx, pan);
    const o = this.tone(ctx, dest, "sine", 160, 640, t, 0.42, 0.38);
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.frequency.value = 26;
    depth.gain.value = 55;
    lfo.connect(depth).connect(o.frequency);
    lfo.start(t);
    lfo.stop(t + 0.45);
    this.tone(ctx, dest, "triangle", 320, 1280, t, 0.3, 0.08);
  }

  /** brown platform crumbling */
  crack(pan = 0): void {
    const ctx = this.ready("crack", 60);
    if (!ctx) return;
    const t = ctx.currentTime;
    const dest = this.out(ctx, pan);
    this.noise(ctx, dest, t, 0.14, 0.55, "bandpass", 1500, 0.9);
    this.noise(ctx, dest, t + 0.03, 0.25, 0.4, "lowpass", 420, 0.7);
    this.tone(ctx, dest, "square", 170, 55, t, 0.14, 0.05);
  }

  /** eating a sugar cube */
  sugar(pan = 0): void {
    const ctx = this.ready("sugar", 120);
    if (!ctx) return;
    const t = ctx.currentTime;
    const dest = this.out(ctx, pan);
    [1318.5, 1568, 1975.5, 2637].forEach((f, i) => {
      this.tone(ctx, dest, "triangle", f, f * 1.001, t + i * 0.065, 0.28, 0.16);
      this.tone(ctx, dest, "sine", f * 2, f * 2.002, t + i * 0.065, 0.18, 0.04);
    });
  }

  /** falling off the bottom */
  fall(): void {
    const ctx = this.ready("fall", 500);
    if (!ctx) return;
    const t = ctx.currentTime;
    const dest = this.out(ctx, 0);
    const o = this.tone(ctx, dest, "sine", 900, 110, t, 1.25, 0.26);
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.frequency.value = 6;
    depth.gain.value = 22;
    lfo.connect(depth).connect(o.frequency);
    lfo.start(t);
    lfo.stop(t + 1.3);
  }

  /** a new game starts */
  restart(): void {
    const ctx = this.ready("restart", 500);
    if (!ctx) return;
    const t = ctx.currentTime;
    const dest = this.out(ctx, 0);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 2400;
    lp.connect(dest);
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(ctx, lp, "square", f, f, t + i * 0.08, 0.14, 0.07));
  }

  /** arcade button pressed by the 3D fly */
  click(pan = 0): void {
    const ctx = this.ready(`click${pan}`, 70);
    if (!ctx) return;
    const t = ctx.currentTime;
    const dest = this.out(ctx, pan);
    this.noise(ctx, dest, t, 0.03, 0.22, "highpass", 2600, 0.7);
    this.tone(ctx, dest, "square", 1700, 800, t, 0.035, 0.045);
  }

  /** continuous wing buzz, level 0..1 */
  buzz(level: number): void {
    if (!this.ctx || !this.buzzGain) return;
    this.buzzGain.gain.setTargetAtTime(this.muted ? 0 : level * 0.1, this.ctx.currentTime, 0.06);
  }

  private startBuzz(): void {
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1100;
    this.buzzGain = ctx.createGain();
    this.buzzGain.gain.value = 0;
    const trem = ctx.createGain();
    trem.gain.value = 0.7;
    const lfo = ctx.createOscillator();
    const lfoDepth = ctx.createGain();
    lfo.frequency.value = 33;
    lfoDepth.gain.value = 0.3;
    lfo.connect(lfoDepth).connect(trem.gain);
    for (const f of [196, 203]) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = f;
      o.connect(lp);
      o.start();
    }
    lp.connect(trem).connect(this.buzzGain).connect(this.master!);
    lfo.start();
  }
}

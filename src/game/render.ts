// Notebook-paper rendering of the game (own artwork, Doodle-Jump-like look).
import { drawFly, type FlyPose } from "./fly2d.ts";
import { PLATFORM_H, type DoodleGame, type Platform } from "./game.ts";

const PAPER = "#fbf6e8";
const GRID = "#e6dcc1";
const INK = "#2a1c0f";
const HUD_H = 54;

const PALETTE: Record<Platform["kind"], { fill: string; shade: string; light: string; ink: string }> = {
  normal: { fill: "#84c64a", shade: "#5c9b2d", light: "#c4ec8e", ink: "#26390f" },
  moving: { fill: "#63b6ea", shade: "#3a86c1", light: "#b3e1fb", ink: "#15324a" },
  breaking: { fill: "#b78b56", shade: "#8a6536", light: "#dcbb8a", ink: "#3d2912" },
  vanish: { fill: "#f7f5ee", shade: "#d3d0c4", light: "#ffffff", ink: "#5a574d" },
};

export interface RenderExtras {
  /** proboscis extension from proboscis motor neurons, 0..1 */
  proboscis: number;
  /** giant fibre activity, 0..1 */
  startle: number;
  showTarget: boolean;
}

function rand(seed: number, k: number): number {
  const x = Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export class GameRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  /** px per world unit, and left offset of the play field */
  scale = 1;
  x0 = 0;
  private wingPhase = 0;
  private legs = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
  }

  /** returns the world width that fits the canvas */
  resize(viewH: number): number {
    const r = this.canvas.getBoundingClientRect();
    this.cssW = Math.max(1, r.width);
    this.cssH = Math.max(1, r.height);
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    const worldW = Math.min(760, Math.max(420, (viewH * this.cssW) / this.cssH));
    this.scale = Math.min(this.cssH / viewH, this.cssW / worldW);
    this.x0 = (this.cssW - worldW * this.scale) / 2;
    return worldW;
  }

  draw(game: DoodleGame, dt: number, extras: RenderExtras): void {
    const { ctx } = this;
    const s = this.scale;
    const top = game.cameraY + game.H;
    const sx = (x: number) => this.x0 + x * s;
    const sy = (y: number) => (top - y) * s;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // paper + grid (scrolls with the camera)
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const step = 20;
    const firstY = Math.floor(game.cameraY / step) * step;
    for (let y = firstY; y <= top + step; y += step) {
      const py = Math.round(sy(y)) + 0.5;
      ctx.moveTo(0, py);
      ctx.lineTo(this.cssW, py);
    }
    for (let x = -Math.ceil(this.x0 / s / step) * step; sx(x) <= this.cssW; x += step) {
      const px = Math.round(sx(x)) + 0.5;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, this.cssH);
    }
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.rect(this.x0, 0, game.W * s, this.cssH);
    ctx.clip();

    // target the eyes are locked on
    const t = game.sense.target;
    if (extras.showTarget && t && game.fly.alive) {
      ctx.save();
      ctx.setLineDash([5, 6]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(217, 72, 15, 0.55)";
      ctx.beginPath();
      ctx.ellipse(sx(t.x), sy(t.y) + (PLATFORM_H * s) / 2, (t.w / 2 + 12) * s, (PLATFORM_H + 12) * s * 0.7, 0, 0, Math.PI * 2);
      ctx.stroke();
      const fx = game.fly.x;
      const fy = game.fly.y + 36;
      const tx = fx + game.sense.dx;
      ctx.beginPath();
      ctx.moveTo(sx(fx), sy(fy));
      ctx.quadraticCurveTo(sx((fx + tx) / 2), sy(Math.max(fy, t.y) + 40), sx(tx), sy(t.y + 20));
      ctx.stroke();
      ctx.restore();
    }

    for (const p of game.platforms) {
      const y = sy(p.y);
      if (y < -40 || y > this.cssH + 60) continue;
      this.platform(p, sx(p.x), y, s);
    }

    this.fly(game, dt, extras, sx, sy);

    // popups
    ctx.textAlign = "center";
    for (const p of game.popups) {
      const a = 1 - p.t / 1.2;
      ctx.globalAlpha = Math.max(0, a);
      ctx.font = `${Math.round(22 * s)}px Pangolin, "Comic Sans MS", cursive`;
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, sx(p.x), sy(p.y + p.t * 60));
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    this.hud(game);
  }

  private platform(p: Platform, cx: number, y: number, s: number): void {
    const { ctx } = this;
    const pal = PALETTE[p.kind];
    const w = p.w * s;
    const h = PLATFORM_H * s;

    if (p.broken >= 0 && p.kind === "breaking") {
      // two halves tumbling down
      const tt = p.broken;
      for (const side of [-1, 1]) {
        ctx.save();
        ctx.translate(cx + side * (w / 4 + tt * 40 * s), y + tt * tt * 900 * s * 0.5);
        ctx.rotate(side * tt * 2.2);
        ctx.globalAlpha = Math.max(0, 1 - tt / 1.4);
        this.slab(-w / 4, 0, w / 2, h, pal, p.seed + side);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      return;
    }
    if (p.gone) {
      if (p.broken >= 0 && p.broken < 0.35) {
        ctx.globalAlpha = 1 - p.broken / 0.35;
        this.slab(cx - w / 2, y - p.broken * 30 * s, w, h, pal, p.seed);
        ctx.globalAlpha = 1;
      }
      return;
    }
    this.slab(cx - w / 2, y, w, h, pal, p.seed);
    if (p.kind === "breaking") {
      ctx.strokeStyle = pal.ink;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      const k = rand(p.seed, 3) * 0.3 + 0.35;
      ctx.moveTo(cx - w / 2 + w * k, y + 2);
      ctx.lineTo(cx - w / 2 + w * k + 4, y + h * 0.5);
      ctx.lineTo(cx - w / 2 + w * k - 2, y + h - 2);
      ctx.moveTo(cx + w * 0.22, y + 3);
      ctx.lineTo(cx + w * 0.26, y + h * 0.6);
      ctx.stroke();
    }
    if (p.spring) this.spring(cx + p.spring.dx * s, y, s, p.spring.t);
    if (p.sugar && !p.sugar.taken) this.sugar(cx + p.w * 0.18 * s, y, s, p.seed);
  }

  /** wobbly, hand-inked rounded slab */
  private slab(x: number, y: number, w: number, h: number, pal: (typeof PALETTE)["normal"], seed: number): void {
    const { ctx } = this;
    const j = (k: number) => (rand(seed, k) - 0.5) * 1.6;
    const r = h / 2;
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(x + r, y + j(1));
      ctx.lineTo(x + w - r, y + j(2));
      ctx.quadraticCurveTo(x + w + j(3), y, x + w + j(4), y + r);
      ctx.quadraticCurveTo(x + w + j(5), y + h, x + w - r, y + h + j(6));
      ctx.lineTo(x + r, y + h + j(7));
      ctx.quadraticCurveTo(x + j(8), y + h, x + j(9), y + r);
      ctx.quadraticCurveTo(x + j(10), y, x + r, y + j(1));
      ctx.closePath();
    };
    path();
    ctx.fillStyle = pal.fill;
    ctx.fill();
    ctx.save();
    path();
    ctx.clip();
    ctx.fillStyle = pal.shade;
    ctx.fillRect(x, y + h * 0.58, w, h);
    ctx.strokeStyle = pal.light;
    ctx.lineWidth = Math.max(1.5, h * 0.16);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x + r * 0.9, y + h * 0.3);
    ctx.lineTo(x + w * 0.62, y + h * 0.3);
    ctx.stroke();
    ctx.restore();
    path();
    ctx.strokeStyle = pal.ink;
    ctx.lineWidth = 2.2;
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  private spring(x: number, y: number, s: number, t: number): void {
    const { ctx } = this;
    // extended right after use, then settles
    const ext = t < 0 ? 0 : Math.max(0, 1 - t / 0.4);
    const hgt = (12 + 14 * ext) * s;
    const w = 14 * s;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.beginPath();
    const turns = 4;
    for (let i = 0; i <= turns * 2; i++) {
      const px = x + (i % 2 === 0 ? -w / 2 : w / 2);
      const py = y - (hgt * i) / (turns * 2);
      if (i === 0) ctx.moveTo(x - w / 2, y);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.strokeStyle = "#9aa3ad";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#c7ced6";
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x - w * 0.75, y - hgt - 4 * s, w * 1.5, 5 * s, 2 * s);
    ctx.fill();
    ctx.stroke();
  }

  private sugar(x: number, y: number, s: number, seed: number): void {
    const { ctx } = this;
    const a = 7 * s;
    const bob = Math.sin(performance.now() / 300 + seed) * 1.5 * s;
    const by = y - 2 * s + bob;
    ctx.lineJoin = "round";
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = "#4b6784";
    // left, right, top faces of a little cube
    ctx.fillStyle = "#e4ecf5";
    ctx.beginPath();
    ctx.moveTo(x - a, by - a * 1.1);
    ctx.lineTo(x, by - a * 0.6);
    ctx.lineTo(x, by + a * 0.1);
    ctx.lineTo(x - a, by - a * 0.35);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#cfdbe8";
    ctx.beginPath();
    ctx.moveTo(x + a, by - a * 1.1);
    ctx.lineTo(x, by - a * 0.6);
    ctx.lineTo(x, by + a * 0.1);
    ctx.lineTo(x + a, by - a * 0.35);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(x - a, by - a * 1.1);
    ctx.lineTo(x, by - a * 1.6);
    ctx.lineTo(x + a, by - a * 1.1);
    ctx.lineTo(x, by - a * 0.6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // sparkle
    const tw = (Math.sin(performance.now() / 180 + seed * 3) + 1) / 2;
    ctx.strokeStyle = `rgba(245, 158, 11, ${0.4 + 0.6 * tw})`;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    const cx = x + a * 1.2;
    const cy = by - a * 1.9;
    const r = (2 + 2.5 * tw) * s;
    ctx.moveTo(cx - r, cy);
    ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx, cy + r);
    ctx.stroke();
  }

  private fly(
    game: DoodleGame,
    dt: number,
    extras: RenderExtras,
    sx: (x: number) => number,
    sy: (y: number) => number,
  ): void {
    const f = game.fly;
    const rising = f.vy > 0;
    const buzz = f.vy > 700 ? 1 : f.vy > 250 ? 0.55 : rising ? 0.25 : 0.12;
    this.wingPhase += dt * (buzz > 0.5 ? 55 : 14);
    const wantLegs = !rising || f.vy < 250 ? 1 : 0.15;
    this.legs += (wantLegs - this.legs) * Math.min(1, dt * 10);
    const look = game.sense.target ? Math.max(-1, Math.min(1, (game.sense.dx * f.facing) / 120)) : 0;
    const pose: FlyPose = {
      facing: f.facing,
      legs: this.legs,
      wingPhase: this.wingPhase,
      wingAmp: buzz,
      squash: f.squash,
      proboscis: extras.proboscis,
      look,
      startle: extras.startle,
      dead: !f.alive,
    };
    const draw = (x: number) => {
      const { ctx } = this;
      ctx.save();
      ctx.translate(sx(x), sy(f.y));
      ctx.scale(this.scale, -this.scale);
      if (!f.alive) ctx.rotate(f.deadT * 3);
      drawFly(ctx, pose);
      ctx.restore();
    };
    draw(f.x);
    // wrap-around ghost at the edges
    if (f.x < 45) draw(f.x + game.W);
    if (f.x > game.W - 45) draw(f.x - game.W);
  }

  private hud(game: DoodleGame): void {
    const { ctx } = this;
    const w = this.cssW;
    // torn paper strip
    ctx.fillStyle = "rgba(242, 232, 206, 0.93)";
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(w, 0);
    ctx.lineTo(w, HUD_H);
    for (let x = w; x >= 0; x -= 14) ctx.lineTo(x, HUD_H + (Math.floor(x / 14) % 2 ? 5 : -2));
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(90, 70, 40, 0.35)";
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.fillStyle = INK;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.font = `34px Pangolin, "Comic Sans MS", cursive`;
    ctx.fillText(String(game.score), 18, HUD_H / 2 + 2);
    ctx.textAlign = "right";
    ctx.font = `17px Pangolin, "Comic Sans MS", cursive`;
    ctx.fillText(`best ${Math.max(game.best, game.score)}   ·   game #${game.games + 1}`, w - 16, HUD_H / 2 + 1);

    if (!game.fly.alive) {
      const a = Math.min(1, game.fly.deadT * 2);
      ctx.globalAlpha = a;
      ctx.textAlign = "center";
      ctx.font = `46px Pangolin, "Comic Sans MS", cursive`;
      ctx.fillStyle = "#b91c1c";
      ctx.fillText("oops, fell!", w / 2, this.cssH * 0.42);
      ctx.font = `22px Pangolin, "Comic Sans MS", cursive`;
      ctx.fillStyle = INK;
      ctx.fillText(`score ${game.score} · best ${game.best}`, w / 2, this.cssH * 0.42 + 44);
      ctx.globalAlpha = 1;
    }
  }
}

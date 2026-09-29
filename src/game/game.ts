// Doodle-Jump-style platformer. World units, y = height (up is positive), x wraps around.

export const GRAVITY = 1650;
export const JUMP_V = 880;
export const SPRING_V = 1520;
export const VX_MAX = 400;
/** horizontal velocity follows the motor command with this time constant (s) */
const VX_TAU = 0.09;
export const PLATFORM_W = 78;
export const PLATFORM_H = 16;
export const FLY_HALF_W = 16;
export const VIEW_H = 720;

export type PlatformKind = "normal" | "moving" | "breaking" | "vanish";

export interface Platform {
  id: number;
  x: number;
  y: number;
  w: number;
  kind: PlatformKind;
  vx: number;
  minX: number;
  maxX: number;
  seed: number;
  broken: number; // time since broken (s), -1 = intact
  gone: boolean;
  spring: { dx: number; t: number } | null; // t: time since used (s), -1 = never
  sugar: { taken: boolean } | null;
  /** not a target until this game time (s): the fly got "bored" bouncing on it */
  bannedUntil: number;
}

export interface Fly {
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: 1 | -1;
  squash: number;
  alive: boolean;
  deadT: number;
}

export type GameEvent =
  | { kind: "bounce"; platform: Platform }
  | { kind: "spring"; platform: Platform }
  | { kind: "break"; platform: Platform }
  | { kind: "sugar"; platform: Platform }
  | { kind: "fall" }
  | { kind: "restart" };

export interface Popup {
  x: number;
  y: number;
  text: string;
  t: number;
  color: string;
}

export interface Sense {
  target: Platform | null;
  /** wrapped horizontal offset target - fly */
  dx: number;
  /** falling with nowhere to land */
  danger: boolean;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function wrapDelta(d: number, w: number): number {
  d %= w;
  if (d > w / 2) d -= w;
  if (d < -w / 2) d += w;
  return d;
}

export class DoodleGame {
  W = 640;
  readonly H = VIEW_H;
  platforms: Platform[] = [];
  fly!: Fly;
  cameraY = 0;
  maxY = 0;
  score = 0;
  best = 0;
  games = 0;
  jumps = 0;
  sugars = 0;
  time = 0;
  sense: Sense = { target: null, dx: 0, danger: false };
  popups: Popup[] = [];
  private events: GameEvent[] = [];
  private rand = mulberry32(1);
  private nextId = 1;
  private pathY = 0;
  private pathX = 0;
  private restartIn = -1;
  private lastBounceId = -1;
  private sameBounces = 0;

  constructor(width = 640, seed = 7) {
    this.W = width;
    this.rand = mulberry32(seed);
    this.reset();
  }

  setWidth(w: number): void {
    if (Math.abs(w - this.W) < 1) return;
    const k = w / this.W;
    for (const p of this.platforms) {
      p.x *= k;
      p.minX *= k;
      p.maxX *= k;
    }
    this.fly.x *= k;
    this.pathX *= k;
    this.W = w;
  }

  reset(): void {
    this.platforms = [];
    this.popups = [];
    this.cameraY = 0;
    this.maxY = 0;
    this.score = 0;
    this.time = 0;
    this.fly = { x: this.W / 2, y: 40, vx: 0, vy: JUMP_V, facing: 1, squash: 0, alive: true, deadT: 0 };
    // a wide floor and a gentle start
    this.pathY = 20;
    this.pathX = this.W / 2;
    this.add({ x: this.W / 2, y: 20, kind: "normal" });
    this.generate();
  }

  takeEvents(): GameEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  private add(p: Partial<Platform> & { x: number; y: number; kind: PlatformKind }): Platform {
    const w = p.w ?? PLATFORM_W;
    const plat: Platform = {
      id: this.nextId++,
      w,
      vx: 0,
      minX: w / 2,
      maxX: this.W - w / 2,
      seed: Math.floor(this.rand() * 1e9),
      broken: -1,
      gone: false,
      spring: null,
      sugar: null,
      bannedUntil: 0,
      ...p,
    };
    this.platforms.push(plat);
    return plat;
  }

  /** difficulty 0..1 by height */
  private get difficulty(): number {
    return Math.min(1, this.pathY / 30000);
  }

  /** how far sideways the fly can travel while climbing `gap` (conservative) */
  private static reachFor(gap: number): number {
    const disc = JUMP_V * JUMP_V - 2 * GRAVITY * gap;
    const t = (JUMP_V + Math.sqrt(Math.max(0, disc))) / GRAVITY;
    return VX_MAX * Math.max(0, t - 0.15) * 0.75;
  }

  private generate(): void {
    const top = this.cameraY + this.H + 240;
    while (this.pathY < top) {
      const d = this.difficulty;
      const r = this.rand;
      const apex = (JUMP_V * JUMP_V) / (2 * GRAVITY);
      const gap = Math.min(apex * 0.85, 58 + 26 * d + r() * (40 + 100 * d));
      this.pathY += gap;
      // guaranteed path: next platform within reach horizontally
      const reach = Math.min(110 + 140 * d, DoodleGame.reachFor(gap));
      let x = this.pathX + (r() * 2 - 1) * reach;
      x = ((x % this.W) + this.W) % this.W;
      x = Math.min(this.W - PLATFORM_W / 2, Math.max(PLATFORM_W / 2, x));
      this.pathX = x;

      let kind: PlatformKind = "normal";
      const roll = r();
      if (this.pathY > 1800 && roll < 0.1 + 0.25 * d) kind = "moving";
      else if (this.pathY > 5000 && roll < 0.1 + 0.25 * d + 0.08 * d) kind = "vanish";
      const p = this.add({ x, y: this.pathY, kind });
      if (kind === "moving") {
        const span = 80 + 160 * r();
        p.minX = Math.max(PLATFORM_W / 2, x - span);
        p.maxX = Math.min(this.W - PLATFORM_W / 2, x + span);
        p.vx = (r() < 0.5 ? -1 : 1) * (60 + 90 * d);
      }
      if (kind === "normal") {
        const s = r();
        if (s < 0.07) p.spring = { dx: (r() * 2 - 1) * (PLATFORM_W / 2 - 14), t: -1 };
        else if (s < 0.17) p.sugar = { taken: false };
      }

      // decoys: brown platforms that crumble
      if (this.pathY > 900 && r() < 0.18 + 0.35 * d) {
        const by = this.pathY - gap * (0.3 + 0.4 * r());
        let bx = r() * this.W;
        for (let tries = 0; tries < 6 && Math.abs(wrapDelta(bx - x, this.W)) < PLATFORM_W * 1.3; tries++)
          bx = r() * this.W;
        bx = Math.min(this.W - PLATFORM_W / 2, Math.max(PLATFORM_W / 2, bx));
        this.add({ x: bx, y: by, kind: "breaking" });
      }
      // extra normal platforms early on make the start friendlier; each one can still reach the path
      if (d < 0.35 && r() < 0.35 - d) {
        const off = (r() < 0.5 ? -1 : 1) * (PLATFORM_W * 1.5 + r() * (reach - PLATFORM_W * 1.5));
        let ex = (((x + off) % this.W) + this.W) % this.W;
        ex = Math.min(this.W - PLATFORM_W / 2, Math.max(PLATFORM_W / 2, ex));
        if (Math.abs(wrapDelta(ex - x, this.W)) > PLATFORM_W * 1.2) this.add({ x: ex, y: this.pathY - gap * 0.5, kind: "normal" });
      }
    }
    const bottom = this.cameraY - 140;
    this.platforms = this.platforms.filter((p) => p.y > bottom && !(p.gone && p.broken > 2));
  }

  /** Pick the platform the fly should aim for: the highest one it can still reach when it comes down. */
  private chooseTarget(): Sense {
    const f = this.fly;
    const apex = f.vy > 0 ? f.y + (f.vy * f.vy) / (2 * GRAVITY) : f.y;
    let best: Platform | null = null;
    let bestScore = -Infinity;
    let bestDx = 0;
    let anyReachable = false;
    for (const p of this.platforms) {
      if (p.gone || p.kind === "breaking" || p.bannedUntil > this.time) continue;
      if (p.y > apex - 6 || p.y < this.cameraY - 4) continue;
      const disc = f.vy * f.vy + 2 * GRAVITY * (f.y - p.y);
      if (disc < 0) continue;
      const t = (f.vy + Math.sqrt(disc)) / GRAVITY;
      let px = p.x;
      if (p.kind === "moving") px = this.predictMoving(p, t);
      const dx = wrapDelta(px - f.x, this.W);
      const reach = VX_MAX * Math.max(0, t - 0.15) * 0.88 + p.w / 2;
      const reachable = Math.abs(dx) <= reach;
      if (reachable) anyReachable = true;
      // height first; distance only breaks near-ties
      let score = p.y - Math.abs(dx) * 0.1;
      if (reachable) score += 1e6;
      if (p === this.sense.target) score += 12;
      if (p.spring && p.spring.t < 0) score += 70;
      if (p.sugar && !p.sugar.taken) score += 45;
      if (score > bestScore) {
        bestScore = score;
        best = p;
        bestDx = dx;
      }
    }
    return { target: best, dx: bestDx, danger: f.vy < 0 && !anyReachable };
  }

  private predictMoving(p: Platform, t: number): number {
    let x = p.x;
    let vx = p.vx;
    let left = t;
    for (let i = 0; i < 4 && left > 0; i++) {
      const edge = vx > 0 ? p.maxX : p.minX;
      const tt = (edge - x) / vx;
      if (tt >= left) {
        x += vx * left;
        break;
      }
      x = edge;
      vx = -vx;
      left -= tt;
    }
    return x;
  }

  /** Advance by dt seconds. `steer` in [-1, 1] is the motor command (left < 0 < right). */
  step(dt: number, steer: number): void {
    this.time += dt;
    const f = this.fly;

    for (const p of this.platforms) {
      if (p.kind === "moving" && p.broken < 0) {
        p.x += p.vx * dt;
        if (p.x < p.minX) {
          p.x = p.minX;
          p.vx = Math.abs(p.vx);
        } else if (p.x > p.maxX) {
          p.x = p.maxX;
          p.vx = -Math.abs(p.vx);
        }
      }
      if (p.broken >= 0) p.broken += dt;
      if (p.spring && p.spring.t >= 0) p.spring.t += dt;
    }
    for (const pop of this.popups) pop.t += dt;
    this.popups = this.popups.filter((p) => p.t < 1.2);

    if (!f.alive) {
      f.deadT += dt;
      f.vy -= GRAVITY * dt;
      f.y += f.vy * dt;
      if (this.restartIn > 0) {
        this.restartIn -= dt;
        if (this.restartIn <= 0) {
          this.restartIn = -1;
          this.reset();
          this.events.push({ kind: "restart" });
        }
      }
      return;
    }

    const cmd = Math.max(-1, Math.min(1, steer)) * VX_MAX;
    f.vx += (cmd - f.vx) * (1 - Math.exp(-dt / VX_TAU));
    if (Math.abs(f.vx) > 25) f.facing = f.vx > 0 ? 1 : -1;
    f.x = (((f.x + f.vx * dt) % this.W) + this.W) % this.W;

    const prevY = f.y;
    f.vy -= GRAVITY * dt;
    f.y += f.vy * dt;
    f.squash = Math.max(0, f.squash - dt * 4);

    if (f.vy < 0) {
      for (const p of this.platforms) {
        if (p.gone || p.broken >= 0) continue;
        if (prevY >= p.y && f.y <= p.y && Math.abs(wrapDelta(f.x - p.x, this.W)) <= p.w / 2 + FLY_HALF_W) {
          if (p.kind === "breaking") {
            p.broken = 0;
            p.gone = true;
            this.events.push({ kind: "break", platform: p });
            continue;
          }
          f.y = p.y;
          const onSpring = p.spring && Math.abs(wrapDelta(f.x - (p.x + p.spring.dx), this.W)) < 20;
          if (onSpring) {
            f.vy = SPRING_V;
            p.spring!.t = 0;
            this.events.push({ kind: "spring", platform: p });
            this.popups.push({ x: p.x + p.spring!.dx, y: p.y + 30, text: "boing!", t: 0, color: "#3a6fd8" });
          } else {
            f.vy = JUMP_V;
            this.events.push({ kind: "bounce", platform: p });
          }
          f.squash = 1;
          this.jumps++;
          // bouncing on the same spot without progress: look elsewhere for a while
          this.sameBounces = p.id === this.lastBounceId ? this.sameBounces + 1 : 0;
          this.lastBounceId = p.id;
          if (this.sameBounces >= 2) {
            p.bannedUntil = this.time + 5;
            this.sameBounces = 0;
          }
          if (p.sugar && !p.sugar.taken) {
            p.sugar.taken = true;
            this.sugars++;
            this.maxY += 100; // sugar bonus
            this.events.push({ kind: "sugar", platform: p });
            this.popups.push({ x: p.x, y: p.y + 40, text: "+50 sugar!", t: 0, color: "#c2410c" });
          }
          if (p.kind === "vanish") {
            p.gone = true;
            p.broken = 0;
          }
          break;
        }
      }
    }

    if (f.y > this.maxY) this.maxY = f.y;
    this.score = Math.floor(this.maxY / 2);
    if (f.y > this.cameraY + this.H * 0.5) this.cameraY = f.y - this.H * 0.5;
    this.generate();
    this.sense = this.chooseTarget();

    if (f.y < this.cameraY - 60) {
      f.alive = false;
      f.deadT = 0;
      this.games++;
      this.best = Math.max(this.best, this.score);
      this.restartIn = 1.6;
      this.events.push({ kind: "fall" });
    }
  }
}

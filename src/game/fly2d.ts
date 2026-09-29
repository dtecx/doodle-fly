// Hand-drawn cartoon fruit fly (side view, facing +x, origin at the feet, y up, world units).

export interface FlyPose {
  facing: 1 | -1;
  /** 0 = legs tucked, 1 = legs reaching down */
  legs: number;
  /** wing beat phase (radians) and amplitude (0..1) */
  wingPhase: number;
  wingAmp: number;
  squash: number;
  /** proboscis extension 0..1 */
  proboscis: number;
  /** -1..1, where the eye's highlight looks (in facing direction) */
  look: number;
  /** giant-fibre escape flinch 0..1 */
  startle: number;
  dead: boolean;
}

const INK = "#2a1c0f";
const BODY = "#d9a54c";
const BODY_DARK = "#a8762c";
const STRIPE = "#5b3a16";
const EYE = "#d8322a";
const EYE_DARK = "#8f1611";

function ellipse(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, rot = 0) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
}

function leg(
  ctx: CanvasRenderingContext2D,
  hip: [number, number],
  knee: [number, number],
  foot: [number, number],
  color: string,
  width: number,
) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(hip[0], hip[1]);
  ctx.lineTo(knee[0], knee[1]);
  ctx.lineTo(foot[0], foot[1]);
  // little tarsal claw
  ctx.lineTo(foot[0] + (foot[0] >= hip[0] ? 3 : -3), foot[1] - 0.5);
  ctx.stroke();
}

function legs(ctx: CanvasRenderingContext2D, pose: FlyPose, far: boolean) {
  const e = pose.legs;
  const lift = far ? 1.5 : 0;
  const color = far ? "#6d5638" : INK;
  const width = far ? 2.1 : 2.6;
  const spread = far ? 0.8 : 1;
  const mix = (a: number, b: number) => a + (b - a) * e;
  // [hip, tucked knee, extended knee, tucked foot, extended foot]
  const defs: [number, number, number, number, number, number, number, number, number, number][] = [
    [9, 20, 17, 17, 18, 13, 15, 9, 22, 0],
    [3, 19, 5, 13, 6, 10, 2, 6, 4, 0],
    [-3, 20, -10, 15, -12, 12, -9, 9, -16, 0],
  ];
  for (const [hx, hy, tkx, tky, ekx, eky, tfx, tfy, efx, efy] of defs) {
    const hip: [number, number] = [hx, hy + lift];
    const knee: [number, number] = [mix(tkx, ekx * spread + (1 - spread) * hx) , mix(tky, eky) + lift];
    const foot: [number, number] = [mix(tfx, efx * spread + (1 - spread) * hx), mix(tfy, efy) + lift];
    leg(ctx, hip, knee, foot, color, width);
  }
}

function wing(ctx: CanvasRenderingContext2D, angle: number, far: boolean) {
  ctx.save();
  ctx.translate(-1, 40);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-8, 9, -30, 10, -38, 2);
  ctx.bezierCurveTo(-40, -2, -30, -6, -14, -5);
  ctx.bezierCurveTo(-6, -4, -2, -2, 0, 0);
  ctx.fillStyle = far ? "rgba(214, 232, 247, 0.45)" : "rgba(236, 246, 255, 0.62)";
  ctx.fill();
  ctx.strokeStyle = far ? "rgba(70, 95, 120, 0.55)" : "#3f5c78";
  ctx.lineWidth = 1.6;
  ctx.stroke();
  if (!far) {
    // veins
    ctx.strokeStyle = "rgba(70, 90, 110, 0.55)";
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(-2, 0);
    ctx.quadraticCurveTo(-20, 5, -36, 3);
    ctx.moveTo(-3, -1);
    ctx.quadraticCurveTo(-20, 1, -37, -1);
    ctx.moveTo(-4, -2);
    ctx.quadraticCurveTo(-18, -3, -30, -5);
    ctx.moveTo(-17, 5.5);
    ctx.lineTo(-19, -3);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawFly(ctx: CanvasRenderingContext2D, pose: FlyPose): void {
  ctx.save();
  const sq = pose.squash;
  ctx.scale(pose.facing * (1 + 0.18 * sq), 1 - 0.22 * sq);
  if (pose.dead) ctx.rotate(Math.PI * 0.08);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const beat = Math.sin(pose.wingPhase) * pose.wingAmp;
  const rest = 0.18 + 0.9 * pose.startle;
  const farAngle = rest + 0.35 + beat * 1.1;
  const nearAngle = rest + beat * 1.2;

  // far wing + ghost copies when buzzing
  if (pose.wingAmp > 0.5) {
    ctx.globalAlpha = 0.35;
    wing(ctx, rest + 0.35 - pose.wingAmp * 1.0, true);
    ctx.globalAlpha = 1;
  }
  wing(ctx, farAngle, true);
  legs(ctx, pose, true);

  // abdomen with stripes
  ctx.save();
  ellipse(ctx, -13, 27, 17, 12.5, 0.18);
  ctx.fillStyle = BODY;
  ctx.fill();
  ctx.clip();
  ctx.fillStyle = STRIPE;
  for (let k = 0; k < 4; k++) {
    ctx.save();
    ctx.translate(-8 - k * 7, 27);
    ctx.rotate(0.18);
    ctx.fillRect(-2.2, -14, 3.4, 28);
    ctx.restore();
  }
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ellipse(ctx, -14, 33, 11, 3.5, 0.18);
  ctx.fill();
  ctx.restore();
  ellipse(ctx, -13, 27, 17, 12.5, 0.18);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.4;
  ctx.stroke();

  // thorax
  ctx.beginPath();
  ctx.ellipse(4, 30, 13, 12, 0, 0, Math.PI * 2);
  ctx.fillStyle = BODY;
  ctx.fill();
  ctx.fillStyle = BODY_DARK;
  ctx.beginPath();
  ctx.ellipse(4, 27, 12, 7, 0, Math.PI * 0.05, Math.PI * 0.95);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(4, 30, 13, 12, 0, 0, Math.PI * 2);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.4;
  ctx.stroke();
  // bristles
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (const [x, y, dx, dy] of [
    [0, 41.5, -4, 3],
    [5, 42, -3, 3.5],
    [10, 40.5, -1.5, 4],
    [-5, 39.5, -4.5, 2],
  ]) {
    ctx.moveTo(x, y);
    ctx.lineTo(x + dx, y + dy);
  }
  ctx.stroke();

  // proboscis
  if (pose.proboscis > 0.04) {
    const e = pose.proboscis;
    const tipX = 22 + 5 * e;
    const tipY = 25 - 15 * e;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 4.2;
    ctx.beginPath();
    ctx.moveTo(20, 26);
    ctx.quadraticCurveTo(24, 22 - 4 * e, tipX, tipY);
    ctx.stroke();
    ctx.strokeStyle = "#b9803a";
    ctx.lineWidth = 2.2;
    ctx.stroke();
    ellipse(ctx, tipX + 1, tipY - 1.5, 3.6, 2.4, 0.4);
    ctx.fillStyle = "#c98f45";
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  // head
  ellipse(ctx, 19, 32, 9.5, 10);
  ctx.fillStyle = BODY;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.4;
  ctx.stroke();

  // compound eye: red, faceted, glossy
  ctx.save();
  ellipse(ctx, 21, 33, 7.6, 8.6, -0.1);
  ctx.fillStyle = EYE;
  ctx.fill();
  ctx.clip();
  ctx.fillStyle = EYE_DARK;
  for (let r = -4; r <= 4; r++)
    for (let c = -4; c <= 4; c++) {
      const x = 21 + c * 2.1 + (r & 1 ? 1.05 : 0);
      const y = 33 + r * 1.85;
      ctx.beginPath();
      ctx.arc(x, y, 0.55, 0, Math.PI * 2);
      ctx.fill();
    }
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ellipse(ctx, 22.5 + 1.8 * pose.look, 36.5, 2.6, 1.6, -0.4);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ellipse(ctx, 25 + pose.look, 31, 1.1, 0.8);
  ctx.fill();
  ctx.restore();
  ellipse(ctx, 21, 33, 7.6, 8.6, -0.1);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.stroke();

  // antenna + feathery arista
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(26, 38);
  ctx.lineTo(28.5, 40.5);
  ctx.stroke();
  ellipse(ctx, 29.5, 41.3, 2.2, 1.8);
  ctx.fillStyle = BODY_DARK;
  ctx.fill();
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(30.5, 42.5);
  ctx.quadraticCurveTo(33, 47, 31.5, 52);
  for (const t of [0.35, 0.6, 0.85]) {
    const x = 30.5 + 2.2 * t;
    const y = 42.5 + 9 * t;
    ctx.moveTo(x, y);
    ctx.lineTo(x + 2.4, y + 0.6);
    ctx.moveTo(x, y);
    ctx.lineTo(x - 2, y + 1.2);
  }
  ctx.stroke();

  legs(ctx, pose, false);
  wing(ctx, nearAngle, false);
  ctx.restore();
}

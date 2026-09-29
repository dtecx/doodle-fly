import * as THREE from "three";

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

/** Hexagonal ommatidia for the compound eye (color map + bump map). */
export function eyeTextures(): { map: THREE.Texture; bump: THREE.Texture } {
  const W = 512;
  const H = 256;
  const [c, g] = canvas(W, H);
  const [bc, bg] = canvas(W, H);
  g.fillStyle = "#7a0d08";
  g.fillRect(0, 0, W, H);
  bg.fillStyle = "#000";
  bg.fillRect(0, 0, W, H);
  const r = 5.2;
  const dx = r * Math.sqrt(3);
  const dy = r * 1.5;
  for (let row = 0, y = 0; y < H + r; row++, y += dy) {
    for (let x = row % 2 ? dx / 2 : 0; x < W + r; x += dx) {
      const hue = 2 + Math.random() * 6;
      const light = 36 + Math.random() * 10;
      const grad = g.createRadialGradient(x - 1, y - 1, 0.5, x, y, r);
      grad.addColorStop(0, `hsl(${hue}, 95%, ${light + 16}%)`);
      grad.addColorStop(1, `hsl(${hue}, 90%, ${light - 12}%)`);
      g.fillStyle = grad;
      g.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = Math.PI / 6 + (k * Math.PI) / 3;
        g.lineTo(x + Math.cos(a) * (r - 0.6), y + Math.sin(a) * (r - 0.6));
      }
      g.closePath();
      g.fill();
      const bgrad = bg.createRadialGradient(x, y, 0, x, y, r);
      bgrad.addColorStop(0, "#fff");
      bgrad.addColorStop(1, "#333");
      bg.fillStyle = bgrad;
      bg.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = Math.PI / 6 + (k * Math.PI) / 3;
        bg.lineTo(x + Math.cos(a) * (r - 0.8), y + Math.sin(a) * (r - 0.8));
      }
      bg.closePath();
      bg.fill();
    }
  }
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  const bump = new THREE.CanvasTexture(bc);
  bump.wrapS = bump.wrapT = THREE.RepeatWrapping;
  return { map, bump };
}

/** Tan cuticle with dark tergite bands, for the abdomen (bands run around the long axis). */
export function abdomenTexture(): THREE.Texture {
  const [c, g] = canvas(64, 512);
  g.fillStyle = "#c79a57";
  g.fillRect(0, 0, 64, 512);
  const bands = 6;
  for (let k = 0; k < bands; k++) {
    const y0 = 70 + k * 62;
    const grad = g.createLinearGradient(0, y0, 0, y0 + 34);
    grad.addColorStop(0, "rgba(70, 40, 12, 0.0)");
    grad.addColorStop(0.35, "rgba(70, 40, 12, 0.9)");
    grad.addColorStop(1, "rgba(70, 40, 12, 0.95)");
    g.fillStyle = grad;
    g.fillRect(0, y0, 64, 34);
  }
  // soft speckle
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(60, 35, 10, ${Math.random() * 0.12})`;
    g.fillRect(Math.random() * 64, Math.random() * 512, 1.5, 1.5);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Thorax: tan with faint longitudinal stripes. */
export function thoraxTexture(): THREE.Texture {
  const [c, g] = canvas(256, 128);
  g.fillStyle = "#b98c4d";
  g.fillRect(0, 0, 256, 128);
  for (const x of [96, 128, 160]) {
    const grad = g.createLinearGradient(x - 10, 0, x + 10, 0);
    grad.addColorStop(0, "rgba(90,55,20,0)");
    grad.addColorStop(0.5, "rgba(90,55,20,0.35)");
    grad.addColorStop(1, "rgba(90,55,20,0)");
    g.fillStyle = grad;
    g.fillRect(x - 10, 0, 20, 128);
  }
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = `rgba(50, 30, 10, ${Math.random() * 0.15})`;
    g.fillRect(Math.random() * 256, Math.random() * 128, 1.2, 1.2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Wing membrane: veins on transparent film (alpha in the texture). */
export function wingTexture(): THREE.Texture {
  const W = 512;
  const H = 192;
  const [c, g] = canvas(W, H);
  g.clearRect(0, 0, W, H);
  g.fillStyle = "rgba(225, 235, 245, 0.35)";
  g.fillRect(0, 0, W, H);
  g.strokeStyle = "rgba(95, 70, 40, 0.95)";
  g.lineCap = "round";
  const vein = (w: number, pts: [number, number][]) => {
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const [x, y] = pts[i];
      const [nx, ny] = pts[i + 1];
      g.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
    }
    const last = pts[pts.length - 1];
    g.lineTo(last[0], last[1]);
    g.stroke();
  };
  // longitudinal veins L1-L5 fanning from the hinge (x=0) to the margin
  vein(5, [[0, 70], [140, 40], [300, 22], [420, 30]]);
  vein(3.5, [[10, 78], [180, 62], [340, 52], [500, 70]]);
  vein(3.5, [[10, 86], [200, 88], [360, 94], [505, 104]]);
  vein(3.5, [[12, 94], [200, 112], [360, 132], [470, 150]]);
  vein(3, [[14, 102], [170, 134], [300, 160], [380, 176]]);
  // cross veins
  vein(2.5, [[228, 90], [236, 115]]);
  vein(2.5, [[330, 96], [340, 140]]);
  // margin
  g.lineWidth = 2;
  g.strokeStyle = "rgba(95, 70, 40, 0.6)";
  g.strokeRect(1, 1, W - 2, H - 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Soft radial gradient used for the backdrop. */
export function backdropTexture(): THREE.Texture {
  const [c, g] = canvas(512, 512);
  const grad = g.createRadialGradient(256, 200, 20, 256, 256, 380);
  grad.addColorStop(0, "#1d2440");
  grad.addColorStop(0.6, "#0d1122");
  grad.addColorStop(1, "#05070f");
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

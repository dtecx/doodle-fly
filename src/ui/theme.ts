// One palette and one set of type for every canvas, matching the CSS tokens in style.css.

export const C = {
  paper: "#f3eee4",
  paper2: "#e9e2d3",
  ink: "#1c1a17",
  ink2: "#4a453d",
  ink3: "#8a8274",
  rule: "#d6cdbd",
  faint: "#e2dacb",
  accent: "#c8871e",
  /** the fly's left and right: eyes, steering neurons, buttons */
  left: "#2f6aa3",
  right: "#c8581e",
  /** escape and taste circuits */
  escape: "#c43d2b",
  taste: "#b0447a",
};

export const F = {
  serif: `"Newsreader", Georgia, serif`,
  sans: `"IBM Plex Sans", system-ui, sans-serif`,
  mono: `"IBM Plex Mono", ui-monospace, monospace`,
};

/** crisp canvas at the device pixel ratio; returns the CSS size */
export function fitCanvas(canvas: HTMLCanvasElement): { w: number; h: number; dpr: number; ctx: CanvasRenderingContext2D } {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w: Math.max(1, r.width), h: Math.max(1, r.height), dpr, ctx };
}

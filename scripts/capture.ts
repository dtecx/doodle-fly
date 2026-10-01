// Screenshot + demo GIF of the running app through the Chrome DevTools Protocol (no npm deps).
//   npm run dev                                  (in another terminal)
//   node scripts/capture.ts [--url http://localhost:5173/] [--wait 20] [--gif 8] [--gif-width 800] [--gif-fps 10]
//   add --phone for a 390 x 844 phone at 3x, the whole page in one screenshot
// Needs Google Chrome; the GIF needs ffmpeg. Writes docs/screenshot.png and docs/demo.gif.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const url = arg("url", "http://localhost:5173/");
const waitS = Number(arg("wait", "20"));
const gifS = Number(arg("gif", "8"));
const phone = process.argv.includes("--phone");
const width = Number(arg("width", phone ? "390" : "1920"));
const height = Number(arg("height", phone ? "844" : "1080"));
const gifWidth = Number(arg("gif-width", "800"));
const gifFps = Number(arg("gif-fps", "10"));
const port = 9333;
const out = new URL("../docs/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "doodle-fly-chrome-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    "--hide-scrollbars",
    "--ignore-gpu-blocklist",
    "--use-angle=metal",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function main(): Promise<void> {
  let wsUrl = "";
  for (let i = 0; i < 100 && !wsUrl; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? "";
    } catch {
      await sleep(100);
    }
  }
  if (!wsUrl) throw new Error("Chrome DevTools endpoint did not come up");

  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let nextId = 1;
  const pending = new Map<number, (v: any) => void>();
  const frames: { data: string; t: number }[] = [];
  let recording = false;
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)!(msg.error ? Promise.reject(new Error(msg.error.message)) : msg.result);
      pending.delete(msg.id);
    } else if (msg.method === "Page.screencastFrame") {
      if (recording) frames.push({ data: msg.params.data, t: msg.params.metadata.timestamp });
      void send("Page.screencastFrameAck", { sessionId: msg.params.sessionId });
    }
  });
  const send = (method: string, params: object = {}): Promise<any> =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expr: string) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.value;

  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: phone ? 3 : 1, mobile: phone });
  await send("Page.enable");
  await send("Page.navigate", { url });
  console.log(`loading ${url} ...`);
  for (let i = 0; i < 600; i++) {
    if (await evaluate("document.getElementById('loader')?.classList.contains('done')")) break;
    await sleep(100);
  }
  console.log(`playing for ${waitS} s ...`);
  await sleep(waitS * 1000);
  console.log("game speed:", await evaluate("document.getElementById('speed')?.textContent"));

  // take the still while the fly is holding a button down
  for (let i = 0; i < 150; i++) {
    const ok = await evaluate("(() => { const d = window.__doodle; return d && d.game.fly.alive && Math.abs(d.decoder.steer) > 0.6; })()");
    if (ok) break;
    await sleep(50);
  }
  await sleep(120);
  const full = phone ? (await send("Page.getLayoutMetrics")).cssContentSize : null;
  const shot = await send(
    "Page.captureScreenshot",
    full ? { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: full.width, height: full.height, scale: 1 } } : { format: "png" },
  );
  const shotPath = arg("out", join(out, "screenshot.png"));
  writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  console.log(`wrote ${shotPath}`);

  if (gifS > 0) {
    await send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 });
    recording = true;
    await sleep(gifS * 1000);
    recording = false;
    await send("Page.stopScreencast");
    const dir = mkdtempSync(join(tmpdir(), "doodle-fly-frames-"));
    const list: string[] = [];
    frames.forEach((f, i) => {
      const name = join(dir, `f${String(i).padStart(5, "0")}.jpg`);
      writeFileSync(name, Buffer.from(f.data, "base64"));
      const next = frames[i + 1]?.t ?? f.t + 1 / 15;
      list.push(`file '${name}'`, `duration ${Math.max(0.005, next - f.t).toFixed(4)}`);
    });
    list.push(`file '${join(dir, `f${String(frames.length - 1).padStart(5, "0")}.jpg`)}'`);
    writeFileSync(join(dir, "list.txt"), list.join("\n"));
    console.log(`${frames.length} frames over ${gifS} s, encoding GIF ...`);
    const ff = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        join(dir, "list.txt"),
        "-vf",
        `fps=${gifFps},scale=${gifWidth}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
        "-loop",
        "0",
        join(out, "demo.gif"),
      ],
      { stdio: "inherit" },
    );
    rmSync(dir, { recursive: true, force: true });
    if (ff.status === 0) console.log("wrote docs/demo.gif");
  }
  ws.close();
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    chrome.kill();
    setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
  });

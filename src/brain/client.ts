import type { FrameResult, FromWorker, ReadyInfo, SensoryInput, ToWorker } from "./protocol.ts";

/** Main-thread handle to the brain worker. One step in flight at a time. */
export class BrainClient {
  private readonly worker: Worker;
  private nextId = 1;
  pending = false;
  onProgress: (stage: string, frac: number) => void = () => {};
  onFrame: (frame: FrameResult) => void = () => {};
  onError: (message: string) => void = () => {};

  constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  }

  init(base: string): Promise<ReadyInfo> {
    return new Promise((resolve, reject) => {
      this.worker.onmessage = (ev: MessageEvent<FromWorker>) => {
        const msg = ev.data;
        if (msg.type === "progress") this.onProgress(msg.stage, msg.frac);
        else if (msg.type === "ready") resolve(msg.info);
        else if (msg.type === "frame") {
          this.pending = false;
          this.onFrame(msg.frame);
        } else if (msg.type === "error") {
          this.pending = false;
          this.onError(msg.message);
          reject(new Error(msg.message));
        }
      };
      this.worker.onerror = (e) => {
        this.onError(e.message);
        reject(new Error(e.message));
      };
      this.send({ type: "init", base });
    });
  }

  step(ms: number, input: SensoryInput): void {
    this.pending = true;
    this.send({ type: "step", id: this.nextId++, ms, input });
  }

  private send(msg: ToWorker): void {
    this.worker.postMessage(msg);
  }
}

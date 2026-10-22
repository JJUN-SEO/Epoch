import type { Graph3DData } from "./data";
import type {
  Layout3DFrame,
  Layout3DMessage,
  Layout3DRequest,
} from "./layout3d-protocol";

/** The part of a Worker the client uses (tests pass a fake). */
export interface WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: Layout3DRequest): void;
  terminate(): void;
}

const layoutWorker = (): WorkerLike =>
  new Worker(new URL("./layout3d.worker.ts", import.meta.url), {
    type: "module",
    name: "epoch-layout-3d",
  });

/**
 * Runs 3D layouts in a worker. A new request stops the one in flight (the
 * worker is replaced), so an outdated simulation never delays a fresh one.
 * A worker that fails is reported, never waited on.
 */
export class Layout3DClient {
  private worker: WorkerLike | undefined;
  private nextId = 0;
  private readonly createWorker: () => WorkerLike;

  constructor(createWorker: () => WorkerLike = layoutWorker) {
    this.createWorker = createWorker;
  }

  run(
    data: Graph3DData,
    initial: Float32Array | undefined,
    onFrame: (frame: Layout3DFrame) => void,
    onError: (message: string) => void,
  ): void {
    this.worker?.terminate();
    const worker = this.createWorker();
    this.worker = worker;
    const id = this.nextId++;
    const finish = () => {
      if (this.worker === worker) {
        worker.terminate();
        this.worker = undefined;
      }
    };
    const fail = (message: string) => {
      if (this.worker !== worker) return;
      finish();
      onError(message);
    };
    worker.onmessage = (event: MessageEvent<Layout3DMessage>) => {
      const message = event.data;
      if (message.id !== id || this.worker !== worker) return;
      if ("error" in message) {
        fail(message.error);
        return;
      }
      onFrame(message);
      if (message.done) finish();
    };
    worker.onerror = (event) => {
      event.preventDefault();
      fail(event.message || "the layout worker stopped");
    };
    worker.onmessageerror = () => {
      fail("the layout's answer could not be read");
    };
    const request: Layout3DRequest = {
      id,
      count: data.ids.length,
      groups: data.groups,
      links: data.links,
      ...(initial ? { initial } : {}),
    };
    worker.postMessage(request);
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = undefined;
  }
}

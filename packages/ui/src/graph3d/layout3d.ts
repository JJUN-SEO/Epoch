import type { Graph3DData } from "./data";
import type { Layout3DFrame, Layout3DRequest } from "./layout3d-protocol";

/**
 * Runs 3D layouts in a worker. A new request stops the one in flight (the
 * worker is replaced), so an outdated simulation never delays a fresh one.
 */
export class Layout3DClient {
  private worker: Worker | undefined;
  private nextId = 0;

  run(data: Graph3DData, onFrame: (frame: Layout3DFrame) => void): void {
    this.worker?.terminate();
    const worker = new Worker(
      new URL("./layout3d.worker.ts", import.meta.url),
      {
        type: "module",
        name: "epoch-layout-3d",
      },
    );
    this.worker = worker;
    const id = this.nextId++;
    worker.onmessage = (event: MessageEvent<Layout3DFrame>) => {
      if (event.data.id !== id) return;
      onFrame(event.data);
      if (event.data.done && this.worker === worker) {
        worker.terminate();
        this.worker = undefined;
      }
    };
    const request: Layout3DRequest = {
      id,
      count: data.ids.length,
      groups: data.groups,
      links: data.links,
    };
    worker.postMessage(request);
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = undefined;
  }
}

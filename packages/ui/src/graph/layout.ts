import type { LayoutRequest, LayoutResponse } from "./layout-protocol";

/** One layout worker for the page; the newest request wins. */
export class LayoutClient {
  private readonly worker = new Worker(
    new URL("./layout.worker.ts", import.meta.url),
    { type: "module", name: "epoch-layout" },
  );
  private nextId = 0;
  private pending:
    | { id: number; resolve: (r: LayoutResponse | undefined) => void }
    | undefined;

  constructor() {
    this.worker.onmessage = (event: MessageEvent<LayoutResponse>) => {
      if (event.data.id === this.pending?.id) {
        this.pending.resolve(event.data);
        this.pending = undefined;
      }
    };
  }

  /** Lays out a graph; resolves undefined if a newer request replaced it. */
  layout(
    request: Omit<LayoutRequest, "id">,
  ): Promise<LayoutResponse | undefined> {
    this.pending?.resolve(undefined);
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending = { id, resolve };
      this.worker.postMessage({ ...request, id } satisfies LayoutRequest);
    });
  }

  dispose(): void {
    this.pending?.resolve(undefined);
    this.worker.terminate();
  }
}

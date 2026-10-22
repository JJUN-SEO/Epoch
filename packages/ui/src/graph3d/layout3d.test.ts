import { describe, expect, it } from "vitest";
import { edge, graph } from "../graph/test-graph";
import { graph3dData } from "./data";
import { Layout3DClient, type WorkerLike } from "./layout3d";
import type { Layout3DRequest } from "./layout3d-protocol";

class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly posted: Layout3DRequest[] = [];
  terminated = false;
  postMessage(message: Layout3DRequest): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  send(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

const data = graph3dData(graph(["a.ts", "b.ts"], [edge("a.ts", "b.ts")]), {
  showViaBarrel: false,
});

function setup() {
  const workers: FakeWorker[] = [];
  const client = new Layout3DClient(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  });
  const frames: boolean[] = [];
  const errors: string[] = [];
  const run = (initial?: Float32Array) => {
    client.run(
      data,
      initial,
      (frame) => frames.push(frame.done),
      (message) => errors.push(message),
    );
  };
  return { client, workers, frames, errors, run };
}

describe("Layout3DClient", () => {
  it("passes frames on and ends the worker after the last one", () => {
    const t = setup();
    t.run();
    const w = t.workers[0];
    if (!w) throw new Error("no worker");
    const id = w.posted[0]?.id;
    w.send({ id, positions: new Float32Array(6), done: false, ms: 1 });
    w.send({ id: 99, positions: new Float32Array(6), done: true, ms: 1 });
    expect(t.frames).toEqual([false]);
    w.send({ id, positions: new Float32Array(6), done: true, ms: 2 });
    expect(t.frames).toEqual([false, true]);
    expect(w.terminated).toBe(true);
  });

  it("sends starting positions along", () => {
    const t = setup();
    const initial = new Float32Array([1, 2, 3, 4, 5, 6]);
    t.run(initial);
    expect([...(t.workers[0]?.posted[0]?.initial ?? [])]).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  it("reports a layout that failed, a worker error, or a message it cannot read", () => {
    const t = setup();
    t.run();
    const w = t.workers[0];
    if (!w) throw new Error("no worker");
    w.send({ id: w.posted[0]?.id, error: "too many nodes" });
    expect(t.errors).toEqual(["too many nodes"]);
    expect(w.terminated).toBe(true);

    t.run();
    const crashed = t.workers[1];
    crashed?.onerror?.({
      message: "out of memory",
      preventDefault: () => undefined,
    } as ErrorEvent);
    t.run();
    t.workers[2]?.onmessageerror?.({} as MessageEvent);
    expect(t.errors).toEqual([
      "too many nodes",
      "out of memory",
      "the layout's answer could not be read",
    ]);
  });

  it("a new run stops the one in flight", () => {
    const t = setup();
    t.run();
    t.run();
    expect(t.workers[0]?.terminated).toBe(true);
    expect(t.workers[1]?.terminated).toBe(false);
    t.client.dispose();
    expect(t.workers[1]?.terminated).toBe(true);
  });
});

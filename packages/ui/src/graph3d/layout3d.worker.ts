import type {
  Layout3DFailure,
  Layout3DFrame,
  Layout3DRequest,
} from "./layout3d-protocol";
import { simulate3d } from "./layout3d-sim";

/** At most one intermediate frame per this many milliseconds. */
const FRAME_MS = 120;

self.onmessage = (event: MessageEvent<Layout3DRequest>) => {
  const started = performance.now();
  const { id } = event.data;
  try {
    simulate3d(
      event.data,
      (positions, done) => {
        const frame: Layout3DFrame = {
          id,
          positions,
          done,
          ms: performance.now() - started,
        };
        self.postMessage(frame, { transfer: [positions.buffer] });
      },
      { now: () => performance.now(), frameMs: FRAME_MS },
    );
  } catch (error) {
    const failure: Layout3DFailure = {
      id,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(failure);
  }
};

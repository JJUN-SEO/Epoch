/** Messages between the 3D view and its layout worker. */

export interface Layout3DRequest {
  readonly id: number;
  readonly count: number;
  /** Folder index per node (graph3d/data.ts). */
  readonly groups: Int32Array;
  /** Edge endpoints as node indices, in pairs. */
  readonly links: Int32Array;
}

export interface Layout3DFrame {
  readonly id: number;
  /** x, y, z per node, in node order. */
  readonly positions: Float32Array;
  /** The last frame: the simulation has cooled. */
  readonly done: boolean;
  /** Time spent simulating so far. */
  readonly ms: number;
}

/** Messages between the graph view and the layout worker. */

export interface LayoutRequest {
  readonly id: number;
  readonly nodes: readonly {
    readonly id: string;
    readonly parent?: string;
    /** Width and height for layout, in model units. */
    readonly size: number;
  }[];
  readonly edges: readonly {
    readonly id: string;
    readonly source: string;
    readonly target: string;
  }[];
  /**
   * Positions nodes had before this request (the graph changed or a folder
   * opened). With enough of them, the layout refines from there instead of
   * starting over, so the picture stays put.
   */
  readonly seed?: Readonly<Record<string, { x: number; y: number }>>;
}

export interface LayoutResponse {
  readonly id: number;
  /** Positions of leaf nodes; compound nodes follow their children. */
  readonly positions: Readonly<Record<string, { x: number; y: number }>>;
  readonly ms: number;
}

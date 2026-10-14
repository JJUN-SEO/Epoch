import type {
  Confidence,
  Finding,
  FindingKind,
  Graph,
  GraphEdge,
  GraphNode,
} from "../schemas/index.js";

/*
 * The types EpochApi refers to. CLAUDE.md names them without defining them,
 * so these are minimal and @provisional: M3 (app, IPC) and M4 (blast radius)
 * refine them, together with their zod schemas for IPC validation.
 */

/** @provisional */
export type Unsubscribe = () => void;

/** @provisional */
export interface ProjectInfo {
  /** Absolute path of the opened folder. */
  readonly root: string;
  readonly name: string;
}

/** @provisional */
export interface Progress {
  readonly stage: "discover" | "parse" | "resolve" | "graph" | "done";
  readonly done: number;
  readonly total: number;
}

/** @provisional Watcher-driven incremental update (M4). */
export interface GraphDelta {
  readonly upsertNodes: readonly GraphNode[];
  readonly removeNodes: readonly string[];
  readonly upsertEdges: readonly GraphEdge[];
  readonly removeEdges: readonly Pick<
    GraphEdge,
    "source" | "target" | "kind"
  >[];
}

/** @provisional CLAUDE.md "Blast radius" (M4). */
export interface BlastRadiusOptions {
  readonly mode: "certain" | "likely";
  readonly includeTypeOnly: boolean;
  /** Minimum hint confidence in likely mode. */
  readonly hintThreshold?: number;
  readonly maxDepth?: number;
}

/** @provisional CLAUDE.md "Blast radius": totals, depth, groupings, hint dependence. */
export interface BlastRadiusResult {
  readonly nodeId: string;
  readonly affected: readonly { id: string; depth: number }[];
  readonly total: number;
  readonly maxDepth: number;
  readonly byDirectory: Readonly<Record<string, number>>;
  readonly byLanguage: Readonly<Record<string, number>>;
  /** How many results depend on hint edges. */
  readonly viaHints: number;
}

/** @provisional */
export interface FindingFilter {
  readonly kinds?: readonly FindingKind[];
  readonly minConfidence?: Confidence;
  readonly includeDismissed?: boolean;
}

/** @provisional Read-only, inside the project root. */
export interface CodePreview {
  readonly file: string;
  readonly startLine: number;
  readonly lines: readonly string[];
}

/** @provisional */
export interface Settings {
  readonly offline: boolean;
  readonly updateChecks: boolean;
  readonly theme: "system" | "light" | "dark";
}

/** CLAUDE.md "Architecture": the UI is written against this interface. */
export interface EpochApi {
  openProject(path: string): Promise<ProjectInfo>;
  getGraph(): Promise<Graph>;
  onProgress(cb: (p: Progress) => void): Unsubscribe;
  /** Watcher-driven incremental updates. */
  onGraphDelta(cb: (d: GraphDelta) => void): Unsubscribe;
  getBlastRadius(
    nodeId: string,
    opts: BlastRadiusOptions,
  ): Promise<BlastRadiusResult>;
  /** Excludes dismissed findings unless asked. */
  getFindings(filter?: FindingFilter): Promise<Finding[]>;
  dismissFinding(id: string, note?: string): Promise<void>;
  undismissFinding(id: string): Promise<void>;
  /** Read-only, inside the project root. */
  getCodePreview(
    file: string,
    startLine: number,
    endLine: number,
  ): Promise<CodePreview>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  /** One-way: the value is never readable back. */
  setKey(provider: string, value: string): Promise<void>;
  getKeyStatus(provider: string): Promise<{ configured: boolean }>;
}

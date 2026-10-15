import type {
  AnalysisMeta,
  Confidence,
  EntryPoint,
  Finding,
  FindingKind,
  Graph,
  GraphEdge,
  GraphNode,
  UnresolvedImport,
} from "../schemas/index.js";

/*
 * The types EpochApi refers to. CLAUDE.md names them without defining them,
 * so these are minimal and @provisional: M3 (app, IPC) and M4 (blast radius)
 * refine them, together with their zod schemas for IPC validation.
 */

/** @provisional */
export type Unsubscribe = () => void;

/** @provisional The file watcher's state (the desktop app; the demo never watches). */
export type WatchStatus =
  /** Waiting for changes. */
  | { readonly state: "watching" }
  /** Re-analyzing after a batch of changes. */
  | { readonly state: "updating" }
  /** A re-analysis failed; still watching, and the last graph stays. */
  | { readonly state: "error"; readonly message: string }
  /** Watching stopped for good (the OS watch limit); the last graph stays. */
  | { readonly state: "stopped"; readonly message: string };

/**
 * @provisional What the latest analysis used: git history, a coverage
 * report, epoch.config.json, and what the Findings stage could check.
 */
export interface AnalysisInfo {
  readonly git: AnalysisMeta["git"];
  readonly coverage: AnalysisMeta["coverage"];
  readonly config: AnalysisMeta["config"];
  readonly findings: AnalysisMeta["findings"];
}

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

/**
 * A watcher-driven change to the graph (M4): what to add, replace or remove
 * so the previous graph becomes the new one (core/graph/delta.ts). The small
 * lists are replaced whole when they change.
 */
export interface GraphDelta {
  readonly upsertNodes: readonly GraphNode[];
  readonly removeNodes: readonly string[];
  readonly upsertEdges: readonly GraphEdge[];
  readonly removeEdges: readonly Pick<
    GraphEdge,
    "source" | "target" | "kind"
  >[];
  readonly roots?: readonly EntryPoint[];
  readonly findings?: readonly Finding[];
  readonly unresolved?: readonly UnresolvedImport[];
}

/** CLAUDE.md "Blast radius". */
export interface BlastRadiusOptions {
  /** certain: fact edges only; likely: plus hint edges at or above hintThreshold. */
  readonly mode: "certain" | "likely";
  /** Follow type-only edges (CLAUDE.md "Edge traversal policy": a toggle, default on). */
  readonly includeTypeOnly: boolean;
  /** Minimum hint confidence; required in likely mode (ADR-008 sets the UI default, M6). */
  readonly hintThreshold?: number;
  /** Stop after this many hops. */
  readonly maxDepth?: number;
}

/** CLAUDE.md "Blast radius": totals, depth, groupings, hint dependence. */
export interface BlastRadiusResult {
  readonly nodeId: string;
  /** Sorted by depth, then id. The changed node itself is never listed. */
  readonly affected: readonly {
    readonly id: string;
    readonly depth: number;
    /** Reached only through a hint edge (not reachable in certain mode). */
    readonly viaHint: boolean;
  }[];
  readonly total: number;
  readonly maxDepth: number;
  /** By containing directory ("." at the root); a package counts under its own path. */
  readonly byDirectory: Readonly<Record<string, number>>;
  readonly byLanguage: Readonly<Record<string, number>>;
  /** Files and packages (Go) separately, so neither granularity hides the other. */
  readonly byKind: { readonly file: number; readonly package: number };
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

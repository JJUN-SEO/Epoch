import type {
  AnalysisMeta,
  Confidence,
  EntryPoint,
  Finding,
  FindingKind,
  Graph,
  GraphEdge,
  GraphNode,
  Settings,
  SettingsPatch,
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
 * report, epoch.config.json, what the Findings stage could check, and where
 * the hint edges came from.
 */
export interface AnalysisInfo {
  readonly git: AnalysisMeta["git"];
  readonly coverage: AnalysisMeta["coverage"];
  readonly config: AnalysisMeta["config"];
  readonly findings: AnalysisMeta["findings"];
  /** The Enrich stage (M6): which hint sources ran, and how many hint edges it made. */
  readonly hints: AnalysisMeta["hints"];
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

/* ---------- Model features (M7, ADR-016) ---------- */

/** How a summary was made, for the "model-generated" label and the cost. */
export interface SummaryMeta {
  readonly provider: "anthropic" | "local";
  readonly model: string;
  readonly createdAt: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** At the user's prices; 0 on this machine. */
  readonly costUsd: number;
}

/** A stored summary shown while a newer one is not (yet) made. */
export interface CachedSummary {
  readonly text: string;
  /** file: the content (or model) changed; dependencies: only summaries it used did. */
  readonly stale: "file" | "dependencies";
  readonly meta: SummaryMeta;
}

/** What approving a summary request would send and may cost (ADR-016). */
export interface SummaryJobPlan {
  readonly provider: "anthropic" | "local";
  readonly model: string;
  /** Where requests go, e.g. "https://api.anthropic.com". */
  readonly destination: string;
  /** Leaves this machine. */
  readonly remote: boolean;
  /** Summaries to make (a folder job: its files and folders, bottom-up). */
  readonly requests: number;
  /** Files whose content would be sent (repo-relative), at most 200 listed. */
  readonly sends: readonly string[];
  /** How many files `sends` leaves out. */
  readonly sendsMore: number;
  /** Files never sent because they look like secrets. */
  readonly excluded: readonly string[];
  readonly estimate: {
    readonly inputTokens: number;
    readonly maxOutputTokens: number;
    /** The most it can cost at the user's prices; 0 on this machine. */
    readonly worstCaseUsd: number;
  };
}

export type SummaryApprovalReason =
  /** First remote use in this project: consent is asked in a native dialog. */
  | "consent"
  /** Estimated above the ask-first threshold. */
  | "over-threshold"
  /** Folders are always a confirmed job. */
  | "folder-job"
  /** Asked for by the user (not automatic), e.g. "Update" on a stale summary. */
  | "requested";

export type SummaryUnavailableReason =
  | "disabled"
  | "offline"
  | "no-key"
  | "no-price"
  | "no-cap"
  | "cap-reached"
  | "session-budget"
  | "no-local-model"
  | "secret"
  | "not-in-graph"
  | "unreadable"
  | "empty"
  | "no-project"
  | "busy"
  | "not-supported";

export type SummaryFailureReason =
  | "auth"
  | "rate-limited"
  | "unreachable"
  | "server"
  | "bad-request"
  | "key-needs-workspace"
  | "no-model"
  | "refusal"
  | "cut-off"
  | "nothing-kept"
  | "cancelled"
  | "plan-changed"
  | "expired";

/** A subject's summary, as the UI shows it. Reasons are fixed codes, never provider text. */
export type SummaryState =
  | {
      readonly state: "ready";
      readonly subject: string;
      readonly text: string;
      readonly stale?: "file" | "dependencies";
      readonly meta: SummaryMeta;
    }
  | {
      readonly state: "needs-approval";
      readonly subject: string;
      /** Single use; approves exactly this plan. */
      readonly planId: string;
      readonly plan: SummaryJobPlan;
      readonly reason: SummaryApprovalReason;
      readonly cached?: CachedSummary;
    }
  | {
      readonly state: "unavailable";
      readonly subject: string;
      readonly reason: SummaryUnavailableReason;
      readonly cached?: CachedSummary;
    }
  | {
      readonly state: "failed";
      readonly subject: string;
      readonly reason: SummaryFailureReason;
      readonly cached?: CachedSummary;
    };

/** A running summary job (a folder, or one file). */
export interface SummaryProgress {
  readonly planId: string;
  readonly state: "running" | "done" | "cancelled" | "failed";
  readonly done: number;
  readonly total: number;
  /** The subject being summarized. */
  readonly current?: string;
  readonly spentUsd: number;
}

/** What model features spent: counts and dollars only. */
export interface SpendStatus {
  /** "YYYY-MM": the month the cap counts. */
  readonly month: string;
  readonly monthUsd: number;
  readonly capUsd?: number;
  readonly sessionUsd: number;
  readonly sessionBudgetUsd: number;
  /** Reserved by requests in flight. */
  readonly heldUsd: number;
}

export interface KeyStatus {
  readonly configured: boolean;
  /** encrypted: OS-protected; session: memory only; weak: Linux without a keyring. */
  readonly storage?: "encrypted" | "session" | "weak";
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
  /** Any field of any section; raising what Epoch may spend is confirmed natively. */
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  /** One-way: the value is never readable back. */
  setKey(provider: string, value: string): Promise<void>;
  removeKey(provider: string): Promise<void>;
  getKeyStatus(provider: string): Promise<KeyStatus>;
  /** A file, "pkg:<id>" or "dir:<path>"; spends only under the auto rules (ADR-016). */
  getSummary(subject: string, opts?: { auto?: boolean }): Promise<SummaryState>;
  /** Spends exactly an approved plan. */
  generateSummary(planId: string): Promise<SummaryState>;
  cancelSummaries(): Promise<void>;
  onSummaryProgress(cb: (p: SummaryProgress) => void): Unsubscribe;
  getSpend(): Promise<SpendStatus>;
}

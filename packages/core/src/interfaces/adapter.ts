import type {
  EntryPoint,
  ExtractorConfig,
  FileFacts,
  RawImport,
  Resolution,
} from "../schemas/index.js";

/**
 * Read-only access to the analyzed project, supplied by the engine.
 * Paths are absolute with forward slashes. Implementations refuse anything
 * outside the project root and never write (CLAUDE.md: read-only on projects).
 */
export interface FileReader {
  readFile(path: string): string | undefined;
  fileExists(path: string): boolean;
  directoryExists(path: string): boolean;
  /** Immediate subdirectory names. */
  getDirectories(path: string): string[];
  /** Resolves symlinks; returns the input when it cannot or would leave the root. */
  realpath(path: string): string;
}

/** The project as the engine discovered it. */
export interface RepoView {
  /** Absolute project root, forward slashes, no trailing slash. */
  readonly root: string;
  /** Discovered files, repo-relative with forward slashes, sorted. */
  readonly files: readonly string[];
  readonly reader: FileReader;
}

export interface ProjectRoot {
  /** e.g. "tsconfig", "package", "workspace-root" (adapter-defined). */
  readonly kind: string;
  /** Repo-relative directory ("" for the root). */
  readonly dir: string;
  /** Repo-relative config or manifest file, when there is one. */
  readonly file?: string;
  /** Package name, for package roots. */
  readonly name?: string;
}

export interface ResolveContext {
  readonly repo: RepoView;
  /** Everything this adapter's detectProjectRoots returned. */
  readonly projectRoots: readonly ProjectRoot[];
}

export interface ProjectContext {
  readonly repo: RepoView;
  readonly projectRoots: readonly ProjectRoot[];
}

/** A file after the Parse stage: its text and syntax tree. */
export interface ParsedFile<TTree = unknown> {
  /** Repo-relative path, forward slashes. */
  readonly path: string;
  readonly text: string;
  readonly tree: TTree;
}

/**
 * CLAUDE.md "Language adapter interface". Adapters are pure: input in, facts
 * or resolutions out. No network, no model calls, no filesystem writes, and
 * no executing project code or config; they read only through FileReader.
 */
export interface LanguageAdapter<TTree = unknown> {
  /** "typescript", "python", "go", ... */
  readonly id: string;
  readonly tier: "A" | "B";
  readonly extensions: readonly string[];
  /** Bump to invalidate cached FileFacts. */
  readonly version: string;
  detectProjectRoots(repo: RepoView): ProjectRoot[];
  extract(file: ParsedFile<TTree>, cfg: ExtractorConfig): FileFacts;
  resolveImport(imp: RawImport, from: string, ctx: ResolveContext): Resolution;
  /** Returns [] until M5. */
  detectEntryPoints(ctx: ProjectContext): EntryPoint[];
  isTestFile(path: string): boolean;
}

/**
 * What the engine needs to parse an adapter's files, kept beside (not inside)
 * the CLAUDE.md adapter contract.
 */
export interface AdapterRegistration<TTree = unknown> {
  readonly adapter: LanguageAdapter<TTree>;
  /** Grammar name for a repo-relative path, or undefined if not this adapter's file. */
  grammarFor(path: string): string | undefined;
  /** GraphNode.language for a repo-relative path. */
  languageFor(path: string): string;
  /**
   * The package a file belongs to, for languages whose imports name packages
   * (ADR-013, Go): a member folds into the `pkg:` node `id`; a non-member (a
   * test file) stays a file node linked to it. Undefined: the file is its own
   * node. Pure, like the adapter.
   */
  packageFor?(
    path: string,
    ctx: ResolveContext,
  ): { readonly id: string; readonly member: boolean } | undefined;
}

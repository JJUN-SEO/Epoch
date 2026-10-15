import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  LANGUAGE_VERSION,
  Language,
  MIN_COMPATIBLE_VERSION,
  Parser,
  type Tree,
} from "web-tree-sitter";

/**
 * Grammar WASMs come from @vscode/tree-sitter-wasm, pinned together with
 * web-tree-sitter (ADR-002). A grammar is used only after passing a startup
 * self-test: its ABI must be in the runtime's supported range, and a canary
 * snippet must parse to the expected top-level node types without errors.
 */
export interface GrammarSpec {
  readonly name: string;
  readonly canary: string;
  readonly rootType: string;
  readonly statementTypes: readonly string[];
}

const JS_CANARY = 'import x from "./y";\nexport const A = () => <div />;\n';

export const GRAMMARS: Readonly<Record<string, GrammarSpec>> = {
  typescript: {
    name: "typescript",
    canary: 'import x from "./y";\nexport type T = string;\n',
    rootType: "program",
    statementTypes: ["import_statement", "export_statement"],
  },
  tsx: {
    name: "tsx",
    canary: JS_CANARY,
    rootType: "program",
    statementTypes: ["import_statement", "export_statement"],
  },
  javascript: {
    name: "javascript",
    canary: JS_CANARY,
    rootType: "program",
    statementTypes: ["import_statement", "export_statement"],
  },
  python: {
    name: "python",
    canary: "import os\nfrom . import x\n",
    rootType: "module",
    statementTypes: ["import_statement", "import_from_statement"],
  },
};

/** Throws unless `abi` is within the runtime's supported range. */
export function assertAbiSupported(
  grammar: string,
  abi: number,
  min: number = MIN_COMPATIBLE_VERSION,
  max: number = LANGUAGE_VERSION,
): void {
  if (abi < min || abi > max) {
    throw new Error(
      `Grammar ${grammar} has ABI ${String(abi)}, but web-tree-sitter supports ${String(min)}-${String(max)}. Pin web-tree-sitter and @vscode/tree-sitter-wasm together (ADR-002).`,
    );
  }
}

function wasmDir(): string {
  const require = createRequire(import.meta.url);
  return path.join(
    path.dirname(require.resolve("@vscode/tree-sitter-wasm/package.json")),
    "wasm",
  );
}

let runtime: Promise<void> | undefined;

/** Parsers for a set of grammars, each self-tested before first use. */
export class Parsers {
  private readonly languages: ReadonlyMap<string, Language>;
  private readonly parsers = new Map<string, Parser>();

  private constructor(languages: ReadonlyMap<string, Language>) {
    this.languages = languages;
  }

  static async load(names: Iterable<string>): Promise<Parsers> {
    runtime ??= Parser.init();
    await runtime;
    const dir = wasmDir();
    const languages = new Map<string, Language>();
    for (const name of new Set(names)) {
      const spec = GRAMMARS[name];
      if (!spec) throw new Error(`Unknown grammar: ${name}`);
      const bytes = fs.readFileSync(path.join(dir, `tree-sitter-${name}.wasm`));
      const language = await Language.load(bytes);
      assertAbiSupported(name, language.abiVersion);
      languages.set(name, language);
    }
    const parsers = new Parsers(languages);
    for (const name of languages.keys()) parsers.selfTest(name);
    return parsers;
  }

  private selfTest(name: string): void {
    const spec = GRAMMARS[name];
    if (!spec) throw new Error(`Unknown grammar: ${name}`);
    const tree = this.parse(name, spec.canary);
    try {
      const root = tree.rootNode;
      const types = root.namedChildren.map((n) => n.type);
      if (
        root.type !== spec.rootType ||
        root.hasError ||
        types.length !== spec.statementTypes.length ||
        types.some((t, i) => t !== spec.statementTypes[i])
      ) {
        throw new Error(
          `Grammar ${name} failed the startup self-test: got ${root.type}(${types.join(", ")})${root.hasError ? " with errors" : ""}`,
        );
      }
    } finally {
      tree.delete();
    }
  }

  language(name: string): Language {
    const language = this.languages.get(name);
    if (!language) throw new Error(`Grammar not loaded: ${name}`);
    return language;
  }

  /** Parses text; the caller must call tree.delete() to free WASM memory. */
  parse(name: string, text: string): Tree {
    let parser = this.parsers.get(name);
    if (!parser) {
      parser = new Parser();
      parser.setLanguage(this.language(name));
      this.parsers.set(name, parser);
    }
    const tree = parser.parse(text);
    if (!tree) throw new Error(`Parsing failed (${name})`);
    return tree;
  }

  dispose(): void {
    for (const p of this.parsers.values()) p.delete();
    this.parsers.clear();
  }
}

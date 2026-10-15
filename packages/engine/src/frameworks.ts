import { parse as parseToml } from "smol-toml";
import type { FileReader } from "@epoch-dev/core";
import {
  FRAMEWORKS,
  detectFrameworks,
  type DetectedFramework,
  type ManifestDependencies,
} from "@epoch-dev/findings";

/*
 * Declared dependencies, read as data for framework detection (ADR-007):
 * package.json (every dependency field), pyproject.toml ([project]
 * dependencies and extras, Poetry dependencies and groups) and
 * requirements*.txt. Nothing is installed, resolved or run.
 */

const MAX_MANIFEST_BYTES = 256 * 1024;

const dirOf = (p: string): string =>
  p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
const baseOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

type Table = Readonly<Record<string, unknown>>;
const isTable = (v: unknown): v is Table =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const at = (v: unknown, ...keys: string[]): unknown => {
  let cur = v;
  for (const k of keys) cur = isTable(cur) ? cur[k] : undefined;
  return cur;
};

/** PEP 503 normalized name of a PEP 508 requirement ("Django>=4" -> "django"). */
export function requirementName(req: string): string | undefined {
  const m = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/.exec(req);
  return m?.[1]?.toLowerCase().replace(/[-_.]+/g, "-");
}

const NPM_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

function npmDependencies(text: string): string[] {
  let pkg: unknown;
  try {
    pkg = JSON.parse(text);
  } catch {
    return [];
  }
  return NPM_FIELDS.flatMap((f) => {
    const deps = at(pkg, f);
    return isTable(deps) ? Object.keys(deps) : [];
  });
}

function pyprojectDependencies(text: string): string[] {
  let doc: unknown;
  try {
    doc = parseToml(text);
  } catch {
    return [];
  }
  const reqs: string[] = [];
  const list = (v: unknown) => {
    if (Array.isArray(v))
      for (const r of v) if (typeof r === "string") reqs.push(r);
  };
  list(at(doc, "project", "dependencies"));
  const extras = at(doc, "project", "optional-dependencies");
  if (isTable(extras)) for (const v of Object.values(extras)) list(v);
  const groups = at(doc, "dependency-groups");
  if (isTable(groups)) for (const v of Object.values(groups)) list(v);
  const names = reqs.flatMap((r) => requirementName(r) ?? []);
  const poetry = [
    at(doc, "tool", "poetry", "dependencies"),
    at(doc, "tool", "poetry", "dev-dependencies"),
  ];
  const poetryGroups = at(doc, "tool", "poetry", "group");
  if (isTable(poetryGroups)) {
    for (const g of Object.values(poetryGroups))
      poetry.push(at(g, "dependencies"));
  }
  for (const t of poetry) {
    if (isTable(t))
      names.push(...Object.keys(t).flatMap((k) => requirementName(k) ?? []));
  }
  return names;
}

function requirementsDependencies(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#") && !l.startsWith("-"))
    .flatMap((l) => requirementName(l) ?? []);
}

const REQUIREMENTS = /^requirements[\w.-]*\.txt$/;

/** Every manifest's declared dependencies, sorted by directory. */
export function manifestDependencies(
  root: string,
  files: readonly string[],
  reader: FileReader,
): ManifestDependencies[] {
  const byKey = new Map<
    string,
    { dir: string; ecosystem: "npm" | "python"; deps: Set<string> }
  >();
  for (const file of files) {
    const base = baseOf(file);
    const ecosystem =
      base === "package.json"
        ? "npm"
        : base === "pyproject.toml" || REQUIREMENTS.test(base)
          ? "python"
          : undefined;
    if (ecosystem === undefined || file.split("/").includes("node_modules"))
      continue;
    const text = reader.readFile(`${root}/${file}`);
    if (text === undefined || text.length > MAX_MANIFEST_BYTES) continue;
    const deps =
      base === "package.json"
        ? npmDependencies(text)
        : base === "pyproject.toml"
          ? pyprojectDependencies(text)
          : requirementsDependencies(text);
    const dir = dirOf(file);
    const key = `${ecosystem}\u0000${dir}`;
    const entry = byKey.get(key) ?? { dir, ecosystem, deps: new Set<string>() };
    for (const d of deps) entry.deps.add(d);
    byKey.set(key, entry);
  }
  return [...byKey.values()]
    .map((e) => ({
      dir: e.dir,
      ecosystem: e.ecosystem,
      dependencies: [...e.deps].sort(),
    }))
    .sort((a, b) =>
      a.dir < b.dir
        ? -1
        : a.dir > b.dir
          ? 1
          : a.ecosystem < b.ecosystem
            ? -1
            : 1,
    );
}

/** Frameworks detected in a project, from its manifests and marker files. */
export function frameworksOf(
  root: string,
  files: readonly string[],
  reader: FileReader,
): DetectedFramework[] {
  return detectFrameworks(
    manifestDependencies(root, files, reader),
    files,
    FRAMEWORKS,
  );
}

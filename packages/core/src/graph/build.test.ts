import { describe, expect, it } from "vitest";
import { CERTAIN_EDGE_KINDS, REACHABILITY_EDGE_KINDS } from "../policy.js";
import type { ExportInfo, RawImport, Resolution } from "../schemas/index.js";
import { buildGraph, type FileInput } from "./build.js";
import { reachable, reverseReachable } from "./reachability.js";

/* ---------- tiny DSL for hand-built inputs ---------- */

type Imp = RawImport & { res: Resolution };

const file = (id: string) => ({ kind: "file", target: id }) as const;

function imp(
  kind: RawImport["kind"],
  specifier: string | null,
  res: Resolution,
  names: string[] = [],
  opts: { typeOnly?: boolean; line?: number } = {},
): Imp {
  return {
    kind,
    specifier,
    typeOnly: opts.typeOnly ?? false,
    names: names.map((n) => ({ imported: n })),
    line: opts.line ?? 1,
    res,
  };
}

const rawOf = (i: Imp): RawImport => ({
  kind: i.kind,
  specifier: i.specifier,
  typeOnly: i.typeOnly,
  names: i.names,
  line: i.line,
});

/** `export { imported as name } from specifier` plus its reexport import. */
function reexport(
  name: string,
  specifier: string,
  target: string,
  imported = name,
) {
  return {
    exp: { name, from: { specifier, imported } } satisfies ExportInfo,
    imp: imp("reexport", specifier, file(target), [imported]),
  };
}

function input(
  id: string,
  parts: {
    imports?: Imp[];
    locals?: string[];
    reexports?: ReturnType<typeof reexport>[];
    stars?: [specifier: string, target: string | Resolution][];
  } = {},
): FileInput {
  const reexports = parts.reexports ?? [];
  const stars = parts.stars ?? [];
  const imports: Imp[] = [
    ...(parts.imports ?? []),
    ...reexports.map((r) => r.imp),
    ...stars.map(([spec, target]) =>
      imp(
        "reexport",
        spec,
        typeof target === "string" ? file(target) : target,
        ["*"],
      ),
    ),
  ];
  return {
    id,
    language: "typescript",
    loc: 1,
    contentHash: `h:${id}`,
    facts: {
      imports: imports.map(rawOf),
      exports: [
        ...(parts.locals ?? []).map((name) => ({ name })),
        ...reexports.map((r) => r.exp),
      ],
      exportAllFrom: stars.map(([spec]) => spec),
      flagUsages: [],
      constantConditions: [],
      strings: [],
      isGenerated: false,
      loc: 1,
    },
    resolutions: imports.map((i) => ({ imp: rawOf(i), res: i.res })),
  };
}

const edgesOf = (files: FileInput[]) =>
  buildGraph(files).edges.map((e) => {
    const ev = e.evidence.length ? ` [${e.evidence.join("; ")}]` : "";
    return `${e.source} -> ${e.target} : ${e.kind}${ev}`;
  });

/* ---------- the M1 acceptance barrel test ---------- */

describe("barrel transparency (PLAN.md M1 acceptance)", () => {
  const files = [
    input("app/A.ts", {
      imports: [
        imp("static", "../components", file("components/index.ts"), ["Card"]),
      ],
    }),
    input("components/index.ts", {
      reexports: [
        reexport("Button", "./Button", "components/Button.ts"),
        reexport("Card", "./Card", "components/Card.ts"),
      ],
    }),
    input("components/Button.ts", { locals: ["Button"] }),
    input("components/Card.ts", { locals: ["Card"] }),
  ];
  const g = buildGraph(files);

  it("emits the real dependency, the physical path and the barrel's re-exports", () => {
    expect(edgesOf(files)).toEqual([
      "app/A.ts -> components/Card.ts : import [via barrel components/index.ts]",
      "app/A.ts -> components/index.ts : via-barrel",
      "components/index.ts -> components/Button.ts : reexport",
      "components/index.ts -> components/Card.ts : reexport",
    ]);
  });

  it("keeps A out of Button's certain blast radius", () => {
    expect(
      reverseReachable(g, "components/Button.ts", CERTAIN_EDGE_KINDS).has(
        "app/A.ts",
      ),
    ).toBe(false);
    expect(
      reverseReachable(g, "components/Card.ts", CERTAIN_EDGE_KINDS).has(
        "app/A.ts",
      ),
    ).toBe(true);
  });

  it("still reaches the barrel from A for findings reachability", () => {
    expect(
      reachable(g, ["app/A.ts"], REACHABILITY_EDGE_KINDS).has(
        "components/index.ts",
      ),
    ).toBe(true);
  });

  it("counts fan-in and fan-out over certain edges only, distinct neighbours", () => {
    const byId = new Map(g.nodes.map((n) => [n.id, n.metrics]));
    expect(byId.get("app/A.ts")).toEqual({ fanIn: 0, fanOut: 1 });
    expect(byId.get("components/index.ts")).toEqual({ fanIn: 0, fanOut: 2 });
    expect(byId.get("components/Card.ts")).toEqual({ fanIn: 2, fanOut: 0 });
  });
});

/* ---------- tracing rules ---------- */

describe("barrel tracing", () => {
  const leaf = (id: string, ...locals: string[]) => input(id, { locals });

  it("traces names through `export *`", () => {
    expect(
      edgesOf([
        input("A.ts", {
          imports: [imp("static", "./b", file("b/index.ts"), ["Card"])],
        }),
        input("b/index.ts", {
          stars: [
            ["./Button", "b/Button.ts"],
            ["./Card", "b/Card.ts"],
          ],
        }),
        leaf("b/Button.ts", "Button"),
        leaf("b/Card.ts", "Card"),
      ]),
    ).toEqual([
      "A.ts -> b/Card.ts : import [via barrel b/index.ts]",
      "A.ts -> b/index.ts : via-barrel",
      "b/index.ts -> b/Button.ts : reexport",
      "b/index.ts -> b/Card.ts : reexport",
    ]);
  });

  it("falls back to a direct import when two star sources export the same name", () => {
    expect(
      edgesOf([
        input("A.ts", { imports: [imp("static", "./b", file("b.ts"), ["X"])] }),
        input("b.ts", {
          stars: [
            ["./c", "c.ts"],
            ["./d", "d.ts"],
          ],
        }),
        leaf("c.ts", "X"),
        leaf("d.ts", "X"),
      ]),
    ).toContain("A.ts -> b.ts : import");
  });

  it("follows chains of barrels and credits the first barrel", () => {
    expect(
      edgesOf([
        input("A.ts", {
          imports: [imp("static", "./ui", file("ui/index.ts"), ["Card"])],
        }),
        input("ui/index.ts", { stars: [["./cards", "ui/cards/index.ts"]] }),
        input("ui/cards/index.ts", {
          reexports: [reexport("Card", "./Card", "ui/cards/Card.ts")],
        }),
        leaf("ui/cards/Card.ts", "Card"),
      ]),
    ).toEqual([
      "A.ts -> ui/cards/Card.ts : import [via barrel ui/index.ts]",
      "A.ts -> ui/index.ts : via-barrel",
      "ui/cards/index.ts -> ui/cards/Card.ts : reexport",
      "ui/index.ts -> ui/cards/index.ts : reexport",
    ]);
  });

  it("traces default re-exports (`export { default as Button } from`)", () => {
    expect(
      edgesOf([
        input("A.ts", {
          imports: [imp("static", "./b", file("b.ts"), ["Button"])],
        }),
        input("b.ts", {
          reexports: [reexport("Button", "./Button", "Button.ts", "default")],
        }),
        leaf("Button.ts", "default"),
      ]),
    ).toContain("A.ts -> Button.ts : import [via barrel b.ts]");
  });

  it("never traces default imports through `export *`", () => {
    expect(
      edgesOf([
        input("A.ts", {
          imports: [imp("static", "./b", file("b.ts"), ["default"])],
        }),
        input("b.ts", { stars: [["./c", "c.ts"]] }),
        leaf("c.ts", "default"),
      ]),
    ).toContain("A.ts -> b.ts : import");
  });

  it("keeps namespace imports, side-effect imports and dynamic imports conservative", () => {
    const barrel = input("b.ts", { reexports: [reexport("X", "./c", "c.ts")] });
    expect(
      edgesOf([
        input("A.ts", {
          imports: [
            imp("static", "./b", file("b.ts"), ["*"], { line: 1 }),
            imp("side-effect", "./b", file("b.ts"), [], { line: 2 }),
          ],
        }),
        input("D.ts", { imports: [imp("dynamic", "./b", file("b.ts"))] }),
        barrel,
        leaf("c.ts", "X"),
      ]),
    ).toEqual([
      "A.ts -> b.ts : import",
      "D.ts -> b.ts : dynamic-import",
      "b.ts -> c.ts : reexport",
    ]);
  });

  it("splits a mixed import into a direct edge and traced edges", () => {
    expect(
      edgesOf([
        input("A.ts", {
          imports: [imp("static", "./b", file("b.ts"), ["helper", "Card"])],
        }),
        input("b.ts", {
          locals: ["helper"],
          reexports: [reexport("Card", "./Card", "Card.ts")],
        }),
        leaf("Card.ts", "Card"),
      ]),
    ).toEqual([
      "A.ts -> Card.ts : import [via barrel b.ts]",
      "A.ts -> b.ts : import",
      "A.ts -> b.ts : via-barrel",
      "b.ts -> Card.ts : reexport",
    ]);
  });

  it("treats cyclic re-exports as untraceable instead of looping", () => {
    expect(
      edgesOf([
        input("A.ts", { imports: [imp("static", "./b", file("b.ts"), ["X"])] }),
        input("b.ts", { stars: [["./c", "c.ts"]] }),
        input("c.ts", { stars: [["./b", "b.ts"]] }),
      ]),
    ).toContain("A.ts -> b.ts : import");
  });

  it("is conservative when a star source cannot be resolved to a file", () => {
    const g = buildGraph([
      input("A.ts", { imports: [imp("static", "./b", file("b.ts"), ["X"])] }),
      input("b.ts", {
        imports: [],
        stars: [["./c", "c.ts"]],
      }),
      leaf("c.ts", "X"),
    ]);
    expect(g.edges.some((e) => e.kind === "via-barrel")).toBe(true);
    const unknownStar = input("b.ts", {
      stars: [["lib-pkg", { kind: "external", name: "lib-pkg" }]],
    });
    expect(
      edgesOf([
        input("A.ts", { imports: [imp("static", "./b", file("b.ts"), ["X"])] }),
        unknownStar,
      ]),
    ).toEqual(["A.ts -> b.ts : import"]);
  });

  it("never concludes a name is absent from a partly parsed file", () => {
    // d.ts had syntax errors, so an X declared there may have been lost to
    // error recovery: tracing X through b.ts's stars must stay conservative.
    const files = (partial: boolean): FileInput[] => [
      input("A.ts", { imports: [imp("static", "./b", file("b.ts"), ["X"])] }),
      input("b.ts", {
        stars: [
          ["./c", "c.ts"],
          ["./d", "d.ts"],
        ],
      }),
      leaf("c.ts", "X"),
      { ...leaf("d.ts", "Y"), partial },
    ];
    expect(edgesOf(files(false))).toContain(
      "A.ts -> c.ts : import [via barrel b.ts]",
    );
    const conservative = edgesOf(files(true));
    expect(conservative).toContain("A.ts -> b.ts : import");
    expect(conservative.filter((e) => e.startsWith("A.ts"))).toEqual([
      "A.ts -> b.ts : import",
    ]);
  });

  it("gives type-only imports through a barrel the type-only kind", () => {
    expect(
      edgesOf([
        input("A.ts", {
          imports: [
            imp("static", "./b", file("b.ts"), ["T"], { typeOnly: true }),
          ],
        }),
        input("b.ts", { reexports: [reexport("T", "./t", "t.ts")] }),
        leaf("t.ts", "T"),
      ]),
    ).toEqual([
      "A.ts -> b.ts : via-barrel",
      "A.ts -> t.ts : type-only [via barrel b.ts]",
      "b.ts -> t.ts : reexport",
    ]);
  });
});

/* ---------- nodes, externals, unresolved, dedup ---------- */

describe("graph assembly", () => {
  it("records externals on nodes and unresolved imports with reasons", () => {
    const g = buildGraph([
      input("A.ts", {
        imports: [
          imp(
            "static",
            "react",
            { kind: "external", name: "react" },
            ["useState"],
            { line: 1 },
          ),
          imp(
            "static",
            "react/jsx-runtime",
            { kind: "external", name: "react" },
            [],
            { line: 2 },
          ),
          imp(
            "dynamic",
            null,
            {
              kind: "unresolved",
              reason: "dynamic-specifier",
              pathPrefix: "src/pages/",
            },
            [],
            { line: 3 },
          ),
          imp(
            "static",
            "./missing",
            { kind: "unresolved", reason: "not-found" },
            ["x"],
            { line: 4 },
          ),
        ],
        locals: ["a", "default"],
      }),
    ]);
    expect(g.nodes[0]?.externals).toEqual(["react"]);
    expect(g.nodes[0]?.exports).toEqual(["a", "default"]);
    expect(g.unresolved).toEqual([
      {
        from: "A.ts",
        specifier: null,
        reason: "dynamic-specifier",
        pathPrefix: "src/pages/",
        line: 3,
      },
      { from: "A.ts", specifier: "./missing", reason: "not-found", line: 4 },
    ]);
    expect(g.edges).toEqual([]);
  });

  it("deduplicates edges and merges evidence", () => {
    const files = [
      input("A.ts", {
        imports: [
          imp("static", "./b", file("b.ts"), ["x"], { line: 1 }),
          imp("require", "./b", file("b.ts"), [], { line: 2 }),
        ],
      }),
      input("b.ts", { locals: ["x"] }),
    ];
    expect(edgesOf(files)).toEqual(["A.ts -> b.ts : import"]);
  });

  it("produces a schema-valid graph with metrics but no uncomputed ones (ADR-011)", () => {
    const g = buildGraph([input("A.ts", { locals: ["a"] })]);
    expect(g.schemaVersion).toBe(1);
    expect(g.nodes[0]?.metrics).toEqual({ fanIn: 0, fanOut: 0 });
    expect(g.roots).toEqual([]);
    expect(g.findings).toEqual([]);
  });

  it("fails loudly when a resolution points at a file it was not given", () => {
    expect(() =>
      buildGraph([
        input("A.ts", { imports: [imp("static", "./x", file("x.ts"), ["x"])] }),
      ]),
    ).toThrow(/x\.ts/);
  });
});

describe("package nodes (ADR-013)", () => {
  const pkg = (id: string) => ({ kind: "package", target: id }) as const;
  const ext = (name: string) => ({ kind: "external", name }) as const;
  const inPackage = (
    f: FileInput,
    id: string,
    member: boolean,
    loc = 1,
  ): FileInput => ({
    ...f,
    language: "go",
    loc,
    package: { id, member },
  });
  const hashes: string[][] = [];
  const packageHash = (members: readonly string[]) => {
    hashes.push([...members]);
    return `pkg-hash(${members.join(",")})`;
  };
  const files = [
    inPackage(
      input("a/a2.go", {
        imports: [
          imp("static", "m/b", pkg("pkg:m/b"), ["*"], { line: 3 }),
          imp("static", "m/a", pkg("pkg:m/a"), ["*"], { line: 4 }),
          imp("static", "github.com/x/y", ext("github.com/x/y"), ["*"]),
          imp(
            "static",
            "m/missing",
            { kind: "unresolved", reason: "not-found" },
            ["*"],
            { line: 5 },
          ),
        ],
        locals: ["A2"],
      }),
      "pkg:m/a",
      true,
      2,
    ),
    inPackage(
      input("a/a.go", {
        imports: [
          imp("static", "m/b", pkg("pkg:m/b"), ["*"]),
          imp("static", "fmt", ext("go:fmt"), ["*"]),
        ],
        locals: ["A"],
      }),
      "pkg:m/a",
      true,
      3,
    ),
    inPackage(input("b/b.go", { locals: ["B"] }), "pkg:m/b", true),
    inPackage(
      input("a/a_test.go", {
        imports: [
          imp("static", "m/b", pkg("pkg:m/b"), ["*"]),
          imp("static", "testing", ext("go:testing"), ["*"]),
        ],
        locals: ["TestA"],
      }),
      "pkg:m/a",
      false,
    ),
    inPackage(
      input("b/b_test.go", {
        imports: [imp("static", "m/b", pkg("pkg:m/b"), ["*"])],
      }),
      "pkg:m/b",
      false,
    ),
    inPackage(input("c/c_test.go"), "pkg:m/c", false),
  ];

  it("folds members into one package node with merged attributes", () => {
    hashes.length = 0;
    const g = buildGraph(files, { packageHash });
    expect(g.nodes.map((n) => `${n.kind} ${n.id}`)).toEqual([
      "file a/a_test.go",
      "file b/b_test.go",
      "file c/c_test.go",
      "package pkg:m/a",
      "package pkg:m/b",
    ]);
    const a = g.nodes.find((n) => n.id === "pkg:m/a");
    expect(a).toMatchObject({
      language: "go",
      loc: 5,
      contentHash: "pkg-hash(h:a/a.go,h:a/a2.go)",
      exports: ["A", "A2"],
      externals: ["github.com/x/y", "go:fmt"],
      metrics: { fanIn: 1, fanOut: 1 },
    });
    expect(hashes).toContainEqual(["h:a/a.go", "h:a/a2.go"]);
    expect(g.nodes.find((n) => n.id === "pkg:m/b")?.metrics).toEqual({
      fanIn: 3,
      fanOut: 0,
    });
  });

  it("lifts member edges to the package, drops self-loops and links tests to their package", () => {
    expect(
      buildGraph(files, { packageHash }).edges.map((e) => {
        const ev = e.evidence.length ? ` [${e.evidence.join("; ")}]` : "";
        return `${e.source} -> ${e.target} : ${e.kind}${ev}`;
      }),
    ).toEqual([
      "a/a_test.go -> pkg:m/a : import [test file in the package directory]",
      "a/a_test.go -> pkg:m/b : import",
      "b/b_test.go -> pkg:m/b : import [test file in the package directory]",
      "pkg:m/a -> pkg:m/b : import",
    ]);
  });

  it("keeps the member file and line on unresolved imports", () => {
    expect(buildGraph(files, { packageHash }).unresolved).toEqual([
      { from: "a/a2.go", specifier: "m/missing", reason: "not-found", line: 5 },
    ]);
  });

  it("needs a hash function for package nodes", () => {
    expect(() => buildGraph(files)).toThrow(/packageHash/);
  });

  it("fails loudly when a resolution points at a package with no members", () => {
    expect(() =>
      buildGraph(
        [
          inPackage(
            input("a/a.go", {
              imports: [imp("static", "m/z", pkg("pkg:m/z"), ["*"])],
            }),
            "pkg:m/a",
            true,
          ),
        ],
        { packageHash },
      ),
    ).toThrow(/pkg:m\/z/);
  });
});

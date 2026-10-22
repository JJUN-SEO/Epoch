import { describe, expect, it } from "vitest";
import { isDirectoryPath, parseModFile } from "./modfile.js";

describe("parseModFile", () => {
  it("reads module, require and replace lines and blocks, with comments and quoting", () => {
    const f = parseModFile(
      [
        "// header comment",
        'module "example.com/m" // trailing',
        "",
        "go 1.22",
        "toolchain go1.24.7",
        "",
        "require example.com/a v1.0.0",
        "require (",
        "\texample.com/b v1.2.3 // indirect",
        "\t`example.com/c` v0.1.0",
        ")",
        "",
        "replace example.com/a => ../a",
        "replace (",
        "\texample.com/b v1.2.3 => example.com/fork/b v1.2.4",
        '\t"example.com/c" => "./third party/c"',
        ")",
        "exclude example.com/d v0.0.1",
        "retract v1.0.0",
      ].join("\r\n"),
    );
    expect(f).toEqual({
      module: "example.com/m",
      requires: ["example.com/a", "example.com/b", "example.com/c"],
      replaces: [
        { old: "example.com/a", new: "../a" },
        { old: "example.com/b", new: "example.com/fork/b" },
        { old: "example.com/c", new: "./third party/c" },
      ],
      uses: [],
    });
  });

  it("reads go.work use directives", () => {
    const f = parseModFile(
      "go 1.22\n\nuse ./app\nuse (\n\t./lib // the library\n\t.\n)\nreplace example.com/x => ./x\n",
    );
    expect(f.module).toBeUndefined();
    expect(f.uses).toEqual(["./app", "./lib", "."]);
    expect(f.replaces).toEqual([{ old: "example.com/x", new: "./x" }]);
  });

  it("does not split identifiers at a slash that does not start a comment", () => {
    expect(parseModFile("module example.com/a/b//c\n").module).toBe(
      "example.com/a/b",
    );
  });
});

describe("isDirectoryPath", () => {
  it("follows modfile's rule for replace targets", () => {
    for (const p of [
      ".",
      "..",
      "./x",
      "../x",
      ".\\x",
      "..\\x",
      "/abs",
      "C:\\x",
    ]) {
      expect(isDirectoryPath(p), p).toBe(true);
    }
    for (const p of ["example.com/x", "x", ".x"]) {
      expect(isDirectoryPath(p), p).toBe(false);
    }
  });
});

import { describe, expect, it } from "vitest";
import type { ProjectContext, RepoView } from "@epoch-dev/core";
import { detectEntryPoints, referenceModule } from "./entry-points.js";
import { detectProjectRoots } from "./roots.js";

/** An in-memory project: repo-relative path -> content. */
function project(files: Readonly<Record<string, string>>): ProjectContext {
  const root = "/repo";
  const rel = (p: string) => p.slice(root.length + 1);
  const view: RepoView = {
    root,
    files: Object.keys(files).sort(),
    reader: {
      readFile: (p) => files[rel(p)],
      fileExists: (p) => rel(p) in files,
      directoryExists: (p) =>
        Object.keys(files).some((f) => f.startsWith(`${rel(p)}/`)),
      getDirectories: () => [],
      realpath: (p) => p,
    },
  };
  return { repo: view, projectRoots: detectProjectRoots(view) };
}

const roots = (files: Readonly<Record<string, string>>) =>
  detectEntryPoints(project(files)).map((e) => [e.file, e.reason, e.source]);

const BUILD =
  '[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n';

describe("python entry points", () => {
  it("finds __main__.py, main guards and Django's conventional files", () => {
    expect(
      roots({
        "pkg/__main__.py": "",
        "run.py": 'if __name__ == "__main__":\n    pass\n',
        "other.py": "if __name__ == '__main__': pass\n",
        "lib.py": "x = '__main__'\n",
        "site/manage.py": "",
        "site/site/wsgi.py": "",
        "site/site/asgi.py": "",
      }),
    ).toEqual([
      ["other.py", "convention", 'if __name__ == "__main__"'],
      ["pkg/__main__.py", "convention", "__main__.py (entry-point name)"],
      ["run.py", "convention", 'if __name__ == "__main__"'],
      ["site/manage.py", "convention", "manage.py (entry-point name)"],
      ["site/site/asgi.py", "convention", "asgi.py (entry-point name)"],
      ["site/site/wsgi.py", "convention", "wsgi.py (entry-point name)"],
    ]);
  });

  it("finds executable scripts and tool configuration files", () => {
    expect(
      roots({
        "tools/run.py": "#!/usr/bin/env python3\nprint(1)\n",
        "docs/conf.py": "project = 'x'\n",
        "noxfile.py": "",
        "lib.py": "x = 1\n",
      }),
    ).toEqual([
      ["docs/conf.py", "config", "conf.py (tool configuration)"],
      ["noxfile.py", "config", "noxfile.py (tool configuration)"],
      ["tools/run.py", "convention", "executable script (#!)"],
    ]);
  });

  it("maps pyproject scripts, gui scripts, entry points and poetry scripts to modules", () => {
    expect(
      roots({
        "pyproject.toml": [
          "[project]",
          'name = "app"',
          "[project.scripts]",
          'app = "app._cli:main"',
          "[project.gui-scripts]",
          'app-gui = "app._gui:run [gui]"',
          '[project.entry-points."pytest11"]',
          'plug = "app._plugin"',
          "[tool.poetry.scripts]",
          'p1 = "app._poetry:main"',
          'p2 = { callable = "app._callable:main" }',
          'p3 = { reference = "bin/tool.py", type = "file" }',
        ].join("\n"),
        "app/__init__.py": "",
        "app/_cli.py": "",
        "app/_gui.py": "",
        "app/_plugin/__init__.py": "",
        "app/_poetry.py": "",
        "app/_callable.py": "",
        "bin/tool.py": "",
      }).filter(([, reason]) => reason === "manifest"),
    ).toEqual([
      ["app/_cli.py", "manifest", "pyproject.toml [project.scripts] app"],
      [
        "app/_gui.py",
        "manifest",
        "pyproject.toml [project.gui-scripts] app-gui",
      ],
      [
        "app/_plugin/__init__.py",
        "manifest",
        "pyproject.toml [project.entry-points.pytest11] plug",
      ],
      ["app/_poetry.py", "manifest", "pyproject.toml [tool.poetry.scripts] p1"],
      [
        "app/_callable.py",
        "manifest",
        "pyproject.toml [tool.poetry.scripts] p2",
      ],
      ["bin/tool.py", "manifest", "pyproject.toml [tool.poetry.scripts] p3"],
    ]);
  });

  it("reads setup.cfg console_scripts, under a src layout", () => {
    expect(
      roots({
        "setup.cfg": [
          "[metadata]",
          "name = app",
          "[options]",
          "package_dir =",
          "    =src",
          "[options.entry_points]",
          "console_scripts =",
          "    app = app._cli:main",
          "    # comment",
          "gui_scripts = app-gui = app._gui:main",
        ].join("\n"),
        "src/app/__init__.py": "",
        "src/app/_cli.py": "",
        "src/app/_gui.py": "",
      }).filter(([, , source]) => source?.includes("(public module") !== true),
    ).toEqual([
      ["src/app/_cli.py", "manifest", "setup.cfg console_scripts app"],
      ["src/app/_gui.py", "manifest", "setup.cfg gui_scripts"],
    ]);
  });

  it("makes public modules of distributable packages roots", () => {
    expect(
      roots({
        "pyproject.toml": `${BUILD}[project]\nname = "app"\n`,
        "src/app/__init__.py": "",
        "src/app/core.py": "",
        "src/app/_private.py": "",
        "src/app/_impl/__init__.py": "",
        "src/app/_impl/x.py": "",
        "src/app/sub/__init__.py": "",
        "src/app/sub/y.py": "",
        "src/app/nopkg/z.py": "",
        "tests/test_core.py": "",
      }),
    ).toEqual([
      ["src/app/__init__.py", "manifest", "pyproject.toml (public module app)"],
      [
        "src/app/core.py",
        "manifest",
        "pyproject.toml (public module app.core)",
      ],
      [
        "src/app/sub/__init__.py",
        "manifest",
        "pyproject.toml (public module app.sub)",
      ],
      [
        "src/app/sub/y.py",
        "manifest",
        "pyproject.toml (public module app.sub.y)",
      ],
    ]);
  });

  it("treats a pyproject without a build system, or poetry's package-mode = false, as an application", () => {
    const files = { "app/__init__.py": "", "app/core.py": "" };
    expect(
      roots({ "pyproject.toml": '[project]\nname = "app"\n', ...files }),
    ).toEqual([]);
    expect(
      roots({
        "pyproject.toml": `${BUILD}[tool.poetry]\nname = "app"\npackage-mode = false\n`,
        ...files,
      }),
    ).toEqual([]);
    expect(roots({ "setup.py": "", ...files }).map(([f]) => f)).toEqual([
      "app/__init__.py",
      "app/core.py",
      "setup.py", // a top-level module of the flat layout
      "setup.py", // and tool configuration
    ]);
  });

  it("parses entry-point references", () => {
    expect(referenceModule("pkg.mod:main")).toBe("pkg.mod");
    expect(referenceModule("pkg.mod:Cls.method [extra]")).toBe("pkg.mod");
    expect(referenceModule(" pkg . mod ")).toBe("pkg.mod");
    expect(referenceModule("pkg[extra]")).toBe("pkg");
    expect(referenceModule("not a ref")).toBeUndefined();
    expect(referenceModule("1bad:main")).toBeUndefined();
  });
});

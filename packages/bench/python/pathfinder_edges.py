"""Module import edges of one package, resolved by CPython's own finder, as JSON on stdout.

Usage: python -I pathfinder_edges.py <source root> <package>

A second ground truth for pnpm bench:accuracy-python, never part of Epoch
(ADR-006). It reads every import statement with Python's ast module, the way
grimp does (TYPE_CHECKING imports included), and resolves each module name
with the finders Python's import system uses for path entries (sys.path_hooks,
i.e. FileFinder), combining namespace portions as PathFinder does (PEP 420).
It walks each parent's search locations itself, so no module is imported and
no project code runs. (PathFinder itself is not called: for a namespace
package it builds a path that looks its parent up in sys.modules, which would
mean importing the parent.)
"""

import ast
import json
import os
import platform
import sys

source_root, package = sys.argv[1], sys.argv[2]
sys.dont_write_bytecode = True


def finder_for(entry):
    """The path-entry finder Python would use for a directory (sys.path_hooks)."""
    for hook in sys.path_hooks:
        try:
            return hook(entry)
        except ImportError:
            continue
    return None


def find_in(fullname, path):
    """PathFinder's search over path entries: the first module wins; directories
    without __init__.py collect as namespace portions."""
    portions = []
    for entry in path:
        finder = finder_for(entry)
        spec = finder.find_spec(fullname) if finder is not None else None
        if spec is None:
            continue
        if spec.loader is not None:
            return spec, None
        portions.extend(spec.submodule_search_locations or [])
    return (None, portions) if portions else None


def find(name):
    """(spec, None) for a module or regular package, (None, portions) for a
    namespace package, or None; imports nothing."""
    parts = name.split(".")
    found = find_in(parts[0], [source_root])
    for i in range(1, len(parts)):
        if found is None:
            return None
        spec, portions = found
        locations = portions if spec is None else spec.submodule_search_locations
        if not locations:
            return None
        found = find_in(".".join(parts[: i + 1]), list(locations))
    return found


def has_file(found):
    """A module or regular package (a namespace package has no file of its own)."""
    return found is not None and found[0] is not None and found[0].has_location


def internal(name):
    return name == package or name.startswith(package + ".")


# Every module of the package: each .py file under it that Python can import
# by its dotted name (the finder must give back that very file).
modules = {}
package_dir = os.path.join(source_root, *package.split("."))
for dirpath, dirnames, filenames in os.walk(package_dir):
    dirnames[:] = sorted(d for d in dirnames if d.isidentifier())
    rel = os.path.relpath(dirpath, source_root)
    prefix = rel.replace(os.sep, ".")
    for f in sorted(filenames):
        if not f.endswith(".py"):
            continue
        stem = f[: -len(".py")]
        if stem != "__init__" and not stem.isidentifier():
            continue
        name = prefix if stem == "__init__" else f"{prefix}.{stem}"
        found = find(name)
        path = os.path.join(dirpath, f)
        if has_file(found) and os.path.samefile(found[0].origin, path):
            modules[name] = path


def targets(importer, node):
    """Module names one import statement imports (before the finder checks them)."""
    if isinstance(node, ast.Import):
        return [a.name for a in node.names]
    if node.level == 0:
        base = node.module or ""
    else:
        is_package = os.path.basename(modules[importer]) == "__init__.py"
        parts = importer.split(".") if is_package else importer.split(".")[:-1]
        parts = parts[: len(parts) - (node.level - 1)] if node.level > 1 else parts
        base = ".".join(parts + ([node.module] if node.module else []))
    out = []
    for a in node.names:
        sub = f"{base}.{a.name}" if a.name != "*" else None
        # `from p import x` imports module p.x when there is one, else p.
        out.append(sub if sub is not None and has_file(find(sub)) else base)
    return out


edges = {}
for importer, path in sorted(modules.items()):
    with open(path, "rb") as fh:
        tree = ast.parse(fh.read(), filename=path)
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Import, ast.ImportFrom)):
            continue
        for name in targets(importer, node):
            if not name or not internal(name) or name == importer:
                continue
            if not has_file(find(name)):
                continue
            edges.setdefault((importer, name), set()).add(node.lineno)

json.dump(
    {
        "version": f"CPython {platform.python_version()}",
        "modules": sorted(modules),
        "edges": [
            {"importer": a, "imported": b, "lines": sorted(lines)}
            for (a, b), lines in sorted(edges.items())
        ],
    },
    sys.stdout,
)

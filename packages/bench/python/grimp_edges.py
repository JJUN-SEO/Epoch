"""Module import edges of one package, by grimp, as JSON on stdout.

Usage: python -I grimp_edges.py <source root> <package>

A benchmark aid for pnpm bench:accuracy-python, never part of Epoch
(ADR-006). grimp parses the package's files with Python's ast module and
does not import them. Its cache is off, so nothing is written next to the
analyzed checkout.
"""

import json
import sys
from importlib.metadata import version

source_root, package = sys.argv[1], sys.argv[2]
sys.path.insert(0, source_root)

import grimp  # noqa: E402

graph = grimp.build_graph(package, cache_dir=None)
edges = []
for importer in sorted(graph.modules):
    for imported in sorted(graph.find_modules_directly_imported_by(importer)):
        details = graph.get_import_details(importer=importer, imported=imported)
        edges.append(
            {
                "importer": importer,
                "imported": imported,
                "lines": sorted({d["line_number"] for d in details}),
            }
        )
json.dump(
    {"version": version("grimp"), "modules": sorted(graph.modules), "edges": edges},
    sys.stdout,
)

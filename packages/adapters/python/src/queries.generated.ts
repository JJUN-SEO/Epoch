// Generated from queries/python/ by scripts/gen-queries.mjs. Do not edit;
// edit the .scm file and run `node scripts/gen-queries.mjs`.

/** queries/python/imports.scm */
export const IMPORTS_QUERY = "; Module edges for Python. The adapter reads the details of each captured\n; node (names, aliases, relative levels, enclosing TYPE_CHECKING blocks); the\n; query only finds them.\n\n; import a.b; import a.b as c, d\n(import_statement) @import\n\n; from x import y; from . import y; from ..x import (y, z); from x import *\n(import_from_statement) @from\n\n; from __future__ import annotations\n(future_import_statement) @future\n\n; importlib.import_module(\"x\"), import_module(\"x\"), __import__(\"x\")\n(call\n  function: [\n    (identifier) @callee\n    (attribute attribute: (identifier) @callee)\n  ]\n  arguments: (argument_list) @args\n  (#any-of? @callee \"import_module\" \"__import__\")) @dynamic\n";

/** queries/python/strings.scm */
export const STRINGS_QUERY = "; String literals, for key-like strings (FileFacts.strings, ADR-014). The\n; adapter keeps plain literal values only (no f-strings or bytes).\n(string) @string\n";

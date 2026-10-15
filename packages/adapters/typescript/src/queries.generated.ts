// Generated from queries/typescript/ by scripts/gen-queries.mjs. Do not edit;
// edit the .scm file and run `node scripts/gen-queries.mjs`.

/** queries/typescript/imports.scm */
export const IMPORTS_QUERY = "; Module edges for TypeScript, TSX and JavaScript (one query for all three\n; grammars: it uses only node types they share). The adapter reads the\n; details of each captured node; the query only finds them.\n\n; import ... from \"x\"; import \"x\"; import x = require(\"x\")\n(import_statement) @import\n\n; export ... from \"x\"; export * from \"x\"; and local exports\n(export_statement) @export\n\n; import(\"x\"), import(`./pages/${name}`), import(variable)\n(call_expression\n  function: (import)\n  arguments: (arguments) @args) @dynamic\n\n; require(\"x\")\n(call_expression\n  function: (identifier) @callee\n  arguments: (arguments) @args\n  (#eq? @callee \"require\")) @require\n";

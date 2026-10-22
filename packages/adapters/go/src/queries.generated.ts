// Generated from queries/go/ by scripts/gen-queries.mjs. Do not edit;
// edit the .scm file and run `node scripts/gen-queries.mjs`.

/** queries/go/imports.scm */
export const IMPORTS_QUERY = "; Package imports for Go. The adapter reads each spec's name (alias, dot or\n; blank) and path; the query only finds them.\n\n; import \"a/b\"; import x \"a/b\"; import ( . \"a/b\"; _ \"c/d\" )\n(import_spec) @import\n";

/** queries/go/strings.scm */
export const STRINGS_QUERY = "; String literals, for key-like strings (FileFacts.strings, ADR-014).\n(interpreted_string_literal) @string\n(raw_string_literal) @string\n";

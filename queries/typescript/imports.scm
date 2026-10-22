; Module edges for TypeScript, TSX and JavaScript (one query for all three
; grammars: it uses only node types they share). The adapter reads the
; details of each captured node; the query only finds them.

; import ... from "x"; import "x"; import x = require("x")
(import_statement) @import

; export ... from "x"; export * from "x"; and local exports
(export_statement) @export

; import("x"), import(`./pages/${name}`), import(variable)
(call_expression
  function: (import)
  arguments: (arguments) @args) @dynamic

; require("x")
(call_expression
  function: (identifier) @callee
  arguments: (arguments) @args
  (#eq? @callee "require")) @require

; import.meta.resolve(`./${name}`), require.resolve("./x/" + name): a module
; path resolved at run time (the adapter keeps only those two objects)
(call_expression
  function: (member_expression
    property: (property_identifier) @method
    (#eq? @method "resolve")) @resolver
  arguments: (arguments) @args) @resolve

; new URL(`./workers/${name}.js`, import.meta.url)
(new_expression
  constructor: (identifier) @class
  arguments: (arguments) @args
  (#eq? @class "URL")) @url

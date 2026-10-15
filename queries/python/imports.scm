; Module edges for Python. The adapter reads the details of each captured
; node (names, aliases, relative levels, enclosing TYPE_CHECKING blocks); the
; query only finds them.

; import a.b; import a.b as c, d
(import_statement) @import

; from x import y; from . import y; from ..x import (y, z); from x import *
(import_from_statement) @from

; from __future__ import annotations
(future_import_statement) @future

; importlib.import_module("x"), import_module("x"), __import__("x")
(call
  function: [
    (identifier) @callee
    (attribute attribute: (identifier) @callee)
  ]
  arguments: (argument_list) @args
  (#any-of? @callee "import_module" "__import__")) @dynamic

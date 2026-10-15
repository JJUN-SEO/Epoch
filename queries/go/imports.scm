; Package imports for Go. The adapter reads each spec's name (alias, dot or
; blank) and path; the query only finds them.

; import "a/b"; import x "a/b"; import ( . "a/b"; _ "c/d" )
(import_spec) @import

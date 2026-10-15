// The module, with comments and quoting go.mod allows.
module "example.com/svc" // trailing comment

go 1.22

require github.com/pkg/errors v0.9.1

require (
	golang.org/x/sync v0.7.0 // indirect
	"golang.org/x/sync/v2" v2.0.0
)

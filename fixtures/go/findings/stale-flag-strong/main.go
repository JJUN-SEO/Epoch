package main

import (
	"context"

	"github.com/open-feature/go-sdk/openfeature"
)

func main() {
	client := openfeature.NewDefaultClient()
	if client.Boolean(context.TODO(), "new-checkout", false, openfeature.EvaluationContext{}) { // @C
		println("new")
	}
}

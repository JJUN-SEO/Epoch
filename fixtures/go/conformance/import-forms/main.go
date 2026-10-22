package main

import (
	al "example.com/forms/alias" // aliased
	. "example.com/forms/dot"
	_ "example.com/forms/blank"

	`example.com/forms/raw`
)

func main() { al.A(); D(); raw.R() }

package main

import "os"

func main() {
	if os.Getenv("FEATURE_DARK_MODE") == "1" { // @C
		println("dark")
	}
}

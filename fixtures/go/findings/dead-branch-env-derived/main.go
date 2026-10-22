package main

import "os"

var enabled = os.Getenv("FEATURE_X") == "1"

func main() {
	if enabled {
		println("on")
	}
}

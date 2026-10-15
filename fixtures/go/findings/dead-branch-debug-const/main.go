package main

const debug = false

func main() {
	if debug { // @C
		println("debug")
	} // @E
}

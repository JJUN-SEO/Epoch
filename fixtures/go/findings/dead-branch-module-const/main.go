package main

const enabled = false

func main() {
	if enabled { // @C
		println("never")
	} // @E
}

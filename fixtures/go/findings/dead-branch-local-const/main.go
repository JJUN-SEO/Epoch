package main

func main() {
	const enabled = false
	if enabled { // @C
		println("never")
	} // @E
}

package main

func main() {
	if false { // @C
		println("never")
	} // @E
}

package main

const EnableBeta = false

func main() {
	if EnableBeta { // @C
		println("never")
	} // @E
}

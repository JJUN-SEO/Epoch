module example.com/app

go 1.22

require (
	example.com/lib v1.0.0
	github.com/old/dep v1.0.0
)

replace example.com/lib => ./third_party/lib

replace github.com/old/dep v1.0.0 => github.com/new/dep v1.2.0

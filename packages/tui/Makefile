BINARY := af-tui
GOFLAGS := -ldflags="-s -w"

.PHONY: build run test clean

build:
	go build $(GOFLAGS) -o bin/$(BINARY) ./cmd/af-tui

run: build
	./bin/$(BINARY)

run-mock: build
	./bin/$(BINARY) --mock

test:
	go test ./...

clean:
	rm -rf bin/

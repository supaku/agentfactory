GOFLAGS := -ldflags="-s -w"

.PHONY: build build-tui build-status run run-mock test clean

build: build-tui build-status

build-tui:
	go build $(GOFLAGS) -o bin/af-tui ./cmd/af-tui

build-status:
	go build $(GOFLAGS) -o bin/af-status ./cmd/af-status

run: build-tui
	./bin/af-tui

run-mock: build-tui
	./bin/af-tui --mock

run-status: build-status
	./bin/af-status

run-status-mock: build-status
	./bin/af-status --mock

test:
	go test ./...

clean:
	rm -rf bin/

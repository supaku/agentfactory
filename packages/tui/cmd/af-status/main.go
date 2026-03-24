package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/RenseiAI/agentfactory/packages/tui/internal/api"
	"github.com/RenseiAI/agentfactory/packages/tui/internal/inline"
)

func main() {
	baseURL := flag.String("url", "http://localhost:3000", "AgentFactory server URL")
	mock := flag.Bool("mock", false, "Use mock data instead of live API")
	jsonMode := flag.Bool("json", false, "Output raw JSON stats")
	watch := flag.Bool("watch", false, "Auto-refresh mode")
	interval := flag.String("interval", "3s", "Watch refresh interval")
	flag.Parse()

	var ds api.DataSource
	if *mock {
		ds = api.NewMockClient()
	} else {
		ds = api.NewClient(*baseURL)
	}

	// JSON mode (non-watch): fetch and print stats as JSON
	if *jsonMode && !*watch {
		stats, err := ds.GetStats()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(stats); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		return
	}

	// Watch mode (with or without --json)
	if *watch {
		dur, err := time.ParseDuration(*interval)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: invalid interval %q: %v\n", *interval, err)
			os.Exit(1)
		}
		if err := inline.RunWatch(ds, inline.WatchConfig{
			Interval: dur,
			JSON:     *jsonMode,
		}); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		return
	}

	// Default: one-line human-readable summary
	if err := inline.PrintStatus(ds); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

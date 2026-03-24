package inline

import (
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/RenseiAI/agentfactory/packages/tui/internal/api"
)

// WatchConfig holds configuration for the watch loop.
type WatchConfig struct {
	Interval time.Duration
	JSON     bool
}

// RunWatch starts a watch loop that refreshes status at the configured interval.
// For TTY stdout: overwrites the line in-place using \r and ANSI clear-to-EOL.
// For non-TTY stdout (piped): prints a new line each interval.
// For JSON mode: emits newline-delimited JSON (NDJSON).
// Handles SIGINT/SIGTERM gracefully, exiting with code 0.
func RunWatch(ds api.DataSource, cfg WatchConfig) error {
	// Set up signal handling for graceful shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	isTTY := isTerminal(os.Stdout)
	ticker := time.NewTicker(cfg.Interval)
	defer ticker.Stop()

	// Print initial status immediately
	if err := printWatchLine(ds, cfg.JSON, isTTY); err != nil {
		return err
	}

	for {
		select {
		case <-sigCh:
			// Graceful exit on Ctrl+C
			if isTTY && !cfg.JSON {
				fmt.Fprint(os.Stdout, "\n")
			}
			return nil
		case <-ticker.C:
			if err := printWatchLine(ds, cfg.JSON, isTTY); err != nil {
				// Print error to stderr but keep watching
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			}
		}
	}
}

func printWatchLine(ds api.DataSource, jsonMode bool, isTTY bool) error {
	stats, err := ds.GetStats()
	if err != nil {
		return err
	}

	if jsonMode {
		// NDJSON: one JSON object per line
		data, err := json.Marshal(stats)
		if err != nil {
			return err
		}
		fmt.Fprintln(os.Stdout, string(data))
		return nil
	}

	now := time.Now().Format("15:04:05")
	line := fmt.Sprintf("[%s] %s", now, FormatStatusLine(stats))

	if isTTY {
		// Overwrite in place: carriage return + clear to end of line
		fmt.Fprintf(os.Stdout, "\r\033[K%s", line)
	} else {
		// Piped: new line each time
		fmt.Fprintln(os.Stdout, line)
	}

	return nil
}

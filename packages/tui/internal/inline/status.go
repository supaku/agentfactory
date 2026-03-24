package inline

import (
	"fmt"
	"time"

	"github.com/RenseiAI/agentfactory/packages/tui/internal/api"
)

// ANSI codes for chrome styling
const (
	ansiReset = "\033[0m"
	ansiCyan  = "\033[36m"
	ansiGray  = "\033[90m"
	ansiBold  = "\033[1m"
	ansiClear = "\033[K"
)

// PrintStatus fetches fleet stats and prints a one-line summary to stdout.
// Chrome (header, timestamp) goes to stderr for pipe compatibility.
func PrintStatus(ds api.DataSource) error {
	// Chrome: show fetching indicator
	Chrome("\r%s\u2819 Fetching...%s%s", ansiGray, ansiReset, ansiClear)

	stats, err := ds.GetStats()
	if err != nil {
		// Clear the fetching indicator on error
		Chrome("\r%s", ansiClear)
		return err
	}

	// Chrome: clear fetching indicator, show header
	Chrome("\r%s", ansiClear)
	ChromeLn("%s%sFleet Status:%s", ansiBold, ansiCyan, ansiReset)

	// Data: the actual status line goes to stdout
	DataLn("%s", FormatStatusLine(stats))

	// Chrome: show timestamp
	ChromeLn("%sUpdated: %s%s", ansiGray, time.Now().Format("15:04:05"), ansiReset)

	return nil
}

// FormatStatusLine renders a one-line fleet summary from stats.
func FormatStatusLine(stats *api.StatsResponse) string {
	return fmt.Sprintf("%d workers | %d agents | %d queued | %d completed | $%.2f today",
		stats.WorkersOnline,
		stats.AgentsWorking,
		stats.QueueDepth,
		stats.CompletedToday,
		stats.TotalCostToday,
	)
}

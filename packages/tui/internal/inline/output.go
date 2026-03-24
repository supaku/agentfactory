package inline

import (
	"fmt"
	"os"
)

// DataWriter writes to stdout — data only, pipe-safe.
// This is where machine-parseable output goes.
var DataWriter = os.Stdout

// ChromeWriter writes to stderr — decorations, spinners, labels.
// This is where TUI chrome goes so it doesn't corrupt piped data.
var ChromeWriter = os.Stderr

// Chrome prints decorative output to stderr if stderr is a TTY.
// When stderr is not a TTY (e.g., 2>/dev/null), chrome is suppressed.
func Chrome(format string, args ...any) {
	if !isTerminal(ChromeWriter) {
		return
	}
	fmt.Fprintf(ChromeWriter, format, args...)
}

// ChromeLn prints decorative output to stderr with a newline, if stderr is a TTY.
func ChromeLn(format string, args ...any) {
	if !isTerminal(ChromeWriter) {
		return
	}
	fmt.Fprintf(ChromeWriter, format+"\n", args...)
}

// Data prints machine-parseable output to stdout.
func Data(format string, args ...any) {
	fmt.Fprintf(DataWriter, format, args...)
}

// DataLn prints machine-parseable output to stdout with a newline.
func DataLn(format string, args ...any) {
	fmt.Fprintf(DataWriter, format+"\n", args...)
}

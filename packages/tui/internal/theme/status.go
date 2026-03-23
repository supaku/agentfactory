package theme

import (
	"image/color"

	"github.com/RenseiAI/agentfactory/packages/tui/internal/api"
)

// StatusStyle defines the visual representation of a session status.
type StatusStyle struct {
	Label   string
	Color   color.Color
	Symbol  string
	Animate bool
}

// GetStatusStyle returns the visual style for a session status.
func GetStatusStyle(status api.SessionStatus) StatusStyle {
	switch status {
	case api.StatusWorking:
		return StatusStyle{"Working", StatusSuccess, "\u25cf", true} // ●
	case api.StatusQueued:
		return StatusStyle{"Queued", StatusWarning, "\u25cc", true} // ◌
	case api.StatusParked:
		return StatusStyle{"Parked", TextTertiary, "\u25cb", false} // ○
	case api.StatusCompleted:
		return StatusStyle{"Done", StatusSuccess, "\u2713", false} // ✓
	case api.StatusFailed:
		return StatusStyle{"Failed", StatusError, "\u2717", false} // ✗
	case api.StatusStopped:
		return StatusStyle{"Stopped", TextTertiary, "\u25a0", false} // ■
	default:
		return StatusStyle{"Unknown", TextSecondary, "?", false}
	}
}

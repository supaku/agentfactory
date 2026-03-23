package detail

import (
	"charm.land/lipgloss/v2"
	"github.com/RenseiAI/agentfactory/packages/tui/internal/api"
	"github.com/RenseiAI/agentfactory/packages/tui/internal/format"
	"github.com/RenseiAI/agentfactory/packages/tui/internal/theme"
)

type timelineEvent struct {
	label     string
	timestamp string
	detail    string
	color     lipgloss.Style
	active    bool
}

// renderTimeline renders a vertical timeline of session events.
func renderTimeline(s api.SessionDetail, width int, frame int) string {
	events := buildTimeline(s)

	titleStyle := theme.SectionTitle()
	title := titleStyle.Render("TIMELINE")

	var rows []string
	rows = append(rows, title)

	for i, e := range events {
		dot := "\u25cf" // ●
		if e.active && frame%2 == 0 {
			dot = e.color.Bold(true).Render(dot)
		} else {
			dot = e.color.Render(dot)
		}

		label := lipgloss.NewStyle().Foreground(theme.TextPrimary).Width(14).Render(e.label)
		ts := theme.Muted().Render(e.timestamp)

		row := "  " + dot + " " + label + ts
		if e.detail != "" {
			row += "    " + theme.Dimmed().Render(e.detail)
		}
		rows = append(rows, row)

		// Connector line between events
		if i < len(events)-1 {
			connector := lipgloss.NewStyle().Foreground(theme.SurfaceBorder).Render("  \u2502") // │
			rows = append(rows, connector)
		}
	}

	return lipgloss.NewStyle().Padding(1, 1).Width(width).Render(
		lipgloss.JoinVertical(lipgloss.Left, rows...),
	)
}

func buildTimeline(s api.SessionDetail) []timelineEvent {
	blueStyle := lipgloss.NewStyle().Foreground(theme.Blue)
	greenStyle := lipgloss.NewStyle().Foreground(theme.StatusSuccess)
	yellowStyle := lipgloss.NewStyle().Foreground(theme.StatusWarning)
	redStyle := lipgloss.NewStyle().Foreground(theme.StatusError)

	events := []timelineEvent{
		{
			label:     "Created",
			timestamp: format.Timestamp(s.Timeline.Created),
			color:     blueStyle,
		},
	}

	if s.Timeline.Queued != nil {
		events = append(events, timelineEvent{
			label:     "Queued",
			timestamp: format.Timestamp(*s.Timeline.Queued),
			color:     yellowStyle,
		})
	}

	if s.Timeline.Started != nil {
		events = append(events, timelineEvent{
			label:     "Started",
			timestamp: format.Timestamp(*s.Timeline.Started),
			color:     greenStyle,
		})
	}

	// Terminal event or active indicator
	if s.Timeline.Completed != nil {
		label := "Completed"
		color := greenStyle
		if s.Status == api.StatusFailed {
			label = "Failed"
			color = redStyle
		} else if s.Status == api.StatusStopped {
			label = "Stopped"
			color = lipgloss.NewStyle().Foreground(theme.TextTertiary)
		}
		events = append(events, timelineEvent{
			label:     label,
			timestamp: format.Timestamp(*s.Timeline.Completed),
			color:     color,
		})
	} else if s.Status == api.StatusWorking {
		events = append(events, timelineEvent{
			label:  "Running...",
			timestamp: format.Duration(s.Duration) + " elapsed",
			color:  greenStyle,
			active: true,
		})
	} else if s.Status == api.StatusQueued {
		events = append(events, timelineEvent{
			label:     "Waiting...",
			timestamp: "in queue",
			color:     yellowStyle,
			active:    true,
		})
	}

	return events
}

package detail

import (
	"charm.land/lipgloss/v2"
	"github.com/RenseiAI/agentfactory/packages/tui/internal/api"
	"github.com/RenseiAI/agentfactory/packages/tui/internal/format"
	"github.com/RenseiAI/agentfactory/packages/tui/internal/theme"
)

// renderMetadata renders the metadata grid for a session.
func renderMetadata(s api.SessionDetail, width int) string {
	labelStyle := theme.StatLabel()
	valueStyle := theme.StatValue()

	wtColor := theme.GetWorkTypeColor(s.WorkType)
	wtLabel := theme.GetWorkTypeLabel(s.WorkType)

	colWidth := (width - 4) / 4
	if colWidth < 14 {
		colWidth = 14
	}

	cols := []string{
		lipgloss.NewStyle().Width(colWidth).Render(
			lipgloss.JoinVertical(lipgloss.Left,
				labelStyle.Render("WORK TYPE"),
				lipgloss.NewStyle().Foreground(wtColor).Bold(true).Render(wtLabel),
			),
		),
		lipgloss.NewStyle().Width(colWidth).Render(
			lipgloss.JoinVertical(lipgloss.Left,
				labelStyle.Render("DURATION"),
				valueStyle.Render(format.Duration(s.Duration)),
			),
		),
		lipgloss.NewStyle().Width(colWidth).Render(
			lipgloss.JoinVertical(lipgloss.Left,
				labelStyle.Render("COST"),
				theme.StatValueTeal().Render(format.Cost(nil)),
			),
		),
		lipgloss.NewStyle().Width(colWidth).Render(
			lipgloss.JoinVertical(lipgloss.Left,
				labelStyle.Render("STARTED"),
				valueStyle.Render(format.Timestamp(s.StartedAt)),
			),
		),
	}

	// For narrow terminals, use 2 columns
	if width < 80 {
		cols = cols[:2]
	}

	row := lipgloss.JoinHorizontal(lipgloss.Top, cols...)

	return lipgloss.NewStyle().
		Padding(0, 1).
		Width(width).
		BorderBottom(true).
		BorderStyle(lipgloss.NormalBorder()).
		BorderForeground(theme.SurfaceBorder).
		Render(row)
}

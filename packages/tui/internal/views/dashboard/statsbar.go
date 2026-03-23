package dashboard

import (
	"fmt"
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/RenseiAI/agentfactory/packages/tui/internal/api"
	"github.com/RenseiAI/agentfactory/packages/tui/internal/theme"
)

// renderStatsBar renders the horizontal stats bar showing fleet metrics.
func renderStatsBar(stats *api.StatsResponse, width int) string {
	if stats == nil {
		return theme.Muted().Width(width).Render("  Loading fleet stats...")
	}

	type stat struct {
		label string
		value string
		style lipgloss.Style
	}

	items := []stat{
		{"Workers", fmt.Sprintf("%d", stats.WorkersOnline), theme.StatValue()},
		{"Active", fmt.Sprintf("%d", stats.AgentsWorking), theme.StatValueAccent()},
		{"Queued", fmt.Sprintf("%d", stats.QueueDepth), theme.StatValue()},
		{"Completed", fmt.Sprintf("%d", stats.CompletedToday), theme.StatValue()},
		{"Capacity", fmt.Sprintf("%d", stats.AvailableCapacity), theme.StatValue()},
		{"Cost Today", fmt.Sprintf("$%.2f", stats.TotalCostToday), theme.StatValueTeal()},
	}

	// Calculate available width per stat column
	padding := 2 // left padding
	numItems := len(items)
	colWidth := (width - padding) / numItems
	if colWidth < 12 {
		colWidth = 12
	}

	// If terminal is narrow, drop less important stats
	if width < 80 {
		items = items[:4] // Workers, Active, Queued, Completed
		colWidth = (width - padding) / len(items)
	}

	cols := make([]string, len(items))
	for i, item := range items {
		label := theme.StatLabel().Render(item.label)
		value := item.style.Render(item.value)
		cell := lipgloss.JoinVertical(lipgloss.Left, label, value)
		cols[i] = lipgloss.NewStyle().Width(colWidth).Render(cell)
	}

	bar := lipgloss.JoinHorizontal(lipgloss.Top, cols...)

	borderStyle := lipgloss.NewStyle().
		BorderBottom(true).
		BorderStyle(lipgloss.NormalBorder()).
		BorderForeground(theme.SurfaceBorder).
		Padding(0, 1).
		Width(width)

	return borderStyle.Render(strings.TrimRight(bar, " "))
}

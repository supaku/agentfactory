package dashboard

import (
	"fmt"
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/RenseiAI/agentfactory/packages/tui/internal/api"
	format "github.com/RenseiAI/agentfactory/packages/tui/internal/format"
	"github.com/RenseiAI/agentfactory/packages/tui/internal/theme"
)

// column widths as fractions of total width
type columnLayout struct {
	status     int
	identifier int
	workType   int
	duration   int
	cost       int
	provider   int
}

func computeColumns(width int) columnLayout {
	if width < 60 {
		return columnLayout{
			status:     3,
			identifier: 12,
			workType:   14,
			duration:   10,
			cost:       0,
			provider:   0,
		}
	}
	if width < 80 {
		return columnLayout{
			status:     3,
			identifier: 12,
			workType:   16,
			duration:   10,
			cost:       10,
			provider:   0,
		}
	}
	return columnLayout{
		status:     3,
		identifier: 12,
		workType:   18,
		duration:   12,
		cost:       10,
		provider:   12,
	}
}

func (c columnLayout) total() int {
	return c.status + c.identifier + c.workType + c.duration + c.cost + c.provider
}

// renderTableHeader renders the table column headers.
func renderTableHeader(width int) string {
	cols := computeColumns(width)
	style := theme.TableHeader()

	parts := []string{
		style.Width(cols.status).Render(""),
		style.Width(cols.identifier).Render("IDENTIFIER"),
		style.Width(cols.workType).Render("WORK TYPE"),
		style.Width(cols.duration).Render("DURATION"),
	}
	if cols.cost > 0 {
		parts = append(parts, style.Width(cols.cost).Render("COST"))
	}
	if cols.provider > 0 {
		parts = append(parts, style.Width(cols.provider).Render("PROVIDER"))
	}

	row := lipgloss.JoinHorizontal(lipgloss.Top, parts...)

	return lipgloss.NewStyle().
		Padding(0, 1).
		Width(width).
		BorderBottom(true).
		BorderStyle(lipgloss.NormalBorder()).
		BorderForeground(theme.SurfaceBorder).
		Render(row)
}

// renderTableRow renders a single session row.
func renderTableRow(s api.SessionResponse, width int, selected bool, frame int) string {
	cols := computeColumns(width)
	ss := theme.GetStatusStyle(s.Status)

	var rowStyle lipgloss.Style
	if selected {
		rowStyle = theme.TableRowSelected()
	} else {
		rowStyle = theme.TableRow()
	}

	// Animated status symbol: pulse by toggling between bright and dim
	symbol := ss.Symbol
	if ss.Animate && frame%2 == 0 {
		symbol = lipgloss.NewStyle().Foreground(ss.Color).Bold(true).Render(symbol)
	} else {
		symbol = lipgloss.NewStyle().Foreground(ss.Color).Render(symbol)
	}

	wtColor := theme.GetWorkTypeColor(s.WorkType)
	wtLabel := theme.GetWorkTypeLabel(s.WorkType)

	parts := []string{
		lipgloss.NewStyle().Width(cols.status).Render(symbol),
		rowStyle.Width(cols.identifier).Render(s.Identifier),
		lipgloss.NewStyle().Width(cols.workType).Foreground(wtColor).Render(wtLabel),
		rowStyle.Width(cols.duration).Render(format.Duration(s.Duration)),
	}
	if cols.cost > 0 {
		parts = append(parts, rowStyle.Width(cols.cost).Render(format.Cost(s.CostUsd)))
	}
	if cols.provider > 0 {
		parts = append(parts, theme.Muted().Width(cols.provider).Render(format.ProviderName(s.Provider)))
	}

	row := lipgloss.JoinHorizontal(lipgloss.Top, parts...)

	return lipgloss.NewStyle().Padding(0, 1).Width(width).Render(row)
}

// filterSessions returns sessions matching the filter text (case-insensitive).
func filterSessions(sessions []api.SessionResponse, filterText string) []api.SessionResponse {
	if filterText == "" {
		return sessions
	}
	filter := strings.ToLower(filterText)
	var result []api.SessionResponse
	for _, s := range sessions {
		if strings.Contains(strings.ToLower(s.Identifier), filter) ||
			strings.Contains(strings.ToLower(s.WorkType), filter) ||
			strings.Contains(strings.ToLower(string(s.Status)), filter) {
			result = append(result, s)
		}
	}
	return result
}

// renderFilterBar renders the active filter input.
func renderFilterBar(filterText string, width int) string {
	prompt := lipgloss.NewStyle().Foreground(theme.Accent).Bold(true).Render("/")
	text := lipgloss.NewStyle().Foreground(theme.TextPrimary).Render(filterText)
	cursor := lipgloss.NewStyle().Foreground(theme.Accent).Render("_")

	return lipgloss.NewStyle().
		Padding(0, 1).
		Width(width).
		Background(theme.SurfaceRaised).
		Render(fmt.Sprintf(" %s %s%s", prompt, text, cursor))
}

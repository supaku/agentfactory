package detail

import (
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/RenseiAI/agentfactory/packages/tui/internal/theme"
)

func renderHelpOverlay(content string, width, height int) string {
	helpLines := []struct{ key, desc string }{
		{"esc", "Back to fleet dashboard"},
		{"j/k or \u2191/\u2193", "Scroll activity stream"},
		{"g/G", "Jump to top/bottom"},
		{"ctrl+u/ctrl+d", "Page up/down"},
		{"f", "Toggle auto-follow"},
		{"s", "Stop agent"},
		{"p", "Forward prompt to agent"},
		{"r", "Manual refresh"},
		{"?", "Toggle this help"},
		{"ctrl+k", "Command palette"},
		{"q", "Quit"},
	}

	title := lipgloss.NewStyle().
		Foreground(theme.TextPrimary).
		Bold(true).
		Render("KEYBINDINGS")

	var rows []string
	rows = append(rows, title)
	rows = append(rows, "")

	for _, h := range helpLines {
		key := lipgloss.NewStyle().
			Foreground(theme.Teal).
			Bold(true).
			Width(18).
			Render(h.key)
		desc := lipgloss.NewStyle().
			Foreground(theme.TextSecondary).
			Render(h.desc)
		rows = append(rows, "  "+key+desc)
	}

	rows = append(rows, "")
	rows = append(rows, theme.Dimmed().Render("  Press ? or esc to close"))

	helpContent := strings.Join(rows, "\n")

	overlayWidth := 50
	if width < 60 {
		overlayWidth = width - 4
	}

	overlay := lipgloss.NewStyle().
		Width(overlayWidth).
		Padding(1, 2).
		Background(theme.Surface).
		Border(lipgloss.RoundedBorder()).
		BorderForeground(theme.SurfaceBorderBright).
		Render(helpContent)

	return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center, overlay,
		lipgloss.WithWhitespaceStyle(lipgloss.NewStyle().Foreground(theme.BgPrimary)),
	)
}

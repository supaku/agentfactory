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

	// Row 1: Issue title
	issueTitle := "--"
	if s.IssueTitle != nil {
		issueTitle = *s.IssueTitle
	}
	maxTitleLen := width - 14 // "  Issue:  " prefix + padding
	if maxTitleLen < 20 {
		maxTitleLen = 20
	}
	if len(issueTitle) > maxTitleLen {
		issueTitle = issueTitle[:maxTitleLen-3] + "..."
	}
	row1 := "  " + labelStyle.Render("Issue: ") + valueStyle.Render(issueTitle)

	// Row 2: Branch, Provider, Cost
	branchVal := "--"
	if s.Branch != nil {
		branchVal = *s.Branch
	}
	providerVal := format.ProviderName(s.Provider)
	costVal := format.Cost(s.CostUsd)

	row2Parts := []string{
		labelStyle.Render("Branch: ") + valueStyle.Render(branchVal),
		labelStyle.Render("Provider: ") + theme.Muted().Render(providerVal),
		labelStyle.Render("Cost: ") + theme.StatValueTeal().Render(costVal),
	}
	row2 := "  " + lipgloss.JoinHorizontal(lipgloss.Top,
		lipgloss.NewStyle().Width((width-4)/3).Render(row2Parts[0]),
		lipgloss.NewStyle().Width((width-4)/3).Render(row2Parts[1]),
		lipgloss.NewStyle().Width((width-4)/3).Render(row2Parts[2]),
	)

	rows := []string{row1, row2}

	// Row 3: Duration, Tokens (skip for narrow terminals)
	if width >= 80 {
		durationVal := format.Duration(s.Duration)
		inputTokens := format.Tokens(s.InputTokens)
		outputTokens := format.Tokens(s.OutputTokens)
		tokensVal := inputTokens + " in / " + outputTokens + " out"

		row3Parts := []string{
			labelStyle.Render("Duration: ") + valueStyle.Render(durationVal),
			labelStyle.Render("Tokens: ") + theme.Muted().Render(tokensVal),
		}
		row3 := "  " + lipgloss.JoinHorizontal(lipgloss.Top,
			lipgloss.NewStyle().Width((width-4)/3).Render(row3Parts[0]),
			lipgloss.NewStyle().Width((width-4)*2/3).Render(row3Parts[1]),
		)
		rows = append(rows, row3)
	}

	content := lipgloss.JoinVertical(lipgloss.Left, rows...)

	return lipgloss.NewStyle().
		Padding(0, 0).
		Width(width).
		BorderBottom(true).
		BorderStyle(lipgloss.NormalBorder()).
		BorderForeground(theme.SurfaceBorder).
		Render(content)
}

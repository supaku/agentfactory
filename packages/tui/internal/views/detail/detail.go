package detail

import (
	"strings"
	"time"

	"charm.land/lipgloss/v2"
	tea "charm.land/bubbletea/v2"
	"github.com/RenseiAI/agentfactory/packages/tui/internal/api"
	"github.com/RenseiAI/agentfactory/packages/tui/internal/theme"
)

// NavigateBackMsg is sent when the user wants to go back to the dashboard.
type NavigateBackMsg struct{}

type detailDataMsg struct {
	detail *api.SessionDetailResponse
	err    error
}

type detailTickMsg struct{}

// Model is the Agent Detail view model.
type Model struct {
	dataSource api.DataSource
	session    *api.SessionDetail
	sessionID  string
	width      int
	height     int
	focused    bool
	loading    bool
	err        error
	frame      int
}

// New creates a new detail model.
func New(ds api.DataSource) *Model {
	return &Model{
		dataSource: ds,
	}
}

// SetSession sets the session ID to display and starts loading.
func (m *Model) SetSession(id string) {
	m.sessionID = id
	m.loading = true
	m.session = nil
}

// SetSize updates the available render size.
func (m *Model) SetSize(width, height int) {
	m.width = width
	m.height = height
}

// Focus marks the detail view as focused.
func (m *Model) Focus() { m.focused = true }

// Blur marks the detail view as unfocused.
func (m *Model) Blur() { m.focused = false }

// Init starts the data fetch for the selected session.
func (m *Model) Init() tea.Cmd {
	return tea.Batch(m.fetchDetail(), m.tickCmd())
}

func (m *Model) fetchDetail() tea.Cmd {
	id := m.sessionID
	return func() tea.Msg {
		detail, err := m.dataSource.GetSessionDetail(id)
		return detailDataMsg{detail: detail, err: err}
	}
}

func (m *Model) tickCmd() tea.Cmd {
	return tea.Tick(3*time.Second, func(t time.Time) tea.Msg {
		return detailTickMsg{}
	})
}

// Update handles messages for the detail view.
func (m *Model) Update(msg tea.Msg) tea.Cmd {
	switch msg := msg.(type) {
	case detailDataMsg:
		m.loading = false
		if msg.detail != nil {
			m.session = &msg.detail.Session
		}
		if msg.err != nil {
			m.err = msg.err
		}

	case detailTickMsg:
		m.frame++
		return tea.Batch(m.fetchDetail(), m.tickCmd())

	case tea.KeyPressMsg:
		switch msg.String() {
		case "esc":
			return func() tea.Msg { return NavigateBackMsg{} }
		case "r":
			return m.fetchDetail()
		}
	}
	return nil
}

// Render returns the detail view as a rendered string.
func (m *Model) Render() string {
	if m.width == 0 {
		return ""
	}

	var sections []string

	// Back navigation header
	backStyle := lipgloss.NewStyle().
		Foreground(theme.TextSecondary).
		Background(theme.Surface).
		Padding(0, 1).
		Width(m.width)
	sections = append(sections, backStyle.Render("\u2190 Back (esc)"))

	if m.loading || m.session == nil {
		sections = append(sections, theme.Muted().Padding(1, 2).Render("Loading session detail..."))
		return lipgloss.JoinVertical(lipgloss.Left, sections...)
	}

	s := *m.session

	// Session header: status symbol + identifier + status label
	ss := theme.GetStatusStyle(s.Status)
	symbol := lipgloss.NewStyle().Foreground(ss.Color).Render(ss.Symbol)
	identifier := lipgloss.NewStyle().Foreground(theme.TextPrimary).Bold(true).Render(s.Identifier)
	statusLabel := lipgloss.NewStyle().Foreground(ss.Color).Render(ss.Label)

	sessionHeader := lipgloss.NewStyle().
		Padding(0, 1).
		Width(m.width).
		BorderBottom(true).
		BorderStyle(lipgloss.NormalBorder()).
		BorderForeground(theme.SurfaceBorder).
		Render(symbol + " " + identifier + "  " + statusLabel)
	sections = append(sections, sessionHeader)

	// Metadata grid
	sections = append(sections, renderMetadata(s, m.width))

	// Timeline
	sections = append(sections, renderTimeline(s, m.width, m.frame))

	body := lipgloss.JoinVertical(lipgloss.Left, sections...)

	// Help bar
	help := m.renderHelp()

	bodyHeight := strings.Count(body, "\n") + 1
	gap := m.height - bodyHeight - 1
	if gap < 0 {
		gap = 0
	}

	return body + strings.Repeat("\n", gap) + help
}

func (m *Model) renderHelp() string {
	pairs := []struct{ key, desc string }{
		{"esc", "back"},
		{"r", "refresh"},
		{"ctrl+k", "commands"},
		{"q", "quit"},
	}

	var parts []string
	for _, p := range pairs {
		k := theme.HelpKey().Render(p.key)
		d := theme.HelpDesc().Render(p.desc)
		parts = append(parts, k+" "+d)
	}

	return theme.HelpBar().Width(m.width).Render(strings.Join(parts, "  "))
}

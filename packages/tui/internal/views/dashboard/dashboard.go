package dashboard

import (
	"strings"
	"time"

	"charm.land/lipgloss/v2"

	tea "charm.land/bubbletea/v2"
	"github.com/RenseiAI/agentfactory/packages/tui/internal/api"
	"github.com/RenseiAI/agentfactory/packages/tui/internal/theme"
)

// Messages for dashboard data flow.
type tickMsg struct{}

type dataMsg struct {
	stats    *api.StatsResponse
	sessions *api.SessionsListResponse
	err      error
}

// SelectSessionMsg is sent when the user selects a session.
type SelectSessionMsg struct{ SessionID string }

// Model is the Fleet Dashboard view model.
type Model struct {
	dataSource api.DataSource
	stats      *api.StatsResponse
	sessions   []api.SessionResponse
	cursor     int
	width      int
	height     int
	focused    bool
	loading    bool
	err        error
	filterText string
	filtering  bool
	frame      int
}

// New creates a new dashboard model.
func New(ds api.DataSource) *Model {
	return &Model{
		dataSource: ds,
		loading:    true,
	}
}

// SetSize updates the available render size.
func (m *Model) SetSize(width, height int) {
	m.width = width
	m.height = height
}

// Focus marks the dashboard as focused.
func (m *Model) Focus() { m.focused = true }

// Blur marks the dashboard as unfocused.
func (m *Model) Blur() { m.focused = false }

// Init starts the initial data fetch and polling tick.
func (m *Model) Init() tea.Cmd {
	return tea.Batch(m.fetchData(), m.tickCmd())
}

func (m *Model) fetchData() tea.Cmd {
	return func() tea.Msg {
		stats, _ := m.dataSource.GetStats()
		sessions, _ := m.dataSource.GetSessions()
		return dataMsg{stats: stats, sessions: sessions}
	}
}

func (m *Model) tickCmd() tea.Cmd {
	return tea.Tick(3*time.Second, func(t time.Time) tea.Msg {
		return tickMsg{}
	})
}

// Update handles messages for the dashboard.
func (m *Model) Update(msg tea.Msg) tea.Cmd {
	switch msg := msg.(type) {
	case tickMsg:
		m.frame++
		return tea.Batch(m.fetchData(), m.tickCmd())

	case dataMsg:
		m.loading = false
		if msg.stats != nil {
			m.stats = msg.stats
		}
		if msg.sessions != nil {
			m.sessions = msg.sessions.Sessions
		}
		if msg.err != nil {
			m.err = msg.err
		}

	case tea.KeyPressMsg:
		if m.filtering {
			return m.updateFilter(msg)
		}
		filtered := filterSessions(m.sessions, m.filterText)
		switch msg.String() {
		case "up", "k":
			if m.cursor > 0 {
				m.cursor--
			}
		case "down", "j":
			if m.cursor < len(filtered)-1 {
				m.cursor++
			}
		case "enter":
			if m.cursor < len(filtered) {
				id := filtered[m.cursor].ID
				return func() tea.Msg { return SelectSessionMsg{SessionID: id} }
			}
		case "/":
			m.filtering = true
			m.filterText = ""
		case "r":
			return m.fetchData()
		case "home", "g":
			m.cursor = 0
		case "end", "G":
			if len(filtered) > 0 {
				m.cursor = len(filtered) - 1
			}
		}
	}
	return nil
}

func (m *Model) updateFilter(msg tea.KeyPressMsg) tea.Cmd {
	switch msg.String() {
	case "esc":
		m.filtering = false
		m.filterText = ""
		m.cursor = 0
	case "enter":
		m.filtering = false
	case "backspace":
		if len(m.filterText) > 0 {
			m.filterText = m.filterText[:len(m.filterText)-1]
			m.cursor = 0
		}
	default:
		if text := msg.Key().Text; text != "" {
			m.filterText += text
			m.cursor = 0
		}
	}
	return nil
}

// Render returns the dashboard as a rendered string.
func (m *Model) Render() string {
	if m.width == 0 {
		return ""
	}

	var sections []string

	// Header
	title := theme.Header().Width(m.width).Render(
		lipgloss.JoinHorizontal(lipgloss.Top,
			lipgloss.NewStyle().Bold(true).Foreground(theme.Accent).Render("AGENTFACTORY"),
			lipgloss.NewStyle().Foreground(theme.TextSecondary).Render(" FLEET"),
		),
	)
	sections = append(sections, title)

	// Stats bar
	sections = append(sections, renderStatsBar(m.stats, m.width))

	// Filter bar (if active or has text)
	if m.filtering {
		sections = append(sections, renderFilterBar(m.filterText, m.width))
	} else if m.filterText != "" {
		sections = append(sections, renderFilterBar(m.filterText, m.width))
	}

	// Table header
	sections = append(sections, renderTableHeader(m.width))

	// Table rows
	filtered := filterSessions(m.sessions, m.filterText)
	headerHeight := len(sections) + 2 // +2 for help bar + padding
	availableRows := m.height - headerHeight
	if availableRows < 1 {
		availableRows = 1
	}

	// Scroll offset
	scrollOffset := 0
	if m.cursor >= availableRows {
		scrollOffset = m.cursor - availableRows + 1
	}

	visibleEnd := scrollOffset + availableRows
	if visibleEnd > len(filtered) {
		visibleEnd = len(filtered)
	}

	if len(filtered) == 0 {
		if m.loading {
			sections = append(sections, theme.Muted().Padding(1, 2).Render("Loading sessions..."))
		} else if m.filterText != "" {
			sections = append(sections, theme.Muted().Padding(1, 2).Render("No sessions match filter"))
		} else {
			sections = append(sections, theme.Muted().Padding(1, 2).Render("No active sessions"))
		}
	} else {
		for i := scrollOffset; i < visibleEnd; i++ {
			selected := i == m.cursor
			sections = append(sections, renderTableRow(filtered[i], m.width, selected, m.frame))
		}
	}

	// Join body
	body := lipgloss.JoinVertical(lipgloss.Left, sections...)

	// Help bar at bottom
	help := m.renderHelp()

	// Calculate padding to push help to bottom
	bodyHeight := strings.Count(body, "\n") + 1
	helpHeight := 1
	gap := m.height - bodyHeight - helpHeight
	if gap < 0 {
		gap = 0
	}

	return body + strings.Repeat("\n", gap) + help
}

func (m *Model) renderHelp() string {
	pairs := []struct{ key, desc string }{
		{"\u2191\u2193", "navigate"},
		{"enter", "select"},
		{"/", "filter"},
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

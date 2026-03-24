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

// Model is the Agent Detail view model.
type Model struct {
	dataSource     api.DataSource
	session        *api.SessionDetail
	sessionID      string
	width          int
	height         int
	focused        bool
	loading        bool
	err            error
	frame          int
	// Activity streaming
	activityView   *ActivityViewport
	activityCursor *string
	// UI state
	showHelp       bool
	confirmStop    bool
	promptMode     bool
	promptText     string
}

// New creates a new detail model.
func New(ds api.DataSource) *Model {
	return &Model{
		dataSource:   ds,
		activityView: NewActivityViewport(),
	}
}

// SetSession sets the session ID to display and starts loading.
func (m *Model) SetSession(id string) {
	m.sessionID = id
	m.loading = true
	m.session = nil
	m.activityCursor = nil
	m.activityView = NewActivityViewport()
	m.showHelp = false
	m.confirmStop = false
	m.promptMode = false
	m.promptText = ""
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

// Init starts the data fetch and activity streaming.
func (m *Model) Init() tea.Cmd {
	return tea.Batch(
		m.fetchDetail(),
		m.fetchActivitiesCmd(),
		m.tickCmd(),
		m.activityTickCmd(),
	)
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

func (m *Model) fetchActivitiesCmd() tea.Cmd {
	id := m.sessionID
	cursor := m.activityCursor
	return func() tea.Msg {
		resp, err := m.dataSource.GetActivities(id, cursor)
		if err != nil {
			return activityMsg{err: err}
		}
		return activityMsg{
			activities: resp.Activities,
			cursor:     resp.Cursor,
		}
	}
}

func (m *Model) activityTickCmd() tea.Cmd {
	return tea.Tick(1*time.Second, func(t time.Time) tea.Msg {
		return activityTickMsg{}
	})
}

// isTerminal returns true if the session is in a terminal state.
func (m *Model) isTerminal() bool {
	if m.session == nil {
		return false
	}
	switch m.session.Status {
	case api.StatusCompleted, api.StatusFailed, api.StatusStopped:
		return true
	}
	return false
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

	case activityMsg:
		if msg.err == nil && len(msg.activities) > 0 {
			m.activityView.AppendActivities(msg.activities)
			m.activityCursor = msg.cursor
		}

	case activityTickMsg:
		if !m.isTerminal() {
			return tea.Batch(m.fetchActivitiesCmd(), m.activityTickCmd())
		}
		// Terminal state: do one final fetch, then stop
		return m.fetchActivitiesCmd()

	case stopAgentMsg:
		if msg.err != nil {
			// Show error inline
			m.activityView.AppendActivities([]api.ActivityEvent{
				{ID: "err", Type: api.ActivityError, Content: "Failed to stop agent: " + msg.err.Error(), Timestamp: time.Now().Format(time.RFC3339)},
			})
		}

	case sendPromptMsg:
		if msg.err != nil {
			m.activityView.AppendActivities([]api.ActivityEvent{
				{ID: "err", Type: api.ActivityError, Content: "Failed to send prompt: " + msg.err.Error(), Timestamp: time.Now().Format(time.RFC3339)},
			})
		} else {
			m.activityView.AppendActivities([]api.ActivityEvent{
				{ID: "prompt", Type: api.ActivityResponse, Content: "Prompt sent: " + msg.text, Timestamp: time.Now().Format(time.RFC3339)},
			})
		}

	case tea.KeyPressMsg:
		return m.handleKeyPress(msg)
	}
	return nil
}

func (m *Model) handleKeyPress(msg tea.KeyPressMsg) tea.Cmd {
	key := msg.String()

	// Help overlay takes priority
	if m.showHelp {
		if key == "?" || key == "esc" {
			m.showHelp = false
		}
		return nil
	}

	// Stop confirmation mode
	if m.confirmStop {
		switch key {
		case "y", "Y":
			m.confirmStop = false
			return m.stopAgentCmd()
		default:
			m.confirmStop = false
		}
		return nil
	}

	// Prompt input mode
	if m.promptMode {
		switch key {
		case "esc":
			m.promptMode = false
			m.promptText = ""
		case "enter":
			if m.promptText != "" {
				text := m.promptText
				m.promptMode = false
				m.promptText = ""
				return m.sendPromptCmd(text)
			}
		case "backspace":
			if len(m.promptText) > 0 {
				m.promptText = m.promptText[:len(m.promptText)-1]
			}
		default:
			if len(key) == 1 || key == " " {
				m.promptText += key
			}
		}
		return nil
	}

	// Normal mode keybindings
	switch key {
	case "esc":
		return func() tea.Msg { return NavigateBackMsg{} }
	case "r":
		return m.fetchDetail()
	case "j", "down":
		m.activityView.ScrollDown(1)
	case "k", "up":
		m.activityView.ScrollUp(1)
	case "g":
		m.activityView.ScrollToTop()
	case "G":
		m.activityView.ScrollToBottom()
	case "f":
		m.activityView.ToggleAutoFollow()
	case "ctrl+d":
		m.activityView.ScrollDown(10)
	case "ctrl+u":
		m.activityView.ScrollUp(10)
	case "s":
		if !m.isTerminal() {
			m.confirmStop = true
		}
	case "p":
		if !m.isTerminal() {
			m.promptMode = true
			m.promptText = ""
		}
	case "?":
		m.showHelp = true
	}
	return nil
}

// Render returns the detail view as a rendered string.
func (m *Model) Render() string {
	if m.width == 0 {
		return ""
	}

	var sections []string

	// Title bar: identifier + work type + provider + status
	sections = append(sections, m.renderTitleBar())

	if m.loading || m.session == nil {
		sections = append(sections, theme.Muted().Padding(1, 2).Render("Loading session detail..."))
		return lipgloss.JoinVertical(lipgloss.Left, sections...)
	}

	s := *m.session

	// Metadata header
	sections = append(sections, renderMetadata(s, m.width))

	// Activity section header
	activityTitle := lipgloss.NewStyle().
		Foreground(theme.TextPrimary).
		Bold(true).
		Padding(0, 1).
		Width(m.width).
		BorderBottom(true).
		BorderStyle(lipgloss.NormalBorder()).
		BorderForeground(theme.SurfaceBorder).
		Render("ACTIVITY")
	sections = append(sections, activityTitle)

	header := lipgloss.JoinVertical(lipgloss.Left, sections...)

	// Calculate viewport height
	headerHeight := strings.Count(header, "\n") + 1
	helpHeight := 1
	viewportHeight := m.height - headerHeight - helpHeight
	if viewportHeight < 3 {
		viewportHeight = 3
	}
	m.activityView.SetSize(m.width, viewportHeight)

	// Activity viewport
	activityContent := m.activityView.Render()

	// Help bar (or prompt input or confirm stop)
	help := m.renderBottomBar()

	content := header + "\n" + activityContent + "\n" + help

	// Help overlay
	if m.showHelp {
		content = renderHelpOverlay(content, m.width, m.height)
	}

	return content
}

func (m *Model) renderTitleBar() string {
	if m.session == nil {
		return lipgloss.NewStyle().
			Foreground(theme.TextSecondary).
			Background(theme.Surface).
			Padding(0, 1).
			Width(m.width).
			Render("\u2190 Back (esc)")
	}

	s := *m.session
	ss := theme.GetStatusStyle(s.Status)

	symbol := lipgloss.NewStyle().Foreground(ss.Color).Render(ss.Symbol)
	identifier := lipgloss.NewStyle().Foreground(theme.TextPrimary).Bold(true).Render(s.Identifier)

	wtColor := theme.GetWorkTypeColor(s.WorkType)
	wtLabel := theme.GetWorkTypeLabel(s.WorkType)
	workType := lipgloss.NewStyle().Foreground(wtColor).Render(wtLabel)

	providerText := "--"
	if s.Provider != nil {
		providerText = *s.Provider
	}
	provider := theme.Muted().Render(providerText)

	statusLabel := lipgloss.NewStyle().Foreground(ss.Color).Render(ss.Label)

	// Auto-follow indicator
	followIndicator := ""
	if m.activityView.AutoFollow() {
		followIndicator = lipgloss.NewStyle().Foreground(theme.Teal).Bold(true).Render(" \u27f1")
	}

	titleContent := symbol + " " + identifier + "  " + workType + "  " + provider + "  " + statusLabel + followIndicator

	return lipgloss.NewStyle().
		Background(theme.Surface).
		Padding(0, 1).
		Width(m.width).
		Render(titleContent)
}

func (m *Model) renderBottomBar() string {
	if m.confirmStop {
		prompt := theme.HelpKey().Render("Stop agent "+m.sessionID+"? ") +
			theme.HelpDesc().Render("(y/n)")
		return theme.HelpBar().Width(m.width).Render(prompt)
	}

	if m.promptMode {
		prompt := theme.HelpKey().Render("> ") +
			lipgloss.NewStyle().Foreground(theme.TextPrimary).Render(m.promptText) +
			theme.Dimmed().Render("\u2588") // cursor block
		return theme.HelpBar().Width(m.width).Render(prompt)
	}

	pairs := []struct{ key, desc string }{
		{"esc", "back"},
		{"s", "stop"},
		{"p", "prompt"},
		{"f", "follow"},
		{"\u2191\u2193", "scroll"},
		{"?", "help"},
	}

	var parts []string
	for _, p := range pairs {
		k := theme.HelpKey().Render(p.key)
		d := theme.HelpDesc().Render(p.desc)
		parts = append(parts, k+" "+d)
	}

	return theme.HelpBar().Width(m.width).Render(strings.Join(parts, "  "))
}

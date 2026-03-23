package palette

import (
	"strings"

	"charm.land/lipgloss/v2"
	tea "charm.land/bubbletea/v2"
	"github.com/RenseiAI/agentfactory/packages/tui/internal/theme"
)

// Model is the Command Palette view model.
type Model struct {
	actions  []Action
	filtered []Action
	input    string
	cursor   int
	width    int
	height   int
	focused  bool
}

// New creates a new command palette model.
func New() *Model {
	actions := DefaultActions()
	return &Model{
		actions:  actions,
		filtered: actions,
	}
}

// SetSize updates the available render size.
func (m *Model) SetSize(width, height int) {
	m.width = width
	m.height = height
}

// Focus activates the palette and resets input.
func (m *Model) Focus() {
	m.focused = true
	m.input = ""
	m.cursor = 0
	m.filtered = m.actions
}

// Blur deactivates the palette.
func (m *Model) Blur() {
	m.focused = false
}

// Init returns nil — no initialization needed.
func (m *Model) Init() tea.Cmd { return nil }

// Update handles messages for the command palette.
func (m *Model) Update(msg tea.Msg) tea.Cmd {
	switch msg := msg.(type) {
	case tea.KeyPressMsg:
		switch msg.String() {
		case "esc":
			return func() tea.Msg { return ClosePaletteMsg{} }
		case "enter":
			if m.cursor < len(m.filtered) {
				action := m.filtered[m.cursor]
				return tea.Batch(
					func() tea.Msg { return ClosePaletteMsg{} },
					action.Handler,
				)
			}
		case "up", "ctrl+k":
			if m.cursor > 0 {
				m.cursor--
			}
		case "down", "ctrl+j":
			if m.cursor < len(m.filtered)-1 {
				m.cursor++
			}
		case "backspace":
			if len(m.input) > 0 {
				m.input = m.input[:len(m.input)-1]
				m.refilter()
			}
		default:
			if text := msg.Key().Text; text != "" {
				m.input += text
				m.refilter()
			}
		}
	}
	return nil
}

func (m *Model) refilter() {
	if m.input == "" {
		m.filtered = m.actions
	} else {
		filter := strings.ToLower(m.input)
		m.filtered = nil
		for _, a := range m.actions {
			if strings.Contains(strings.ToLower(a.Name), filter) {
				m.filtered = append(m.filtered, a)
			}
		}
	}
	if m.cursor >= len(m.filtered) {
		m.cursor = max(0, len(m.filtered)-1)
	}
}

// Render returns the command palette as a rendered string.
func (m *Model) Render() string {
	paletteWidth := m.width / 2
	if paletteWidth < 40 {
		paletteWidth = 40
	}
	if paletteWidth > 60 {
		paletteWidth = 60
	}

	// Search input
	prompt := lipgloss.NewStyle().Foreground(theme.Accent).Bold(true).Render(">")
	inputText := m.input
	if m.focused {
		inputText += "_"
	}
	searchLine := prompt + " " + lipgloss.NewStyle().Foreground(theme.TextPrimary).Render(inputText)

	inputBox := lipgloss.NewStyle().
		Width(paletteWidth - 4).
		Background(theme.SurfaceRaised).
		Padding(0, 1).
		Render(searchLine)

	// Action list
	var rows []string
	maxVisible := 8
	if len(m.filtered) < maxVisible {
		maxVisible = len(m.filtered)
	}

	for i := 0; i < maxVisible; i++ {
		a := m.filtered[i]
		selected := i == m.cursor

		indicator := "  "
		nameStyle := lipgloss.NewStyle().Foreground(theme.TextSecondary)
		shortcutStyle := theme.Dimmed()

		if selected {
			indicator = lipgloss.NewStyle().Foreground(theme.Accent).Render("\u25b8 ") // ▸
			nameStyle = lipgloss.NewStyle().Foreground(theme.TextPrimary).Bold(true)
		}

		name := nameStyle.Render(a.Name)

		var shortcut string
		if a.Shortcut != "" {
			shortcut = shortcutStyle.Render(a.Shortcut)
		}

		// Right-align shortcut
		nameWidth := paletteWidth - 8
		if a.Shortcut != "" {
			padding := nameWidth - lipgloss.Width(a.Name)
			if padding < 1 {
				padding = 1
			}
			row := indicator + name + strings.Repeat(" ", padding) + shortcut
			rows = append(rows, row)
		} else {
			rows = append(rows, indicator+name)
		}
	}

	actionList := lipgloss.JoinVertical(lipgloss.Left, rows...)

	// Compose palette box
	content := lipgloss.JoinVertical(lipgloss.Left, inputBox, "", actionList)

	box := lipgloss.NewStyle().
		Width(paletteWidth).
		Border(lipgloss.RoundedBorder()).
		BorderForeground(theme.SurfaceBorderBright).
		Background(theme.Surface).
		Padding(1, 1).
		Render(content)

	return box
}

// Overlay renders the palette centered over the background content.
func Overlay(background string, paletteContent string, width, height int) string {
	return lipgloss.Place(
		width, height,
		lipgloss.Center, lipgloss.Center,
		paletteContent,
		lipgloss.WithWhitespaceStyle(lipgloss.NewStyle().Foreground(theme.BgPrimary)),
	)
}

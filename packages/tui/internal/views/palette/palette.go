package palette

import (
	"image/color"
	"strings"

	"charm.land/lipgloss/v2"
	tea "charm.land/bubbletea/v2"
	"github.com/RenseiAI/agentfactory/packages/tui/internal/theme"
	"github.com/sahilm/fuzzy"
)

// Model is the Command Palette view model.
type Model struct {
	actions  []Action
	filtered []Action
	matches  []fuzzy.Match // fuzzy match metadata for highlighting
	input    string
	cursor   int
	width    int
	height   int
	focused  bool

	// Prompt mode fields for parameterized actions
	prompting    bool              // true when collecting input for a parameterized action
	promptAction *Action           // the action being parameterized
	promptStep   int               // current step index
	promptInputs map[string]string // collected inputs so far
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
	m.prompting = false
	m.promptAction = nil
	m.promptStep = 0
	m.promptInputs = nil
}

// Blur deactivates the palette.
func (m *Model) Blur() {
	m.focused = false
	m.prompting = false
}

// Init returns nil — no initialization needed.
func (m *Model) Init() tea.Cmd { return nil }

// Update handles messages for the command palette.
func (m *Model) Update(msg tea.Msg) tea.Cmd {
	switch msg := msg.(type) {
	case tea.KeyPressMsg:
		if m.prompting {
			return m.updatePrompt(msg)
		}

		switch msg.String() {
		case "esc":
			return func() tea.Msg { return ClosePaletteMsg{} }
		case "enter":
			if m.cursor < len(m.filtered) {
				action := m.filtered[m.cursor]
				// If action has prompts, enter prompt mode
				if len(action.Prompts) > 0 {
					m.prompting = true
					m.promptAction = &action
					m.promptStep = 0
					m.promptInputs = make(map[string]string)
					m.input = ""
					return nil
				}
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

// updatePrompt handles key input during parameter collection.
func (m *Model) updatePrompt(msg tea.KeyPressMsg) tea.Cmd {
	switch msg.String() {
	case "esc":
		// Cancel prompt, return to action list
		m.prompting = false
		m.promptAction = nil
		m.input = ""
		m.refilter()
		return nil
	case "enter":
		if m.input == "" {
			return nil // don't accept empty input
		}
		// Store collected input
		step := m.promptAction.Prompts[m.promptStep]
		m.promptInputs[step.Field] = m.input
		m.promptStep++
		m.input = ""

		// If more steps, continue prompting
		if m.promptStep < len(m.promptAction.Prompts) {
			return nil
		}

		// All inputs collected — build and fire the message
		buildMsg := m.promptAction.BuildMsg
		inputs := m.promptInputs
		m.prompting = false
		m.promptAction = nil
		return tea.Batch(
			func() tea.Msg { return ClosePaletteMsg{} },
			func() tea.Msg { return buildMsg(inputs) },
		)
	case "backspace":
		if len(m.input) > 0 {
			m.input = m.input[:len(m.input)-1]
		}
	default:
		if text := msg.Key().Text; text != "" {
			m.input += text
		}
	}
	return nil
}

// actionNames implements fuzzy.Source for palette actions.
type actionNames []Action

func (a actionNames) String(i int) string { return a[i].Name }
func (a actionNames) Len() int            { return len(a) }

func (m *Model) refilter() {
	if m.input == "" {
		m.filtered = m.actions
		m.matches = nil
	} else {
		results := fuzzy.FindFrom(m.input, actionNames(m.actions))
		m.filtered = make([]Action, len(results))
		m.matches = make([]fuzzy.Match, len(results))
		for i, r := range results {
			m.filtered[i] = m.actions[r.Index]
			m.matches[i] = r
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

	// Prompt mode rendering
	if m.prompting && m.promptAction != nil {
		return m.renderPrompt(paletteWidth)
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
		baseColor := theme.TextSecondary
		shortcutStyle := theme.Dimmed()

		if selected {
			indicator = lipgloss.NewStyle().Foreground(theme.Accent).Render("\u25b8 ") // ▸
			baseColor = theme.TextPrimary
		}

		// Render name with fuzzy match highlighting
		name := m.renderActionName(a.Name, i, baseColor, selected)

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

// renderPrompt renders the parameter input prompt.
func (m *Model) renderPrompt(paletteWidth int) string {
	step := m.promptAction.Prompts[m.promptStep]

	// Title
	title := lipgloss.NewStyle().
		Foreground(theme.Accent).Bold(true).
		Render(m.promptAction.Name)

	// Step indicator
	stepInfo := ""
	if len(m.promptAction.Prompts) > 1 {
		stepInfo = lipgloss.NewStyle().
			Foreground(theme.TextSecondary).
			Render(" (step " + strings.Repeat("", 0) +
				string(rune('1'+m.promptStep)) + "/" +
				string(rune('0'+len(m.promptAction.Prompts))) + ")")
	}

	// Label
	label := lipgloss.NewStyle().
		Foreground(theme.TextSecondary).
		Render(step.Label + ":")

	// Input
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

	// Help
	help := lipgloss.NewStyle().
		Foreground(theme.TextSecondary).
		Render("enter: confirm  esc: cancel")

	content := lipgloss.JoinVertical(lipgloss.Left,
		title+stepInfo, "", label, inputBox, "", help)

	box := lipgloss.NewStyle().
		Width(paletteWidth).
		Border(lipgloss.RoundedBorder()).
		BorderForeground(theme.SurfaceBorderBright).
		Background(theme.Surface).
		Padding(1, 1).
		Render(content)

	return box
}

// renderActionName renders an action name with fuzzy-matched characters highlighted.
func (m *Model) renderActionName(name string, idx int, baseColor color.Color, selected bool) string {
	if m.matches == nil || idx >= len(m.matches) {
		style := lipgloss.NewStyle().Foreground(baseColor)
		if selected {
			style = style.Bold(true)
		}
		return style.Render(name)
	}

	// Build set of matched rune indices
	matched := make(map[int]bool)
	for _, mi := range m.matches[idx].MatchedIndexes {
		matched[mi] = true
	}

	normalStyle := lipgloss.NewStyle().Foreground(baseColor)
	highlightStyle := lipgloss.NewStyle().Foreground(theme.Accent).Bold(true)
	if selected {
		normalStyle = normalStyle.Bold(true)
	}

	var result strings.Builder
	for i, ch := range name {
		if matched[i] {
			result.WriteString(highlightStyle.Render(string(ch)))
		} else {
			result.WriteString(normalStyle.Render(string(ch)))
		}
	}
	return result.String()
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

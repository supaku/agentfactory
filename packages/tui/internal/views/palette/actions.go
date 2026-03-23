package palette

import tea "charm.land/bubbletea/v2"

// Action represents a command palette action.
type Action struct {
	Name     string
	Shortcut string
	Handler  func() tea.Msg
}

// ClosePaletteMsg signals the palette should close.
type ClosePaletteMsg struct{}

// RefreshMsg signals a data refresh.
type RefreshMsg struct{}

// NavigateDashboardMsg signals navigation to dashboard.
type NavigateDashboardMsg struct{}

// SortMsg signals a sort request.
type SortMsg struct{ Field string }

// DefaultActions returns the built-in command palette actions.
func DefaultActions() []Action {
	return []Action{
		{
			Name:     "Go to Dashboard",
			Shortcut: "ctrl+1",
			Handler:  func() tea.Msg { return NavigateDashboardMsg{} },
		},
		{
			Name:     "Refresh Data",
			Shortcut: "r",
			Handler:  func() tea.Msg { return RefreshMsg{} },
		},
		{
			Name:     "Sort by Duration",
			Shortcut: "",
			Handler:  func() tea.Msg { return SortMsg{Field: "duration"} },
		},
		{
			Name:     "Sort by Cost",
			Shortcut: "",
			Handler:  func() tea.Msg { return SortMsg{Field: "cost"} },
		},
		{
			Name:     "Sort by Status",
			Shortcut: "",
			Handler:  func() tea.Msg { return SortMsg{Field: "status"} },
		},
		{
			Name:     "Quit",
			Shortcut: "q",
			Handler:  func() tea.Msg { return tea.Quit() },
		},
	}
}

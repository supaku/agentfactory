package component

import tea "charm.land/bubbletea/v2"

// Component extends tea.Model with size management and focus control.
type Component interface {
	tea.Model
	SetSize(width, height int)
	Focus()
	Blur()
}

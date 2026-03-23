package app

import (
	tea "charm.land/bubbletea/v2"
	"github.com/RenseiAI/agentfactory/packages/tui/internal/views/dashboard"
	"github.com/RenseiAI/agentfactory/packages/tui/internal/views/detail"
	"github.com/RenseiAI/agentfactory/packages/tui/internal/views/palette"
)

// App is the root Bubble Tea model that routes between views.
type App struct {
	ctx         *Context
	state       ViewState
	dashboard   *dashboard.Model
	detail      *detail.Model
	palette     *palette.Model
	width       int
	height      int
	showPalette bool
}

// New creates the root application model.
func New(ctx *Context) *App {
	return &App{
		ctx:       ctx,
		state:     ViewDashboard,
		dashboard: dashboard.New(ctx.DataSource),
		detail:    detail.New(ctx.DataSource),
		palette:   palette.New(),
	}
}

// Init starts the dashboard data fetch.
func (a *App) Init() tea.Cmd {
	return a.dashboard.Init()
}

// Update handles all messages, routing to the active view.
func (a *App) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		a.width = msg.Width
		a.height = msg.Height
		a.dashboard.SetSize(msg.Width, msg.Height)
		a.detail.SetSize(msg.Width, msg.Height)
		a.palette.SetSize(msg.Width, msg.Height)
		return a, nil

	case tea.KeyPressMsg:
		// Palette gets priority when open
		if a.showPalette {
			cmd := a.palette.Update(msg)
			return a, cmd
		}

		// Global keybindings
		switch msg.String() {
		case "ctrl+c":
			return a, tea.Quit
		case "q":
			return a, tea.Quit
		case "ctrl+k":
			a.showPalette = true
			a.palette.Focus()
			return a, nil
		}

	// Cross-view navigation messages
	case dashboard.SelectSessionMsg:
		a.state = ViewDetail
		a.detail.SetSession(msg.SessionID)
		a.detail.Focus()
		a.dashboard.Blur()
		return a, a.detail.Init()

	case detail.NavigateBackMsg:
		a.state = ViewDashboard
		a.dashboard.Focus()
		a.detail.Blur()
		return a, nil

	// Palette messages
	case palette.ClosePaletteMsg:
		a.showPalette = false
		a.palette.Blur()
		return a, nil

	case palette.NavigateDashboardMsg:
		a.state = ViewDashboard
		a.dashboard.Focus()
		a.detail.Blur()
		return a, nil

	case palette.RefreshMsg:
		return a, a.dashboard.Init()
	}

	// Delegate to active view
	var cmd tea.Cmd
	switch a.state {
	case ViewDashboard:
		cmd = a.dashboard.Update(msg)
	case ViewDetail:
		cmd = a.detail.Update(msg)
	}

	return a, cmd
}

// View renders the active view (and optional palette overlay).
func (a *App) View() tea.View {
	var content string

	switch a.state {
	case ViewDashboard:
		content = a.dashboard.Render()
	case ViewDetail:
		content = a.detail.Render()
	}

	if a.showPalette {
		content = palette.Overlay(content, a.palette.Render(), a.width, a.height)
	}

	v := tea.NewView(content)
	v.AltScreen = true
	return v
}

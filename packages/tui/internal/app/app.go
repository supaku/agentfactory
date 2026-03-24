package app

import (
	"fmt"

	tea "charm.land/bubbletea/v2"
	"github.com/RenseiAI/agentfactory/packages/tui/internal/api"
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
		case "ctrl+k", ":":
			a.showPalette = true
			a.palette.Focus()
			return a, nil
		case "/":
			// In dashboard, "/" activates table filter (handled by dashboard.Update)
			// In other views, "/" opens the command palette
			if a.state != ViewDashboard {
				a.showPalette = true
				a.palette.Focus()
				return a, nil
			}
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

	// MCP actions — call the actual API
	case palette.MCPListFleetMsg:
		return a, a.mcpListFleet()

	case palette.MCPCostReportMsg:
		return a, a.mcpCostReport()

	case palette.MCPSubmitTaskMsg:
		return a, a.mcpSubmitTask(msg.IssueID)

	case palette.MCPStopAgentMsg:
		return a, a.mcpStopAgent(msg.TaskID)

	case palette.MCPForwardPromptMsg:
		return a, a.mcpForwardPrompt(msg.TaskID, msg.Message)

	case MCPResultMsg:
		// After an MCP action completes, refresh the dashboard
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

// MCP API command helpers

func (a *App) mcpListFleet() tea.Cmd {
	ds := a.ctx.DataSource
	return func() tea.Msg {
		resp, err := ds.ListFleet()
		if err != nil {
			return MCPResultMsg{Action: "list-fleet", Success: false, Message: err.Error()}
		}
		return MCPResultMsg{
			Action:  "list-fleet",
			Success: true,
			Message: fmt.Sprintf("Fleet: %d sessions (%d returned)", resp.Total, resp.Returned),
		}
	}
}

func (a *App) mcpCostReport() tea.Cmd {
	ds := a.ctx.DataSource
	return func() tea.Msg {
		resp, err := ds.GetCostReport()
		if err != nil {
			return MCPResultMsg{Action: "cost-report", Success: false, Message: err.Error()}
		}
		return MCPResultMsg{
			Action:  "cost-report",
			Success: true,
			Message: fmt.Sprintf("Cost: $%.2f across %d sessions (%d with data)",
				resp.TotalCostUsd, resp.TotalSessions, resp.SessionsWithCostData),
		}
	}
}

func (a *App) mcpSubmitTask(issueID string) tea.Cmd {
	ds := a.ctx.DataSource
	return func() tea.Msg {
		resp, err := ds.SubmitTask(api.SubmitTaskRequest{IssueID: issueID})
		if err != nil {
			return MCPResultMsg{Action: "submit-task", Success: false, Message: err.Error()}
		}
		return MCPResultMsg{
			Action:  "submit-task",
			Success: resp.Submitted,
			Message: fmt.Sprintf("Task %s submitted for %s (status: %s)", resp.TaskID, resp.IssueID, resp.Status),
		}
	}
}

func (a *App) mcpStopAgent(taskID string) tea.Cmd {
	ds := a.ctx.DataSource
	return func() tea.Msg {
		resp, err := ds.StopAgent(api.StopAgentRequest{TaskID: taskID})
		if err != nil {
			return MCPResultMsg{Action: "stop-agent", Success: false, Message: err.Error()}
		}
		return MCPResultMsg{
			Action:  "stop-agent",
			Success: resp.Stopped,
			Message: fmt.Sprintf("Agent %s stopped (%s → %s)", resp.TaskID, resp.PreviousStatus, resp.NewStatus),
		}
	}
}

func (a *App) mcpForwardPrompt(taskID, message string) tea.Cmd {
	ds := a.ctx.DataSource
	return func() tea.Msg {
		resp, err := ds.ForwardPrompt(api.ForwardPromptRequest{TaskID: taskID, Message: message})
		if err != nil {
			return MCPResultMsg{Action: "forward-prompt", Success: false, Message: err.Error()}
		}
		return MCPResultMsg{
			Action:  "forward-prompt",
			Success: resp.Forwarded,
			Message: fmt.Sprintf("Prompt %s forwarded to %s", resp.PromptID, resp.TaskID),
		}
	}
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

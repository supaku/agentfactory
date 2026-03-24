package palette

import tea "charm.land/bubbletea/v2"

// Action represents a command palette action.
type Action struct {
	Name     string
	Shortcut string
	Handler  func() tea.Msg
	// Prompts defines parameter collection steps for parameterized actions.
	// When non-nil, selecting this action enters prompt mode instead of firing immediately.
	Prompts []PromptStep
	// BuildMsg creates the final message from collected inputs. Used with Prompts.
	BuildMsg func(inputs map[string]string) tea.Msg
}

// PromptStep defines a parameter collection step for a parameterized action.
type PromptStep struct {
	Label string // displayed prompt (e.g., "Issue ID:")
	Field string // key in the inputs map
}

// ClosePaletteMsg signals the palette should close.
type ClosePaletteMsg struct{}

// RefreshMsg signals a data refresh.
type RefreshMsg struct{}

// NavigateDashboardMsg signals navigation to dashboard.
type NavigateDashboardMsg struct{}

// SortMsg signals a sort request.
type SortMsg struct{ Field string }

// MCPSubmitTaskMsg signals a submit-task action with collected input.
type MCPSubmitTaskMsg struct{ IssueID string }

// MCPStopAgentMsg signals a stop-agent action with collected input.
type MCPStopAgentMsg struct{ TaskID string }

// MCPForwardPromptMsg signals a forward-prompt action with collected input.
type MCPForwardPromptMsg struct{ TaskID, Message string }

// MCPCostReportMsg signals a cost-report action.
type MCPCostReportMsg struct{}

// MCPListFleetMsg signals a list-fleet action.
type MCPListFleetMsg struct{}

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
			Name: "Submit Task",
			Prompts: []PromptStep{
				{Label: "Issue ID", Field: "issueId"},
			},
			BuildMsg: func(inputs map[string]string) tea.Msg {
				return MCPSubmitTaskMsg{IssueID: inputs["issueId"]}
			},
		},
		{
			Name: "Stop Agent",
			Prompts: []PromptStep{
				{Label: "Task ID", Field: "taskId"},
			},
			BuildMsg: func(inputs map[string]string) tea.Msg {
				return MCPStopAgentMsg{TaskID: inputs["taskId"]}
			},
		},
		{
			Name: "Forward Prompt",
			Prompts: []PromptStep{
				{Label: "Task ID", Field: "taskId"},
				{Label: "Message", Field: "message"},
			},
			BuildMsg: func(inputs map[string]string) tea.Msg {
				return MCPForwardPromptMsg{TaskID: inputs["taskId"], Message: inputs["message"]}
			},
		},
		{
			Name:    "Cost Report",
			Handler: func() tea.Msg { return MCPCostReportMsg{} },
		},
		{
			Name:    "List Fleet",
			Handler: func() tea.Msg { return MCPListFleetMsg{} },
		},
		{
			Name:     "Quit",
			Shortcut: "q",
			Handler:  func() tea.Msg { return tea.Quit() },
		},
	}
}

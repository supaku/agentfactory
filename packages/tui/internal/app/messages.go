package app

// ViewState represents which view is currently active.
type ViewState int

const (
	ViewDashboard ViewState = iota
	ViewDetail
)

// MCPResultMsg carries the result of an MCP tool action.
type MCPResultMsg struct {
	Action  string
	Success bool
	Message string
}

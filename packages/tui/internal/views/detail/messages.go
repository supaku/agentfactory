package detail

import "github.com/RenseiAI/agentfactory/packages/tui/internal/api"

type detailDataMsg struct {
	detail *api.SessionDetailResponse
	err    error
}

type detailTickMsg struct{}

// Activity streaming messages
type activityMsg struct {
	activities []api.ActivityEvent
	cursor     *string
	err        error
}

type activityTickMsg struct{}

// Action messages
type stopAgentMsg struct {
	err error
}

type sendPromptMsg struct {
	text string
	err  error
}

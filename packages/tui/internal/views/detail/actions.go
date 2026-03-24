package detail

import (
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/RenseiAI/agentfactory/packages/tui/internal/api"
)

func (m *Model) stopAgentCmd() tea.Cmd {
	id := m.sessionID
	return func() tea.Msg {
		err := m.dataSource.StopSession(id)
		return stopAgentMsg{err: err}
	}
}

func (m *Model) sendPromptCmd(text string) tea.Cmd {
	id := m.sessionID
	return func() tea.Msg {
		err := m.dataSource.SendPrompt(id, text)
		return sendPromptMsg{text: text, err: err}
	}
}

// addInlineActivity appends a synthetic activity to the viewport.
func (m *Model) addInlineActivity(actType api.ActivityType, content string) {
	m.activityView.AppendActivities([]api.ActivityEvent{
		{
			ID:        "local",
			Type:      actType,
			Content:   content,
			Timestamp: time.Now().Format(time.RFC3339),
		},
	})
}

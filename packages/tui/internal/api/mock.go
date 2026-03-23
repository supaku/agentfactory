package api

import (
	"fmt"
	"time"
)

func ptr[T any](v T) *T { return &v }

// MockClient returns realistic mock data matching the public API shapes.
type MockClient struct {
	sessions []SessionResponse
}

// NewMockClient creates a mock data source with 12 sample sessions.
func NewMockClient() *MockClient {
	now := time.Now()
	return &MockClient{
		sessions: []SessionResponse{
			{
				ID: "mock-001", Identifier: "SUP-1180", Status: StatusWorking,
				WorkType: "development", StartedAt: now.Add(-47 * time.Minute).Format(time.RFC3339),
				Duration: 2820, CostUsd: ptr(3.42), Provider: ptr("anthropic"),
			},
			{
				ID: "mock-002", Identifier: "SUP-1195", Status: StatusWorking,
				WorkType: "research", StartedAt: now.Add(-72 * time.Minute).Format(time.RFC3339),
				Duration: 4320, CostUsd: ptr(5.18), Provider: ptr("anthropic"),
			},
			{
				ID: "mock-003", Identifier: "SUP-1201", Status: StatusWorking,
				WorkType: "qa", StartedAt: now.Add(-22 * time.Minute).Format(time.RFC3339),
				Duration: 1320, CostUsd: ptr(1.87), Provider: ptr("openai"),
			},
			{
				ID: "mock-004", Identifier: "SUP-1199", Status: StatusWorking,
				WorkType: "feature", StartedAt: now.Add(-35 * time.Minute).Format(time.RFC3339),
				Duration: 2100, CostUsd: ptr(2.91), Provider: ptr("anthropic"),
			},
			{
				ID: "mock-005", Identifier: "SUP-1188", Status: StatusWorking,
				WorkType: "bugfix", StartedAt: now.Add(-63 * time.Minute).Format(time.RFC3339),
				Duration: 3780, CostUsd: ptr(4.20), Provider: ptr("openai"),
			},
			{
				ID: "mock-006", Identifier: "SUP-1205", Status: StatusQueued,
				WorkType: "acceptance", StartedAt: now.Add(-5 * time.Minute).Format(time.RFC3339),
				Duration: 300, CostUsd: nil, Provider: nil,
			},
			{
				ID: "mock-007", Identifier: "SUP-1208", Status: StatusQueued,
				WorkType: "coordination", StartedAt: now.Add(-2 * time.Minute).Format(time.RFC3339),
				Duration: 120, CostUsd: nil, Provider: nil,
			},
			{
				ID: "mock-008", Identifier: "SUP-1150", Status: StatusCompleted,
				WorkType: "development", StartedAt: now.Add(-4 * time.Hour).Format(time.RFC3339),
				Duration: 13500, CostUsd: ptr(8.50), Provider: ptr("anthropic"),
			},
			{
				ID: "mock-009", Identifier: "SUP-1162", Status: StatusCompleted,
				WorkType: "refactor", StartedAt: now.Add(-3 * time.Hour).Format(time.RFC3339),
				Duration: 7800, CostUsd: ptr(6.33), Provider: ptr("anthropic"),
			},
			{
				ID: "mock-010", Identifier: "SUP-1175", Status: StatusFailed,
				WorkType: "qa", StartedAt: now.Add(-2 * time.Hour).Format(time.RFC3339),
				Duration: 2700, CostUsd: ptr(2.10), Provider: ptr("openai"),
			},
			{
				ID: "mock-011", Identifier: "SUP-1190", Status: StatusStopped,
				WorkType: "docs", StartedAt: now.Add(-90 * time.Minute).Format(time.RFC3339),
				Duration: 900, CostUsd: ptr(0.85), Provider: ptr("anthropic"),
			},
			{
				ID: "mock-012", Identifier: "SUP-1202", Status: StatusParked,
				WorkType: "refinement", StartedAt: now.Add(-8 * time.Minute).Format(time.RFC3339),
				Duration: 480, CostUsd: nil, Provider: nil,
			},
		},
	}
}

// GetStats returns mock fleet statistics.
func (m *MockClient) GetStats() (*StatsResponse, error) {
	working := 0
	queued := 0
	completed := 0
	var totalCost float64
	for _, s := range m.sessions {
		switch s.Status {
		case StatusWorking:
			working++
		case StatusQueued:
			queued++
		case StatusCompleted:
			completed++
		}
		if s.CostUsd != nil {
			totalCost += *s.CostUsd
		}
	}

	return &StatsResponse{
		WorkersOnline:     3,
		AgentsWorking:     working,
		QueueDepth:        queued,
		CompletedToday:    completed,
		AvailableCapacity: 8 - working,
		TotalCostToday:    float64(int(totalCost*100)) / 100,
		TotalCostAllTime:  142.87,
		SessionCountToday: len(m.sessions),
		Timestamp:         time.Now().Format(time.RFC3339),
	}, nil
}

// GetSessions returns the mock session list.
func (m *MockClient) GetSessions() (*SessionsListResponse, error) {
	return &SessionsListResponse{
		Sessions:  m.sessions,
		Count:     len(m.sessions),
		Timestamp: time.Now().Format(time.RFC3339),
	}, nil
}

// GetSessionDetail returns mock detail for a single session.
func (m *MockClient) GetSessionDetail(id string) (*SessionDetailResponse, error) {
	for _, s := range m.sessions {
		if s.ID == id {
			now := time.Now()
			startedAt := s.StartedAt
			timeline := SessionTimeline{
				Created: startedAt,
			}
			queuedTime := now.Add(-time.Duration(s.Duration+2) * time.Second).Format(time.RFC3339)
			timeline.Queued = &queuedTime
			startedTime := now.Add(-time.Duration(s.Duration) * time.Second).Format(time.RFC3339)
			timeline.Started = &startedTime

			if s.Status == StatusCompleted || s.Status == StatusFailed || s.Status == StatusStopped {
				completedTime := now.Add(-30 * time.Second).Format(time.RFC3339)
				timeline.Completed = &completedTime
			}

			return &SessionDetailResponse{
				Session: SessionDetail{
					ID:         s.ID,
					Identifier: s.Identifier,
					Status:     s.Status,
					WorkType:   s.WorkType,
					StartedAt:  s.StartedAt,
					Duration:   s.Duration,
					Timeline:   timeline,
				},
				Timestamp: time.Now().Format(time.RFC3339),
			}, nil
		}
	}
	return nil, fmt.Errorf("session not found: %s", id)
}

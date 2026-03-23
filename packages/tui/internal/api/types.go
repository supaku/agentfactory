package api

// SessionStatus matches the public API status union type.
type SessionStatus string

const (
	StatusQueued    SessionStatus = "queued"
	StatusParked    SessionStatus = "parked"
	StatusWorking   SessionStatus = "working"
	StatusCompleted SessionStatus = "completed"
	StatusFailed    SessionStatus = "failed"
	StatusStopped   SessionStatus = "stopped"
)

// StatsResponse matches GET /api/public/stats.
type StatsResponse struct {
	WorkersOnline     int     `json:"workersOnline"`
	AgentsWorking     int     `json:"agentsWorking"`
	QueueDepth        int     `json:"queueDepth"`
	CompletedToday    int     `json:"completedToday"`
	AvailableCapacity int     `json:"availableCapacity"`
	TotalCostToday    float64 `json:"totalCostToday"`
	TotalCostAllTime  float64 `json:"totalCostAllTime"`
	SessionCountToday int     `json:"sessionCountToday"`
	Timestamp         string  `json:"timestamp"`
}

// SessionResponse matches a single session in GET /api/public/sessions.
type SessionResponse struct {
	ID         string        `json:"id"`
	Identifier string        `json:"identifier"`
	Status     SessionStatus `json:"status"`
	WorkType   string        `json:"workType"`
	StartedAt  string        `json:"startedAt"`
	Duration   int           `json:"duration"`
	CostUsd    *float64      `json:"costUsd,omitempty"`
	Provider   *string       `json:"provider,omitempty"`
}

// SessionsListResponse matches GET /api/public/sessions.
type SessionsListResponse struct {
	Sessions  []SessionResponse `json:"sessions"`
	Count     int               `json:"count"`
	Timestamp string            `json:"timestamp"`
}

// SessionTimeline represents the timeline in a session detail response.
type SessionTimeline struct {
	Created   string  `json:"created"`
	Queued    *string `json:"queued,omitempty"`
	Started   *string `json:"started,omitempty"`
	Completed *string `json:"completed,omitempty"`
}

// SessionDetail is the inner session object in the detail response.
type SessionDetail struct {
	ID           string          `json:"id"`
	Identifier   string          `json:"identifier"`
	Status       SessionStatus   `json:"status"`
	WorkType     string          `json:"workType"`
	StartedAt    string          `json:"startedAt"`
	Duration     int             `json:"duration"`
	Timeline     SessionTimeline `json:"timeline"`
	Provider     *string         `json:"provider,omitempty"`
	Branch       *string         `json:"branch,omitempty"`
	IssueTitle   *string         `json:"issueTitle,omitempty"`
	CostUsd      *float64        `json:"costUsd,omitempty"`
	InputTokens  *int            `json:"inputTokens,omitempty"`
	OutputTokens *int            `json:"outputTokens,omitempty"`
}

// SessionDetailResponse matches GET /api/public/sessions/:id.
type SessionDetailResponse struct {
	Session   SessionDetail `json:"session"`
	Timestamp string        `json:"timestamp"`
}

// ActivityType represents the type of an agent activity event.
type ActivityType string

const (
	ActivityThought  ActivityType = "thought"
	ActivityAction   ActivityType = "action"
	ActivityResponse ActivityType = "response"
	ActivityError    ActivityType = "error"
	ActivityProgress ActivityType = "progress"
)

// ActivityEvent represents a single activity from the streaming API.
type ActivityEvent struct {
	ID        string       `json:"id"`
	Type      ActivityType `json:"type"`
	Content   string       `json:"content"`
	ToolName  *string      `json:"toolName,omitempty"`
	Timestamp string       `json:"timestamp"`
}

// ActivityListResponse matches GET /api/public/sessions/:id/activities.
type ActivityListResponse struct {
	Activities    []ActivityEvent `json:"activities"`
	Cursor        *string         `json:"cursor,omitempty"`
	SessionStatus SessionStatus   `json:"sessionStatus"`
}

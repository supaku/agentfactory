package api

import "testing"

func TestMockClientGetStats(t *testing.T) {
	m := NewMockClient()
	stats, err := m.GetStats()
	if err != nil {
		t.Fatalf("GetStats() error: %v", err)
	}
	if stats.WorkersOnline != 3 {
		t.Errorf("WorkersOnline = %d, want 3", stats.WorkersOnline)
	}
	if stats.AgentsWorking != 5 {
		t.Errorf("AgentsWorking = %d, want 5", stats.AgentsWorking)
	}
	if stats.QueueDepth != 2 {
		t.Errorf("QueueDepth = %d, want 2", stats.QueueDepth)
	}
	if stats.CompletedToday != 2 {
		t.Errorf("CompletedToday = %d, want 2", stats.CompletedToday)
	}
}

func TestMockClientGetSessions(t *testing.T) {
	m := NewMockClient()
	resp, err := m.GetSessions()
	if err != nil {
		t.Fatalf("GetSessions() error: %v", err)
	}
	if resp.Count != 12 {
		t.Errorf("Count = %d, want 12", resp.Count)
	}
	if len(resp.Sessions) != 12 {
		t.Errorf("len(Sessions) = %d, want 12", len(resp.Sessions))
	}

	// Verify status distribution
	counts := make(map[SessionStatus]int)
	for _, s := range resp.Sessions {
		counts[s.Status]++
	}
	if counts[StatusWorking] != 5 {
		t.Errorf("working sessions = %d, want 5", counts[StatusWorking])
	}
	if counts[StatusQueued] != 2 {
		t.Errorf("queued sessions = %d, want 2", counts[StatusQueued])
	}
}

func TestMockClientGetSessionDetail(t *testing.T) {
	m := NewMockClient()
	detail, err := m.GetSessionDetail("mock-001")
	if err != nil {
		t.Fatalf("GetSessionDetail() error: %v", err)
	}
	if detail.Session.Identifier != "SUP-1180" {
		t.Errorf("Identifier = %q, want %q", detail.Session.Identifier, "SUP-1180")
	}
	if detail.Session.Status != StatusWorking {
		t.Errorf("Status = %q, want %q", detail.Session.Status, StatusWorking)
	}
	if detail.Session.Timeline.Created == "" {
		t.Error("Timeline.Created is empty")
	}
}

func TestMockClientGetSessionDetailNotFound(t *testing.T) {
	m := NewMockClient()
	_, err := m.GetSessionDetail("nonexistent")
	if err == nil {
		t.Error("expected error for nonexistent session")
	}
}

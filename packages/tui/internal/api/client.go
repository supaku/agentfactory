package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// DataSource is the interface both Client and MockClient implement.
type DataSource interface {
	GetStats() (*StatsResponse, error)
	GetSessions() (*SessionsListResponse, error)
	GetSessionDetail(id string) (*SessionDetailResponse, error)
	GetActivities(sessionID string, afterCursor *string) (*ActivityListResponse, error)
	StopSession(id string) error
	SendPrompt(id string, prompt string) error
}

// Client is the HTTP implementation of DataSource.
type Client struct {
	BaseURL    string
	HTTPClient *http.Client
}

// NewClient creates a new API client pointing at the given server URL.
func NewClient(baseURL string) *Client {
	return &Client{
		BaseURL:    strings.TrimRight(baseURL, "/"),
		HTTPClient: &http.Client{Timeout: 10 * time.Second},
	}
}

func (c *Client) get(path string, target any) error {
	resp, err := c.HTTPClient.Get(c.BaseURL + path)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status %d for %s", resp.StatusCode, path)
	}

	if err := json.NewDecoder(resp.Body).Decode(target); err != nil {
		return fmt.Errorf("decode failed: %w", err)
	}
	return nil
}

// GetStats fetches fleet-wide statistics.
func (c *Client) GetStats() (*StatsResponse, error) {
	var resp StatsResponse
	if err := c.get("/api/public/stats", &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// GetSessions fetches the list of all sessions.
func (c *Client) GetSessions() (*SessionsListResponse, error) {
	var resp SessionsListResponse
	if err := c.get("/api/public/sessions", &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// GetSessionDetail fetches detailed info for a single session.
func (c *Client) GetSessionDetail(id string) (*SessionDetailResponse, error) {
	var resp SessionDetailResponse
	if err := c.get("/api/public/sessions/"+id, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// GetActivities fetches activity events for a session, optionally after a cursor.
func (c *Client) GetActivities(sessionID string, afterCursor *string) (*ActivityListResponse, error) {
	path := "/api/public/sessions/" + sessionID + "/activities"
	if afterCursor != nil {
		path += "?after=" + *afterCursor
	}
	var resp ActivityListResponse
	if err := c.get(path, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

func (c *Client) post(path string, body any, target any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("marshal failed: %w", err)
	}
	resp, err := c.HTTPClient.Post(c.BaseURL+path, "application/json", bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status %d for %s", resp.StatusCode, path)
	}
	if target != nil {
		if err := json.NewDecoder(resp.Body).Decode(target); err != nil {
			return fmt.Errorf("decode failed: %w", err)
		}
	}
	return nil
}

// StopSession sends a stop request for the given session.
func (c *Client) StopSession(id string) error {
	return c.post("/api/public/sessions/"+id+"/stop", nil, nil)
}

// SendPrompt forwards a prompt to the given session's agent.
func (c *Client) SendPrompt(id string, prompt string) error {
	body := map[string]string{"prompt": prompt}
	return c.post("/api/public/sessions/"+id+"/prompt", body, nil)
}

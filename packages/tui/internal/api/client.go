package api

import (
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

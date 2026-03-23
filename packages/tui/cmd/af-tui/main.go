package main

import (
	"flag"
	"fmt"
	"os"

	tea "charm.land/bubbletea/v2"
	"github.com/RenseiAI/agentfactory/packages/tui/internal/api"
	"github.com/RenseiAI/agentfactory/packages/tui/internal/app"
)

func main() {
	baseURL := flag.String("url", "http://localhost:3000", "AgentFactory server URL")
	mock := flag.Bool("mock", false, "Use mock data instead of live API")
	flag.Parse()

	var ds api.DataSource
	if *mock {
		ds = api.NewMockClient()
	} else {
		ds = api.NewClient(*baseURL)
	}

	ctx := &app.Context{
		DataSource: ds,
		BaseURL:    *baseURL,
		UseMock:    *mock,
	}

	model := app.New(ctx)
	p := tea.NewProgram(model)

	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

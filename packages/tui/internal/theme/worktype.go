package theme

import (
	"image/color"
	"strings"

	"charm.land/lipgloss/v2"
)

var workTypeColors = map[string]color.Color{
	"development":             lipgloss.Color("#60A5FA"), // blue-400
	"bugfix":                  lipgloss.Color("#F87171"), // red-400
	"feature":                 lipgloss.Color("#34D399"), // emerald-400
	"qa":                      lipgloss.Color("#A78BFA"), // purple-400
	"qa-coordination":         lipgloss.Color("#C4B5FD"), // purple-300
	"acceptance":              lipgloss.Color("#F472B6"), // pink-400
	"acceptance-coordination": lipgloss.Color("#F9A8D4"), // pink-300
	"coordination":            lipgloss.Color("#FB923C"), // orange-400
	"research":                lipgloss.Color("#2DD4BF"), // teal-400
	"backlog-creation":        lipgloss.Color("#94A3B8"), // slate-400
	"inflight":                lipgloss.Color("#FACC15"), // yellow-400
	"refinement":              lipgloss.Color("#A3E635"), // lime-400
	"refinement-coordination": lipgloss.Color("#BEF264"), // lime-300
	"refactor":                lipgloss.Color("#FBBF24"), // amber-400
	"review":                  lipgloss.Color("#22D3EE"), // cyan-400
	"docs":                    lipgloss.Color("#818CF8"), // indigo-400
}

var workTypeLabels = map[string]string{
	"development":             "Development",
	"bugfix":                  "Bug Fix",
	"feature":                 "Feature",
	"qa":                      "QA",
	"qa-coordination":         "QA Coord",
	"acceptance":              "Acceptance",
	"acceptance-coordination": "Accept Coord",
	"coordination":            "Coordination",
	"research":                "Research",
	"backlog-creation":        "Backlog",
	"inflight":                "Inflight",
	"refinement":              "Refinement",
	"refinement-coordination": "Refine Coord",
	"refactor":                "Refactor",
	"review":                  "Review",
	"docs":                    "Docs",
}

// GetWorkTypeColor returns the display color for a work type.
func GetWorkTypeColor(workType string) color.Color {
	if c, ok := workTypeColors[strings.ToLower(workType)]; ok {
		return c
	}
	return TextSecondary
}

// GetWorkTypeLabel returns the display label for a work type.
func GetWorkTypeLabel(workType string) string {
	if label, ok := workTypeLabels[strings.ToLower(workType)]; ok {
		return label
	}
	return workType
}

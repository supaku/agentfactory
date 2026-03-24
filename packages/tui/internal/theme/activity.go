package theme

import (
	"image/color"
)

// ActivityColors maps activity types to their display colors.
var ActivityColors = map[string]color.Color{
	"thought":  TextSecondary,
	"action":   Teal,
	"response": TextPrimary,
	"error":    StatusError,
	"progress": StatusSuccess,
}

// ActivityIcons maps activity types to their display icons.
var ActivityIcons = map[string]string{
	"thought":  "\U0001f4ad",
	"action":   "\u26a1",
	"response": "\U0001f4ac",
	"error":    "\u2717",
	"progress": "\u2713",
}

package theme

import (
	"image/color"

	"charm.land/lipgloss/v2"
)

// Background hierarchy — from tailwind.config.ts af-bg-*
var (
	BgPrimary   color.Color = lipgloss.Color("#080C16")
	BgSecondary color.Color = lipgloss.Color("#0D1220")
	BgTertiary  color.Color = lipgloss.Color("#111828")
)

// Surface hierarchy — from tailwind.config.ts af-surface-*
var (
	Surface            color.Color = lipgloss.Color("#141B2D")
	SurfaceRaised      color.Color = lipgloss.Color("#1A2236")
	SurfaceBorder      color.Color = lipgloss.Color("#1E2740")
	SurfaceBorderBright color.Color = lipgloss.Color("#283350")
)

// Accent colors — from tailwind.config.ts af-accent-* and af-teal-*
var (
	Accent    color.Color = lipgloss.Color("#FF6B35")
	AccentDim color.Color = lipgloss.Color("#CC5529")
	Teal      color.Color = lipgloss.Color("#00D4AA")
	TealDim   color.Color = lipgloss.Color("#00A886")
	Blue      color.Color = lipgloss.Color("#4B8BF5")
)

// Status colors — from tailwind.config.ts af-status-*
var (
	StatusSuccess color.Color = lipgloss.Color("#22C55E")
	StatusWarning color.Color = lipgloss.Color("#F59E0B")
	StatusError   color.Color = lipgloss.Color("#EF4444")
)

// Text hierarchy — from tailwind.config.ts af-text-*
var (
	TextPrimary   color.Color = lipgloss.Color("#F1F5F9")
	TextSecondary color.Color = lipgloss.Color("#7C8DB5")
	TextTertiary  color.Color = lipgloss.Color("#4B5B80")
)

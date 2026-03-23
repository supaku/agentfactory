package theme

import "charm.land/lipgloss/v2"

// Header returns the style for the top header bar.
func Header() lipgloss.Style {
	return lipgloss.NewStyle().
		Foreground(TextPrimary).
		Background(Surface).
		Bold(true).
		Padding(0, 1)
}

// StatLabel returns the style for stat labels in the stats bar.
func StatLabel() lipgloss.Style {
	return lipgloss.NewStyle().
		Foreground(TextTertiary)
}

// StatValue returns the style for stat values.
func StatValue() lipgloss.Style {
	return lipgloss.NewStyle().
		Foreground(TextPrimary).
		Bold(true)
}

// StatValueAccent returns the style for highlighted stat values.
func StatValueAccent() lipgloss.Style {
	return lipgloss.NewStyle().
		Foreground(Accent).
		Bold(true)
}

// StatValueTeal returns the style for teal-colored stat values.
func StatValueTeal() lipgloss.Style {
	return lipgloss.NewStyle().
		Foreground(Teal).
		Bold(true)
}

// TableHeader returns the style for table column headers.
func TableHeader() lipgloss.Style {
	return lipgloss.NewStyle().
		Foreground(TextTertiary).
		Bold(true)
}

// TableRow returns the base style for a table row.
func TableRow() lipgloss.Style {
	return lipgloss.NewStyle().
		Foreground(TextPrimary)
}

// TableRowSelected returns the style for the selected table row.
func TableRowSelected() lipgloss.Style {
	return lipgloss.NewStyle().
		Foreground(TextPrimary).
		Background(SurfaceRaised)
}

// Muted returns the style for muted/secondary text.
func Muted() lipgloss.Style {
	return lipgloss.NewStyle().
		Foreground(TextSecondary)
}

// Dimmed returns the style for tertiary/dimmed text.
func Dimmed() lipgloss.Style {
	return lipgloss.NewStyle().
		Foreground(TextTertiary)
}

// HelpBar returns the style for the bottom help bar.
func HelpBar() lipgloss.Style {
	return lipgloss.NewStyle().
		Foreground(TextTertiary).
		Background(Surface).
		Padding(0, 1)
}

// HelpKey returns the style for a key binding label in the help bar.
func HelpKey() lipgloss.Style {
	return lipgloss.NewStyle().
		Foreground(TextSecondary).
		Bold(true)
}

// HelpDesc returns the style for a key binding description in the help bar.
func HelpDesc() lipgloss.Style {
	return lipgloss.NewStyle().
		Foreground(TextTertiary)
}

// CardBorder returns a bordered card style.
func CardBorder() lipgloss.Style {
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(SurfaceBorder).
		Padding(1, 2)
}

// SectionTitle returns the style for section titles.
func SectionTitle() lipgloss.Style {
	return lipgloss.NewStyle().
		Foreground(TextPrimary).
		Bold(true)
}

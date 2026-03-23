package detail

import (
	"fmt"
	"time"

	"charm.land/lipgloss/v2"
	"github.com/RenseiAI/agentfactory/packages/tui/internal/api"
	"github.com/RenseiAI/agentfactory/packages/tui/internal/theme"
)

// activityIcon returns the icon for an activity type.
func activityIcon(t api.ActivityType) string {
	switch t {
	case api.ActivityThought:
		return "\U0001f4ad"
	case api.ActivityAction:
		return "\u26a1"
	case api.ActivityResponse:
		return "\U0001f4ac"
	case api.ActivityError:
		return "\u2717"
	case api.ActivityProgress:
		return "\u2713"
	default:
		return "\u00b7"
	}
}

// activityColor returns the lipgloss style for an activity type.
func activityColor(t api.ActivityType) lipgloss.Style {
	switch t {
	case api.ActivityThought:
		return lipgloss.NewStyle().Foreground(theme.TextSecondary)
	case api.ActivityAction:
		return lipgloss.NewStyle().Foreground(theme.Teal)
	case api.ActivityResponse:
		return lipgloss.NewStyle().Foreground(theme.TextPrimary)
	case api.ActivityError:
		return lipgloss.NewStyle().Foreground(theme.StatusError)
	case api.ActivityProgress:
		return lipgloss.NewStyle().Foreground(theme.StatusSuccess)
	default:
		return lipgloss.NewStyle().Foreground(theme.TextTertiary)
	}
}

// ActivityViewport is a scrollable viewport for activity events.
type ActivityViewport struct {
	activities     []api.ActivityEvent
	scrollOffset   int
	viewportHeight int
	width          int
	autoFollow     bool
	focused        bool
}

// NewActivityViewport creates a new activity viewport.
func NewActivityViewport() *ActivityViewport {
	return &ActivityViewport{
		autoFollow: true,
	}
}

// SetSize updates the viewport dimensions.
func (v *ActivityViewport) SetSize(width, height int) {
	v.width = width
	v.viewportHeight = height
}

// SetActivities replaces the full activity list and optionally auto-scrolls.
func (v *ActivityViewport) SetActivities(activities []api.ActivityEvent) {
	v.activities = activities
	if v.autoFollow {
		v.scrollToBottom()
	}
}

// AppendActivities adds new activities and auto-scrolls if following.
func (v *ActivityViewport) AppendActivities(activities []api.ActivityEvent) {
	v.activities = append(v.activities, activities...)
	if v.autoFollow {
		v.scrollToBottom()
	}
}

// ScrollUp scrolls up by n lines.
func (v *ActivityViewport) ScrollUp(n int) {
	v.autoFollow = false
	v.scrollOffset -= n
	if v.scrollOffset < 0 {
		v.scrollOffset = 0
	}
}

// ScrollDown scrolls down by n lines.
func (v *ActivityViewport) ScrollDown(n int) {
	v.scrollOffset += n
	maxOffset := v.maxOffset()
	if v.scrollOffset >= maxOffset {
		v.scrollOffset = maxOffset
	}
}

// ScrollToTop jumps to the top.
func (v *ActivityViewport) ScrollToTop() {
	v.autoFollow = false
	v.scrollOffset = 0
}

// ScrollToBottom jumps to the bottom and enables auto-follow.
func (v *ActivityViewport) ScrollToBottom() {
	v.autoFollow = true
	v.scrollToBottom()
}

// ToggleAutoFollow toggles the auto-follow state.
func (v *ActivityViewport) ToggleAutoFollow() {
	v.autoFollow = !v.autoFollow
	if v.autoFollow {
		v.scrollToBottom()
	}
}

// AutoFollow returns whether auto-follow is enabled.
func (v *ActivityViewport) AutoFollow() bool {
	return v.autoFollow
}

func (v *ActivityViewport) scrollToBottom() {
	maxOff := v.maxOffset()
	if maxOff < 0 {
		maxOff = 0
	}
	v.scrollOffset = maxOff
}

func (v *ActivityViewport) maxOffset() int {
	total := len(v.activities)
	if total <= v.viewportHeight {
		return 0
	}
	return total - v.viewportHeight
}

// Render returns the viewport as a rendered string.
func (v *ActivityViewport) Render() string {
	if v.width == 0 || v.viewportHeight == 0 {
		return ""
	}

	if len(v.activities) == 0 {
		empty := theme.Muted().Render("  Waiting for agent activity...")
		return lipgloss.NewStyle().Width(v.width).Height(v.viewportHeight).Render(empty)
	}

	// Determine visible slice
	start := v.scrollOffset
	end := start + v.viewportHeight
	if end > len(v.activities) {
		end = len(v.activities)
	}
	if start > len(v.activities) {
		start = len(v.activities)
	}

	visible := v.activities[start:end]

	// Render each activity line
	lines := make([]string, 0, len(visible))
	for _, a := range visible {
		lines = append(lines, v.renderActivity(a))
	}

	// Pad remaining height
	for len(lines) < v.viewportHeight {
		lines = append(lines, "")
	}

	content := lipgloss.JoinVertical(lipgloss.Left, lines...)

	// Scroll indicators
	var indicators []string
	if start > 0 {
		above := fmt.Sprintf("  \u25b2 %d more above", start)
		indicators = append(indicators, theme.Dimmed().Render(above))
	}

	result := content
	if len(indicators) > 0 {
		// Overlay the first line with the indicator
		result = lipgloss.JoinVertical(lipgloss.Left, indicators[0], content)
	}

	// Auto-follow indicator
	if v.autoFollow && len(v.activities) > v.viewportHeight {
		followIndicator := lipgloss.NewStyle().
			Foreground(theme.Teal).
			Bold(true).
			Render("  \u27f1 FOLLOWING")
		// We'll append this to the bottom if there's room
		_ = followIndicator // Used by the parent detail view
	}

	return lipgloss.NewStyle().Width(v.width).Render(result)
}

func (v *ActivityViewport) renderActivity(a api.ActivityEvent) string {
	// Format timestamp
	ts := formatActivityTimestamp(a.Timestamp)
	tsRendered := theme.Dimmed().Render("[" + ts + "]")

	// Icon
	icon := activityIcon(a.Type)
	colorStyle := activityColor(a.Type)

	// Content with optional tool name badge
	content := a.Content
	if a.ToolName != nil && a.Type == api.ActivityAction {
		badge := lipgloss.NewStyle().
			Foreground(theme.BgPrimary).
			Background(theme.Teal).
			Padding(0, 1).
			Render(*a.ToolName)
		content = badge + " " + content
	}

	// Truncate content to fit width
	maxContentWidth := v.width - 18 // timestamp + icon + spacing
	if maxContentWidth < 20 {
		maxContentWidth = 20
	}
	if len(content) > maxContentWidth {
		content = content[:maxContentWidth-3] + "..."
	}

	rendered := colorStyle.Render(content)

	return fmt.Sprintf("  %s %s %s", tsRendered, icon, rendered)
}

func formatActivityTimestamp(isoString string) string {
	t, err := time.Parse(time.RFC3339, isoString)
	if err != nil {
		return isoString
	}
	return t.Local().Format("15:04:05")
}

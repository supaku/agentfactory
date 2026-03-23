package app

// ViewState represents which view is currently active.
type ViewState int

const (
	ViewDashboard ViewState = iota
	ViewDetail
)

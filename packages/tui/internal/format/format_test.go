package format

import "testing"

func TestDuration(t *testing.T) {
	tests := []struct {
		seconds int
		want    string
	}{
		{0, "0s"},
		{30, "30s"},
		{59, "59s"},
		{60, "1m"},
		{90, "1m 30s"},
		{300, "5m"},
		{2820, "47m"},
		{3600, "1h"},
		{3660, "1h 1m"},
		{4320, "1h 12m"},
		{7200, "2h"},
		{13500, "3h 45m"},
	}

	for _, tt := range tests {
		got := Duration(tt.seconds)
		if got != tt.want {
			t.Errorf("Duration(%d) = %q, want %q", tt.seconds, got, tt.want)
		}
	}
}

func TestCost(t *testing.T) {
	v := 3.42
	small := 0.005
	zero := 0.0

	tests := []struct {
		name string
		usd  *float64
		want string
	}{
		{"nil", nil, "--"},
		{"zero", &zero, "--"},
		{"normal", &v, "$3.42"},
		{"small", &small, "$0.0050"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Cost(tt.usd)
			if got != tt.want {
				t.Errorf("Cost(%v) = %q, want %q", tt.usd, got, tt.want)
			}
		})
	}
}

func TestProviderName(t *testing.T) {
	p := "anthropic"
	if got := ProviderName(&p); got != "anthropic" {
		t.Errorf("ProviderName(&%q) = %q, want %q", p, got, "anthropic")
	}
	if got := ProviderName(nil); got != "--" {
		t.Errorf("ProviderName(nil) = %q, want %q", got, "--")
	}
}

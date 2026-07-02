package resilience

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Default cooldowns applied by classify429.
const (
	RateLimitCooldownMs      int64 = 60_000     // ~60s
	QuotaExhaustedCooldownMs int64 = 3_600_000 // ~1h
	MaxRetryWaitMs           int64 = 30_000     // maybeWaitForCooldown cap
	MaxCooldownRetries             = 1          // retry budget for maybeWaitForCooldown
)

// CooldownResult is the output of classify429 — kind + cooldown.
type CooldownResult struct {
	Kind       FailureKind
	CooldownMs int64
}

// CooldownResponse is the shape classify429 accepts.
type CooldownResponse struct {
	Status  int
	Headers http.Header
	Body    any
}

// ---------- Heuristic patterns -------------------------------------------

var dailyQuotaPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)today'?s quota`),
	regexp.MustCompile(`(?i)daily quota (exhaust|exceed|reached|used)`),
	regexp.MustCompile(`(?i)daily limit (exhaust|exceed|reached|used)`),
	regexp.MustCompile(`(?i)per.?day (limit|quota)`),
	regexp.MustCompile(`(?i)daily.*exhaust`),
	regexp.MustCompile(`(?i)exhaust.*daily`),
	regexp.MustCompile(`(?i)daily.*cap`),
	regexp.MustCompile(`(?i)cap.*daily`),
	regexp.MustCompile(`(?i)reset.*tomorrow`),
	regexp.MustCompile(`(?i)try again tomorrow`),
	regexp.MustCompile(`(?i)come back tomorrow`),
}

var quotaExhaustedPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)monthly.*limit`),
	regexp.MustCompile(`(?i)monthly.*quota`),
	regexp.MustCompile(`(?i)per.?month.*limit`),
	regexp.MustCompile(`(?i)quota.*exceed`),
	regexp.MustCompile(`(?i)exceed.*quota`),
	regexp.MustCompile(`(?i)insufficient.*quota`),
	regexp.MustCompile(`(?i)billing.*cap`),
	regexp.MustCompile(`(?i)credit.*exhaust`),
	regexp.MustCompile(`(?i)out of credits`),
	regexp.MustCompile(`(?i)hard.?limit`),
	regexp.MustCompile(`(?i)plan.*limit`),
	regexp.MustCompile(`(?i)resource.*exhaust`),
	regexp.MustCompile(`(?i)check.*quota`),
	regexp.MustCompile(`(?i)individual quota reached`),
	regexp.MustCompile(`(?i)enable overages`),
	regexp.MustCompile(`(?i)402.*billing`),
	regexp.MustCompile(`(?i)billing.*required`),
	regexp.MustCompile(`(?i)payment.*required`),
}

// bodyToText coerces a body of unknown shape to a string for keyword scanning.
func bodyToText(body any) string {
	switch v := body.(type) {
	case nil:
		return ""
	case string:
		return v
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return ""
		}
		return string(b)
	}
}

// LooksLikeDailyQuota reports whether the body looks like a daily quota error.
func LooksLikeDailyQuota(body any) bool {
	text := bodyToText(body)
	if text == "" {
		return false
	}
	for _, p := range dailyQuotaPatterns {
		if p.MatchString(text) {
			return true
		}
	}
	return false
}

// LooksLikeQuotaExhausted reports whether the body looks like a generic
// (monthly / billing / credit) quota exhaustion error. Does NOT match daily
// patterns — those have their own classifier.
func LooksLikeQuotaExhausted(body any) bool {
	text := bodyToText(body)
	if text == "" {
		return false
	}
	for _, p := range quotaExhaustedPatterns {
		if p.MatchString(text) {
			return true
		}
	}
	return false
}

// MsUntilTomorrowMidnightUTC returns ms until next 00:00 UTC (always ≥ 1).
// Injected clock lets tests avoid time-dependent flakiness.
func MsUntilTomorrowMidnightUTC(now time.Time) int64 {
	t := now.UTC()
	next := time.Date(t.Year(), t.Month(), t.Day()+1, 0, 0, 0, 0, time.UTC)
	diff := next.UnixMilli() - t.UnixMilli()
	if diff < 1 {
		return 1
	}
	return diff
}

// Classify429 maps a response into {kind, cooldownMs}. Always returns a result
// (never nil). Decision order: daily → quota_exhausted → rate_limit (default).
func Classify429(response *CooldownResponse) CooldownResult {
	if response == nil {
		return CooldownResult{Kind: FailureKindRateLimit, CooldownMs: RateLimitCooldownMs}
	}
	if LooksLikeDailyQuota(response.Body) {
		return CooldownResult{Kind: FailureKindDailyQuota, CooldownMs: MsUntilTomorrowMidnightUTC(now())}
	}
	if LooksLikeQuotaExhausted(response.Body) {
		return CooldownResult{Kind: FailureKindQuotaExhausted, CooldownMs: QuotaExhaustedCooldownMs}
	}
	return CooldownResult{Kind: FailureKindRateLimit, CooldownMs: RateLimitCooldownMs}
}

// Classify429FromError extracts status/body from a generic error and runs
// Classify429. Returns nil when the error doesn't carry enough information
// (i.e. status is known and not 429).
//
// Recognises common error shapes via the JSON round-trip:
//   - err fields with `json:"status"` / `json:"statusCode"` (fetch wrappers, axios)
//   - err fields with `json:"body"` or `json:"data"` (response payload)
//   - err fields with `json:"message"` (last-resort body for keyword scan)
func Classify429FromError(err error) *CooldownResult {
	if err == nil {
		return nil
	}

	var status *int
	var body any

	// Preferred: marshal to JSON map and extract known field names. This is
	// reflection-free at the call site and works for any error type whose
	// fields are JSON-tagged.
	if b, mErr := json.Marshal(err); mErr == nil {
		var m map[string]any
		if uErr := json.Unmarshal(b, &m); uErr == nil {
			if v, ok := m["status"]; ok {
				if n, ok := toInt(v); ok {
					status = &n
				}
			}
			if status == nil {
				if v, ok := m["statusCode"]; ok {
					if n, ok := toInt(v); ok {
						status = &n
					}
				}
			}
			if v, ok := m["body"]; ok {
				body = v
			} else if v, ok := m["data"]; ok {
				body = v
			} else if v, ok := m["message"]; ok {
				body = v
			}
		}
	}

	if status != nil && *status != 429 {
		return nil
	}
	// Final fallback: use err.Error() so plain errors (errors.New) get the
	// message scanned for quota keywords.
	if body == nil {
		body = err.Error()
	}
	cr := Classify429(&CooldownResponse{Status: 429, Body: body})
	return &cr
}

// toInt coerces a JSON-decoded numeric value to int.
func toInt(v any) (int, bool) {
	switch x := v.(type) {
	case float64:
		return int(x), true
	case int:
		return x, true
	case int64:
		return int(x), true
	case string:
		if n, err := strconv.Atoi(x); err == nil {
			return n, true
		}
	}
	return 0, false
}

// ParseRetryAfter parses a Retry-After header to seconds. Accepts integer
// seconds, HTTP date, and Groq-style relative forms ("60s", "5m", "2h").
func ParseRetryAfter(headerValue string) *int {
	if headerValue == "" {
		return nil
	}
	trimmed := strings.TrimSpace(headerValue)
	if trimmed == "" {
		return nil
	}

	// Groq-style relative: "60s", "5m", "2h". Must check BEFORE plain int parse.
	if m := relativeDuration.FindStringSubmatch(trimmed); m != nil {
		n, err := strconv.Atoi(m[1])
		if err == nil {
			switch strings.ToLower(m[2]) {
			case "s":
				return ptrInt(n)
			case "m":
				return ptrInt(n * 60)
			case "h":
				return ptrInt(n * 3600)
			}
		}
	}

	// Pure integer seconds.
	if n, err := strconv.Atoi(trimmed); err == nil {
		return &n
	}

	// HTTP date.
	if ts, err := http.ParseTime(trimmed); err == nil {
		delta := int((ts.Unix() - now().Unix()))
		if delta < 0 {
			delta = 0
		}
		return &delta
	}

	return nil
}

var relativeDuration = regexp.MustCompile(`^(\d+)([smh])$`)

func ptrInt(n int) *int { return &n }

// RetryAfterFromResponse looks up the Retry-After header (case-insensitive) and
// parses it to seconds. Returns nil if absent or unparseable.
func RetryAfterFromResponse(headers http.Header) *int {
	if headers == nil {
		return nil
	}
	return ParseRetryAfter(headers.Get("Retry-After"))
}

// ---------- maybeWaitForCooldown ----------------------------------------

// CooldownWaitResult is the output of MaybeWaitForCooldown.
type CooldownWaitResult struct {
	ShouldRetry bool
	Reason      string // budget_exhausted, client_disconnected, invalid_retry_after, wait_too_long, wait_failed
	WaitedMs    int64
}

// CooldownOpts tunes MaybeWaitForCooldown. Defaults match JS.
type CooldownOpts struct {
	MaxWaitMs  int64
	MaxRetries int
}

// CooldownDefaults returns the JS default opts (30s / 1 retry).
func CooldownDefaults() CooldownOpts {
	return CooldownOpts{MaxWaitMs: MaxRetryWaitMs, MaxRetries: MaxCooldownRetries}
}

// MaybeWaitForCooldown decides whether to wait-and-retry when all accounts
// are rate-limited. Returns immediately with shouldRetry=false when:
//   - retriesSoFar >= MaxRetries (budget exhausted)
//   - ctx is already cancelled (client disconnected)
//   - retryAfter is missing/invalid (can't compute wait)
//   - the required wait exceeds MaxWaitMs (not worth blocking)
//
// On sleep it aborts early when ctx cancels → returns reason="client_disconnected".
// On successful wait returns shouldRetry=true with the actual sleep duration.
func MaybeWaitForCooldown(ctx context.Context, retryAfter any, retriesSoFar int, opts ...CooldownOpts) CooldownWaitResult {
	o := CooldownDefaults()
	if len(opts) > 0 {
		o = opts[0]
		if o.MaxWaitMs <= 0 {
			o.MaxWaitMs = MaxRetryWaitMs
		}
		if o.MaxRetries <= 0 {
			o.MaxRetries = MaxCooldownRetries
		}
	}

	if retriesSoFar >= o.MaxRetries {
		return CooldownWaitResult{ShouldRetry: false, Reason: "budget_exhausted"}
	}

	if err := ctx.Err(); err != nil {
		return CooldownWaitResult{ShouldRetry: false, Reason: "client_disconnected"}
	}

	targetMs := toEpochMs(retryAfter)
	if targetMs == nil {
		return CooldownWaitResult{ShouldRetry: false, Reason: "invalid_retry_after"}
	}

	cur := now().UnixMilli()
	waitMs := *targetMs - cur
	if waitMs <= 0 {
		// Already past cooldown → retry now.
		return CooldownWaitResult{ShouldRetry: true, WaitedMs: 0}
	}
	if waitMs > o.MaxWaitMs {
		return CooldownWaitResult{ShouldRetry: false, Reason: "wait_too_long"}
	}

	if err := SleepMs(ctx, waitMs); err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return CooldownWaitResult{ShouldRetry: false, Reason: "client_disconnected"}
		}
		return CooldownWaitResult{ShouldRetry: false, Reason: "wait_failed"}
	}
	return CooldownWaitResult{ShouldRetry: true, WaitedMs: waitMs}
}

// SleepMs sleeps for `ms` milliseconds, aborting early if ctx cancels.
func SleepMs(ctx context.Context, ms int64) error {
	if ms <= 0 {
		return nil
	}
	t := time.NewTimer(time.Duration(ms) * time.Millisecond)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// toEpochMs normalizes retryAfter (ISO string | epoch ms | Date) to epoch ms.
// Returns nil when missing/unparseable.
func toEpochMs(value any) *int64 {
	switch v := value.(type) {
	case nil:
		return nil
	case int64:
		if v > 0 {
			return &v
		}
		return nil
	case int:
		n := int64(v)
		if n > 0 {
			return &n
		}
		return nil
	case float64:
		if v > 0 {
			n := int64(v)
			return &n
		}
		return nil
	case time.Time:
		if !v.IsZero() {
			n := v.UnixMilli()
			return &n
		}
		return nil
	case string:
		if v == "" {
			return nil
		}
		// Try plain int first.
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			return &n
		}
		// Try RFC3339.
		if ts, err := time.Parse(time.RFC3339, v); err == nil {
			n := ts.UnixMilli()
			return &n
		}
		return nil
	default:
		return nil
	}
}

// (package-level `now = time.Now` clock hook lives in fallback.go)

// WithClock replaces the package clock for tests; returns a restore function.
func WithClock(t time.Time) func() {
	prev := now
	now = func() time.Time { return t }
	return func() { now = prev }
}

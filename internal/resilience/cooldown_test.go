package resilience

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ---- MsUntilTomorrowMidnightUTC ----------------------------------------

func TestMsUntilTomorrowMidnightUTC_JustBeforeMidnight(t *testing.T) {
	// 2026-07-01 23:59:59 UTC → ~1 second until next midnight.
	now := time.Date(2026, 7, 1, 23, 59, 59, 0, time.UTC)
	got := MsUntilTomorrowMidnightUTC(now)
	assert.InDelta(t, 1000, got, 50)
}

func TestMsUntilTomorrowMidnightUTC_StartOfDay(t *testing.T) {
	now := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	got := MsUntilTomorrowMidnightUTC(now)
	// Should be exactly 24h.
	assert.Equal(t, int64(24*time.Hour/time.Millisecond), got)
}

func TestMsUntilTomorrowMidnightUTC_NonUTC(t *testing.T) {
	// 2026-07-01 23:00:00 +07:00 == 2026-07-01 16:00:00 UTC → 8h to midnight.
	now := time.Date(2026, 7, 1, 23, 0, 0, 0, time.FixedZone("WIB", 7*3600))
	got := MsUntilTomorrowMidnightUTC(now)
	assert.InDelta(t, 8*3600*1000, got, 50)
}

// ---- LooksLikeDailyQuota ----------------------------------------------

func TestLooksLikeDailyQuota_Positive(t *testing.T) {
	assert.True(t, LooksLikeDailyQuota(map[string]any{"error": map[string]any{"message": "Today's quota has been exhausted"}}))
	assert.True(t, LooksLikeDailyQuota("daily limit reached"))
	assert.True(t, LooksLikeDailyQuota(map[string]any{"error": map[string]any{"message": "Try again tomorrow"}}))
	assert.True(t, LooksLikeDailyQuota("per-day limit exceeded"))
}

func TestLooksLikeDailyQuota_Negative(t *testing.T) {
	assert.False(t, LooksLikeDailyQuota("rate limit exceeded"))
	assert.False(t, LooksLikeDailyQuota("monthly quota exhausted"))
	assert.False(t, LooksLikeDailyQuota(nil))
	assert.False(t, LooksLikeDailyQuota(""))
}

// ---- LooksLikeQuotaExhausted ------------------------------------------

func TestLooksLikeQuotaExhausted_Positive(t *testing.T) {
	assert.True(t, LooksLikeQuotaExhausted("monthly limit reached"))
	assert.True(t, LooksLikeQuotaExhausted("insufficient quota"))
	assert.True(t, LooksLikeQuotaExhausted("payment required"))
	assert.True(t, LooksLikeQuotaExhausted(map[string]any{"error": map[string]any{"message": "Out of credits"}}))
	assert.True(t, LooksLikeQuotaExhausted("402 billing required"))
}

func TestLooksLikeQuotaExhausted_Negative(t *testing.T) {
	assert.False(t, LooksLikeQuotaExhausted("rate limit exceeded"))
	assert.False(t, LooksLikeQuotaExhausted("daily limit reached")) // daily handled separately
	assert.False(t, LooksLikeQuotaExhausted(nil))
}

// ---- Classify429 ------------------------------------------------------

func TestClassify429_RateLimitDefault(t *testing.T) {
	r := Classify429(&CooldownResponse{Status: 429, Body: map[string]any{"error": "too many requests"}})
	assert.Equal(t, FailureKindRateLimit, r.Kind)
	assert.Equal(t, RateLimitCooldownMs, r.CooldownMs)
}

func TestClassify429_QuotaExhausted(t *testing.T) {
	r := Classify429(&CooldownResponse{Status: 429, Body: map[string]any{"error": map[string]any{"message": "monthly limit reached"}}})
	assert.Equal(t, FailureKindQuotaExhausted, r.Kind)
	assert.Equal(t, QuotaExhaustedCooldownMs, r.CooldownMs)
}

func TestClassify429_DailyQuota(t *testing.T) {
	restore := WithClock(time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC))
	defer restore()
	r := Classify429(&CooldownResponse{Status: 429, Body: "daily quota exhausted"})
	assert.Equal(t, FailureKindDailyQuota, r.Kind)
	// At noon UTC, ~12h until next midnight.
	assert.InDelta(t, 12*3600*1000, r.CooldownMs, 1000)
}

func TestClassify429_DailyBeatsQuota(t *testing.T) {
	// Both patterns could match — daily should win.
	restore := WithClock(time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC))
	defer restore()
	r := Classify429(&CooldownResponse{
		Status: 429,
		Body:   "daily quota exhausted (monthly plan)",
	})
	assert.Equal(t, FailureKindDailyQuota, r.Kind, "daily pattern takes priority over monthly")
}

func TestClassify429_NilResponse(t *testing.T) {
	r := Classify429(nil)
	assert.Equal(t, FailureKindRateLimit, r.Kind)
	assert.Equal(t, RateLimitCooldownMs, r.CooldownMs)
}

func TestClassify429_StringBody(t *testing.T) {
	r := Classify429(&CooldownResponse{Status: 429, Body: "out of credits"})
	assert.Equal(t, FailureKindQuotaExhausted, r.Kind)
}

// ---- Classify429FromError --------------------------------------------

type fake429Err struct {
	Status  int    `json:"status"`
	Body    any    `json:"body"`
	Message string `json:"message"`
}

func (e *fake429Err) Error() string { return e.Message }

func TestClassify429FromError_Quota(t *testing.T) {
	err := &fake429Err{Status: 429, Body: map[string]any{"error": "insufficient quota"}}
	r := Classify429FromError(err)
	require.NotNil(t, r)
	assert.Equal(t, FailureKindQuotaExhausted, r.Kind)
}

func TestClassify429FromError_Non429(t *testing.T) {
	err := &fake429Err{Status: 500, Body: "boom"}
	r := Classify429FromError(err)
	assert.Nil(t, r, "non-429 should return nil")
}

func TestClassify429FromError_Nil(t *testing.T) {
	assert.Nil(t, Classify429FromError(nil))
}

func TestClassify429FromError_MessageFallback(t *testing.T) {
	err := &fake429Err{Status: 429, Message: "rate limit exceeded"}
	r := Classify429FromError(err)
	require.NotNil(t, r)
	assert.Equal(t, FailureKindRateLimit, r.Kind)
}

func TestClassify429FromError_StandardError(t *testing.T) {
	// Plain error without structured fields → message fallback.
	err := errors.New("daily limit reached")
	r := Classify429FromError(err)
	require.NotNil(t, r)
	assert.Equal(t, FailureKindDailyQuota, r.Kind)
}

// ---- ParseRetryAfter --------------------------------------------------

func TestParseRetryAfter_PlainSeconds(t *testing.T) {
	got := ParseRetryAfter("60")
	require.NotNil(t, got)
	assert.Equal(t, 60, *got)
}

func TestParseRetryAfter_GroqRelative(t *testing.T) {
	s := ParseRetryAfter("60s")
	require.NotNil(t, s)
	assert.Equal(t, 60, *s)
	m := ParseRetryAfter("5m")
	require.NotNil(t, m)
	assert.Equal(t, 5*60, *m)
	h := ParseRetryAfter("2h")
	require.NotNil(t, h)
	assert.Equal(t, 2*3600, *h)
}

func TestParseRetryAfter_HTTPDate(t *testing.T) {
	future := time.Now().Add(2 * time.Minute).UTC().Format(http.TimeFormat)
	got := ParseRetryAfter(future)
	require.NotNil(t, got)
	assert.InDelta(t, 120, *got, 2)
}

func TestParseRetryAfter_PastHTTPDate(t *testing.T) {
	past := time.Now().Add(-time.Minute).UTC().Format(http.TimeFormat)
	got := ParseRetryAfter(past)
	require.NotNil(t, got)
	assert.Equal(t, 0, *got, "past date clamps to 0")
}

func TestParseRetryAfter_Empty(t *testing.T) {
	assert.Nil(t, ParseRetryAfter(""))
	assert.Nil(t, ParseRetryAfter("   "))
}

func TestParseRetryAfter_Garbage(t *testing.T) {
	assert.Nil(t, ParseRetryAfter("not a date or number"))
}

// ---- RetryAfterFromResponse ------------------------------------------

func TestRetryAfterFromResponse(t *testing.T) {
	h := http.Header{}
	h.Set("Retry-After", "120")
	got := RetryAfterFromResponse(h)
	require.NotNil(t, got)
	assert.Equal(t, 120, *got)
}

func TestRetryAfterFromResponse_NilHeaders(t *testing.T) {
	assert.Nil(t, RetryAfterFromResponse(nil))
}

func TestRetryAfterFromResponse_CaseInsensitive(t *testing.T) {
	h := http.Header{}
	h.Set("retry-after", "60")
	got := RetryAfterFromResponse(h)
	require.NotNil(t, got)
	assert.Equal(t, 60, *got)
}

// ---- SleepMs ---------------------------------------------------------

func TestSleepMs_ZeroReturnsImmediately(t *testing.T) {
	start := time.Now()
	require.NoError(t, SleepMs(context.Background(), 0))
	assert.Less(t, time.Since(start), time.Millisecond)
}

func TestSleepMs_NegativeReturnsImmediately(t *testing.T) {
	require.NoError(t, SleepMs(context.Background(), -100))
}

func TestSleepMs_Duration(t *testing.T) {
	start := time.Now()
	require.NoError(t, SleepMs(context.Background(), 30))
	assert.GreaterOrEqual(t, time.Since(start), 20*time.Millisecond)
}

func TestSleepMs_ContextCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(5 * time.Millisecond)
		cancel()
	}()
	start := time.Now()
	err := SleepMs(ctx, 5000)
	require.Error(t, err)
	assert.Less(t, time.Since(start), 100*time.Millisecond, "should cancel quickly")
}

// ---- MaybeWaitForCooldown -------------------------------------------

func TestMaybeWaitForCooldown_AlreadyPast(t *testing.T) {
	restore := WithClock(time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC))
	defer restore()
	ctx := context.Background()
	got := MaybeWaitForCooldown(ctx, now().Add(-time.Hour), 0)
	assert.True(t, got.ShouldRetry)
	assert.Equal(t, int64(0), got.WaitedMs)
}

func TestMaybeWaitForCooldown_BudgetExhausted(t *testing.T) {
	ctx := context.Background()
	got := MaybeWaitForCooldown(ctx, time.Now().Add(time.Hour), 1)
	assert.False(t, got.ShouldRetry)
	assert.Equal(t, "budget_exhausted", got.Reason)
}

func TestMaybeWaitForCooldown_InvalidRetryAfter(t *testing.T) {
	ctx := context.Background()
	got := MaybeWaitForCooldown(ctx, nil, 0)
	assert.False(t, got.ShouldRetry)
	assert.Equal(t, "invalid_retry_after", got.Reason)
}

func TestMaybeWaitForCooldown_WaitTooLong(t *testing.T) {
	ctx := context.Background()
	far := time.Now().Add(2 * time.Hour)
	got := MaybeWaitForCooldown(ctx, far, 0)
	assert.False(t, got.ShouldRetry)
	assert.Equal(t, "wait_too_long", got.Reason)
}

func TestMaybeWaitForCooldown_ClientAlreadyDisconnected(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	got := MaybeWaitForCooldown(ctx, time.Now().Add(time.Second), 0)
	assert.False(t, got.ShouldRetry)
	assert.Equal(t, "client_disconnected", got.Reason)
}

func TestMaybeWaitForCooldown_HappyPath(t *testing.T) {
	ctx := context.Background()
	soon := time.Now().Add(40 * time.Millisecond)
	start := time.Now()
	got := MaybeWaitForCooldown(ctx, soon, 0)
	assert.True(t, got.ShouldRetry)
	assert.GreaterOrEqual(t, got.WaitedMs, int64(30))
	assert.Less(t, time.Since(start), 200*time.Millisecond)
}

func TestMaybeWaitForCooldown_ContextCancelDuringWait(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(10 * time.Millisecond)
		cancel()
	}()
	far := time.Now().Add(2 * time.Second)
	got := MaybeWaitForCooldown(ctx, far, 0)
	assert.False(t, got.ShouldRetry)
	assert.Equal(t, "client_disconnected", got.Reason)
}

func TestMaybeWaitForCooldown_RetriesSoFarString(t *testing.T) {
	// string retryAfter → should be parsed.
	restore := WithClock(time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC))
	defer restore()
	past := now().Add(-time.Second).Format(time.RFC3339)
	got := MaybeWaitForCooldown(context.Background(), past, 0)
	assert.True(t, got.ShouldRetry)
}

func TestMaybeWaitForCooldown_RetriesSoFarEpochString(t *testing.T) {
	restore := WithClock(time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC))
	defer restore()
	past := strconv.FormatInt(now().Add(-time.Second).UnixMilli(), 10)
	got := MaybeWaitForCooldown(context.Background(), past, 0)
	assert.True(t, got.ShouldRetry)
}

// ---- CooldownDefaults -------------------------------------------------

func TestCooldownDefaults(t *testing.T) {
	d := CooldownDefaults()
	assert.Equal(t, int64(30_000), d.MaxWaitMs)
	assert.Equal(t, 1, d.MaxRetries)
}

// ---- TestClassify429 meta-test entry point ---------------------------

func TestClassify429(t *testing.T) {
	t.Run("MsUntilTomorrowMidnightUTC_JustBeforeMidnight", TestMsUntilTomorrowMidnightUTC_JustBeforeMidnight)
	t.Run("MsUntilTomorrowMidnightUTC_StartOfDay", TestMsUntilTomorrowMidnightUTC_StartOfDay)
	t.Run("MsUntilTomorrowMidnightUTC_NonUTC", TestMsUntilTomorrowMidnightUTC_NonUTC)
	t.Run("LooksLikeDailyQuota_Positive", TestLooksLikeDailyQuota_Positive)
	t.Run("LooksLikeDailyQuota_Negative", TestLooksLikeDailyQuota_Negative)
	t.Run("LooksLikeQuotaExhausted_Positive", TestLooksLikeQuotaExhausted_Positive)
	t.Run("LooksLikeQuotaExhausted_Negative", TestLooksLikeQuotaExhausted_Negative)
	t.Run("Classify429_RateLimitDefault", TestClassify429_RateLimitDefault)
	t.Run("Classify429_QuotaExhausted", TestClassify429_QuotaExhausted)
	t.Run("Classify429_DailyQuota", TestClassify429_DailyQuota)
	t.Run("Classify429_DailyBeatsQuota", TestClassify429_DailyBeatsQuota)
	t.Run("Classify429_NilResponse", TestClassify429_NilResponse)
	t.Run("Classify429_StringBody", TestClassify429_StringBody)
	t.Run("Classify429FromError_Quota", TestClassify429FromError_Quota)
	t.Run("Classify429FromError_Non429", TestClassify429FromError_Non429)
	t.Run("Classify429FromError_Nil", TestClassify429FromError_Nil)
	t.Run("Classify429FromError_MessageFallback", TestClassify429FromError_MessageFallback)
	t.Run("Classify429FromError_StandardError", TestClassify429FromError_StandardError)
	t.Run("ParseRetryAfter_PlainSeconds", TestParseRetryAfter_PlainSeconds)
	t.Run("ParseRetryAfter_GroqRelative", TestParseRetryAfter_GroqRelative)
	t.Run("ParseRetryAfter_HTTPDate", TestParseRetryAfter_HTTPDate)
	t.Run("ParseRetryAfter_PastHTTPDate", TestParseRetryAfter_PastHTTPDate)
	t.Run("ParseRetryAfter_Empty", TestParseRetryAfter_Empty)
	t.Run("ParseRetryAfter_Garbage", TestParseRetryAfter_Garbage)
	t.Run("RetryAfterFromResponse", TestRetryAfterFromResponse)
	t.Run("RetryAfterFromResponse_NilHeaders", TestRetryAfterFromResponse_NilHeaders)
	t.Run("RetryAfterFromResponse_CaseInsensitive", TestRetryAfterFromResponse_CaseInsensitive)
	t.Run("SleepMs_ZeroReturnsImmediately", TestSleepMs_ZeroReturnsImmediately)
	t.Run("SleepMs_NegativeReturnsImmediately", TestSleepMs_NegativeReturnsImmediately)
	t.Run("SleepMs_Duration", TestSleepMs_Duration)
	t.Run("SleepMs_ContextCancel", TestSleepMs_ContextCancel)
	t.Run("MaybeWaitForCooldown_AlreadyPast", TestMaybeWaitForCooldown_AlreadyPast)
	t.Run("MaybeWaitForCooldown_BudgetExhausted", TestMaybeWaitForCooldown_BudgetExhausted)
	t.Run("MaybeWaitForCooldown_InvalidRetryAfter", TestMaybeWaitForCooldown_InvalidRetryAfter)
	t.Run("MaybeWaitForCooldown_WaitTooLong", TestMaybeWaitForCooldown_WaitTooLong)
	t.Run("MaybeWaitForCooldown_ClientAlreadyDisconnected", TestMaybeWaitForCooldown_ClientAlreadyDisconnected)
	t.Run("MaybeWaitForCooldown_HappyPath", TestMaybeWaitForCooldown_HappyPath)
	t.Run("MaybeWaitForCooldown_ContextCancelDuringWait", TestMaybeWaitForCooldown_ContextCancelDuringWait)
	t.Run("MaybeWaitForCooldown_RetriesSoFarString", TestMaybeWaitForCooldown_RetriesSoFarString)
	t.Run("MaybeWaitForCooldown_RetriesSoFarEpochString", TestMaybeWaitForCooldown_RetriesSoFarEpochString)
	t.Run("CooldownDefaults", TestCooldownDefaults)
}

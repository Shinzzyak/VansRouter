package auth

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func withFrozenTime(t *testing.T, start time.Time) {
	orig := now
	now = func() time.Time { return start }
	t.Cleanup(func() { now = orig })
}

func TestLoginLimiterInitialState(t *testing.T) {
	l := NewLoginLimiter()
	status := l.IsLocked("1.2.3.4", "alice")
	assert.False(t, status.Locked)
	assert.Equal(t, 0, status.RetryAfter)
}

func TestLoginLimiterCountsFailures(t *testing.T) {
	l := NewLoginLimiter()

	for i := 1; i <= 4; i++ {
		res := l.RecordFailure("1.2.3.4", "alice")
		assert.Equal(t, 5-i, res.RemainingBeforeLock)
	}
	assert.False(t, l.IsLocked("1.2.3.4", "alice").Locked)
}

func TestLoginLimiterLocksAfterFiveFailures(t *testing.T) {
	start := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	withFrozenTime(t, start)

	l := NewLoginLimiter()
	for i := 0; i < 4; i++ {
		l.RecordFailure("1.2.3.4", "alice")
	}

	res := l.RecordFailure("1.2.3.4", "alice")
	assert.Equal(t, 0, res.RemainingBeforeLock)

	status := l.IsLocked("1.2.3.4", "alice")
	assert.True(t, status.Locked)
	assert.Equal(t, 30, status.RetryAfter)
}

func TestLoginLimiterLockEscalation(t *testing.T) {
	start := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	withFrozenTime(t, start)

	l := NewLoginLimiter()
	key := func() LockStatus { return l.IsLocked("1.2.3.4", "alice") }

	triggerLock := func() {
		for i := 0; i < 5; i++ {
			l.RecordFailure("1.2.3.4", "alice")
		}
	}

	triggerLock()
	assert.Equal(t, 30, key().RetryAfter)

	// Advance just past the first lock so a new failure re-locks at the next step.
	now = func() time.Time { return start.Add(31 * time.Second) }
	triggerLock()
	assert.Equal(t, 120, key().RetryAfter)

	now = func() time.Time { return start.Add(31*time.Second + 121*time.Second) }
	triggerLock()
	assert.Equal(t, 600, key().RetryAfter)

	now = func() time.Time { return start.Add(31*time.Second + 121*time.Second + 601*time.Second) }
	triggerLock()
	assert.Equal(t, 1800, key().RetryAfter)

	// After the final step the duration stays at the maximum.
	now = func() time.Time {
		return start.Add(31*time.Second + 121*time.Second + 601*time.Second + 1801*time.Second)
	}
	triggerLock()
	assert.Equal(t, 1800, key().RetryAfter)
}

func TestLoginLimiterClearOnSuccess(t *testing.T) {
	start := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	withFrozenTime(t, start)

	l := NewLoginLimiter()
	for i := 0; i < 5; i++ {
		l.RecordFailure("1.2.3.4", "alice")
	}
	assert.True(t, l.IsLocked("1.2.3.4", "alice").Locked)

	l.ClearOnSuccess("1.2.3.4", "alice")
	assert.False(t, l.IsLocked("1.2.3.4", "alice").Locked)

	res := l.RecordFailure("1.2.3.4", "alice")
	assert.Equal(t, 4, res.RemainingBeforeLock)
}

func TestLoginLimiterAutoResetAfterWindow(t *testing.T) {
	start := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	withFrozenTime(t, start)

	l := NewLoginLimiter()
	l.RecordFailure("1.2.3.4", "alice")
	assert.Equal(t, 3, l.RecordFailure("1.2.3.4", "alice").RemainingBeforeLock)

	// Move past the one-hour sliding window without a current lock.
	now = func() time.Time { return start.Add(time.Hour + time.Second) }
	res := l.RecordFailure("1.2.3.4", "alice")
	assert.Equal(t, 4, res.RemainingBeforeLock)
}

func TestLoginLimiterDoesNotAutoResetWhileLocked(t *testing.T) {
	start := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	withFrozenTime(t, start)

	l := NewLoginLimiter()
	for i := 0; i < 5; i++ {
		l.RecordFailure("1.2.3.4", "alice")
	}

	// Still within the fail window but the lock is active for 30 seconds.
	now = func() time.Time { return start.Add(5 * time.Second) }
	assert.True(t, l.IsLocked("1.2.3.4", "alice").Locked)

	// Move past the one-hour fail window but before the lock expires.
	now = func() time.Time { return start.Add(time.Hour + time.Second) }
	assert.True(t, l.IsLocked("1.2.3.4", "alice").Locked)
}

func TestLoginLimiterIsolationByIP(t *testing.T) {
	start := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	withFrozenTime(t, start)

	l := NewLoginLimiter()
	for i := 0; i < 5; i++ {
		l.RecordFailure("1.2.3.4", "alice")
	}
	assert.True(t, l.IsLocked("1.2.3.4", "alice").Locked)
	assert.False(t, l.IsLocked("5.6.7.8", "alice").Locked)
}

func TestLoginLimiterIsolationByUsername(t *testing.T) {
	start := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	withFrozenTime(t, start)

	l := NewLoginLimiter()
	for i := 0; i < 5; i++ {
		l.RecordFailure("1.2.3.4", "alice")
	}
	assert.True(t, l.IsLocked("1.2.3.4", "alice").Locked)
	assert.False(t, l.IsLocked("1.2.3.4", "bob").Locked)
}

func TestLoginLimiterRetryAfterDecreases(t *testing.T) {
	start := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	withFrozenTime(t, start)

	l := NewLoginLimiter()
	for i := 0; i < 5; i++ {
		l.RecordFailure("1.2.3.4", "alice")
	}

	now = func() time.Time { return start.Add(10 * time.Second) }
	status := l.IsLocked("1.2.3.4", "alice")
	assert.True(t, status.Locked)
	assert.Equal(t, 20, status.RetryAfter)
}

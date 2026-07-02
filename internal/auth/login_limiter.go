package auth

import (
	"sync"
	"time"
)

// Login limiter policy constants, ported from src/lib/auth/loginLimiter.js.
const (
	maxFailsBeforeLock = 5
	failWindow         = time.Hour
)

var lockSteps = []time.Duration{
	30 * time.Second,
	2 * time.Minute,
	10 * time.Minute,
	30 * time.Minute,
}

// LoginLimiter provides an in-memory progressive lockout for dashboard login.
// It matches the JS policy: keyed by IP+username, sliding one-hour window,
// escalating lock durations after every five failures. Once an entry enters
// a locked cycle it stays locked until ClearOnSuccess, even past lockUntil,
// so a stale lock cannot be silently bypassed. The one-hour auto-reset only
// applies to entries that have never been locked (lockLevel == 0).
type LoginLimiter struct {
	mu   sync.Mutex
	data map[string]*loginEntry
}

type loginEntry struct {
	fails      int
	lockUntil  time.Time
	lockLevel  int
	lastFailAt time.Time
}

// LockStatus reports whether a key is currently locked and how long to wait.
type LockStatus struct {
	Locked     bool
	RetryAfter int // seconds
}

// RecordResult reports how many failures remain before a lock is applied.
type RecordResult struct {
	RemainingBeforeLock int
}

// NewLoginLimiter creates a fresh in-memory login limiter.
func NewLoginLimiter() *LoginLimiter {
	return &LoginLimiter{data: make(map[string]*loginEntry)}
}

// RecordFailure records a failed login attempt for the given IP and username.
// It returns the number of remaining failures before the account locks. When
// the lock triggers the remaining count is zero.
func (l *LoginLimiter) RecordFailure(ip, username string) *RecordResult {
	l.mu.Lock()
	defer l.mu.Unlock()

	key := limiterKey(ip, username)
	e := l.getEntryUnlocked(key)
	if e == nil {
		e = &loginEntry{}
	}

	e.fails++
	e.lastFailAt = now()
	remaining := max(0, maxFailsBeforeLock-e.fails)
	if e.fails >= maxFailsBeforeLock {
		step := lockSteps[min(e.lockLevel, len(lockSteps)-1)]
		e.lockUntil = now().Add(step)
		e.lockLevel++
		e.fails = 0
		remaining = 0
	}
	l.data[key] = e

	return &RecordResult{RemainingBeforeLock: remaining}
}

// ClearOnSuccess clears all failure state for the given IP and username,
// matching the JS recordSuccess behavior.
func (l *LoginLimiter) ClearOnSuccess(ip, username string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.data, limiterKey(ip, username))
}

// IsLocked reports whether the given IP and username are currently locked out.
// An entry that has ever entered a locked cycle stays locked until cleared,
// matching the JS policy and the "does not auto reset while locked" test.
func (l *LoginLimiter) IsLocked(ip, username string) LockStatus {
	l.mu.Lock()
	defer l.mu.Unlock()

	e := l.getEntryUnlocked(limiterKey(ip, username))
	if e == nil || e.lockLevel == 0 {
		return LockStatus{Locked: false}
	}
	remaining := e.lockUntil.Sub(now())
	if remaining < 0 {
		remaining = 0
	}
	return LockStatus{Locked: true, RetryAfter: int(remaining.Seconds())}
}

// getEntryUnlocked returns the entry, applying the JS reset policy.
// The one-hour sliding window auto-reset only applies to entries that have
// never been locked; locked entries persist until ClearOnSuccess.
// Must be called with l.mu held.
func (l *LoginLimiter) getEntryUnlocked(key string) *loginEntry {
	e, ok := l.data[key]
	if !ok {
		return nil
	}
	if e.lockLevel == 0 && !e.lastFailAt.IsZero() && now().Sub(e.lastFailAt) > failWindow {
		delete(l.data, key)
		return nil
	}
	return e
}

func limiterKey(ip, username string) string {
	return ip + "|" + username
}

// now is a variable hook so tests can manipulate time.
// ponytail: a package-level func var is cheaper than injecting a clock
// interface and matches the JS module-level `now()` exactly.
var now = time.Now

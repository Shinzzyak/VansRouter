package repos

import (
	"sync"
	"time"
)

// CacheEntry stores a cached value plus its expiration time.
type CacheEntry[V any] struct {
	Value      V
	Expiration time.Time
}

// TTLCache is a simple in-memory cache with per-entry TTL and explicit invalidation.
// It uses a sync.RWMutex for thread-safe access.
type TTLCache[K comparable, V any] struct {
	mu      sync.RWMutex
	entries map[K]CacheEntry[V]
	ttl     time.Duration
}

// NewTTLCache creates a cache where entries expire after ttl.
func NewTTLCache[K comparable, V any](ttl time.Duration) *TTLCache[K, V] {
	return &TTLCache[K, V]{
		entries: make(map[K]CacheEntry[V]),
		ttl:     ttl,
	}
}

// Get returns the cached value and true if it is present and not expired.
func (c *TTLCache[K, V]) Get(key K) (V, bool) {
	c.mu.RLock()
	entry, ok := c.entries[key]
	c.mu.RUnlock()
	if !ok || time.Now().After(entry.Expiration) {
		var zero V
		return zero, false
	}
	return entry.Value, true
}

// Set stores a value in the cache with the configured TTL.
func (c *TTLCache[K, V]) Set(key K, value V) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = CacheEntry[V]{
		Value:      value,
		Expiration: time.Now().Add(c.ttl),
	}
}

// Invalidate removes a single key from the cache.
func (c *TTLCache[K, V]) Invalidate(key K) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, key)
}

// InvalidateAll clears the entire cache.
func (c *TTLCache[K, V]) InvalidateAll() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries = make(map[K]CacheEntry[V])
}

package repos

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestTTLCache(t *testing.T) {
	c := NewTTLCache[string, int](100 * time.Millisecond)

	c.Set("a", 1)
	v, ok := c.Get("a")
	assert.True(t, ok)
	assert.Equal(t, 1, v)

	c.Invalidate("a")
	_, ok = c.Get("a")
	assert.False(t, ok)

	c.Set("b", 2)
	time.Sleep(150 * time.Millisecond)
	_, ok = c.Get("b")
	assert.False(t, ok)

	c.Set("c", 3)
	c.InvalidateAll()
	_, ok = c.Get("c")
	assert.False(t, ok)
}

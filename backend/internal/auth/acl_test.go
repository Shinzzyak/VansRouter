package auth

import (
	"path/filepath"
	"testing"

	"github.com/9router/9router/backend/internal/db/repos"
	"github.com/9router/9router/backend/internal/providers"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func loadTestRegistry(t *testing.T) *providers.Registry {
	t.Helper()
	r, err := providers.LoadRegistry(filepath.Join("..", "..", "data", "providers.json"))
	require.NoError(t, err)
	return r
}

func ptrProviders(list []string) []string { return list }
func ptrCombos(list []string) []string    { return list }
func ptrKinds(list []string) []string     { return list }

func TestIsProviderAllowed(t *testing.T) {
	registry := loadTestRegistry(t)

	t.Run("nil key allows all", func(t *testing.T) {
		assert.True(t, IsProviderAllowed(nil, registry, "openai", ""))
	})
	t.Run("null allow-list allows all", func(t *testing.T) {
		key := &repos.APIKey{}
		assert.True(t, IsProviderAllowed(key, registry, "openai", ""))
	})
	t.Run("empty allow-list denies all", func(t *testing.T) {
		key := &repos.APIKey{AllowedProviders: []string{}}
		assert.False(t, IsProviderAllowed(key, registry, "openai", ""))
	})
	t.Run("explicit allow-list", func(t *testing.T) {
		key := &repos.APIKey{AllowedProviders: []string{"glm", "minimax"}}
		assert.True(t, IsProviderAllowed(key, registry, "glm", ""))
		assert.True(t, IsProviderAllowed(key, registry, "minimax", ""))
		assert.False(t, IsProviderAllowed(key, registry, "openai", ""))
	})
	t.Run("alias resolution", func(t *testing.T) {
		key := &repos.APIKey{AllowedProviders: []string{"oc"}}
		assert.True(t, IsProviderAllowed(key, registry, "opencode", ""))
	})
	t.Run("custom-compatible prefix", func(t *testing.T) {
		key := &repos.APIKey{AllowedProviders: []string{"tr"}}
		assert.True(t, IsProviderAllowed(key, registry, "openai-compatible-chat-abc12345", "tr"))
		assert.False(t, IsProviderAllowed(key, registry, "openai-compatible-chat-abc12345", "oc"))
	})
}

func TestIsComboAllowed(t *testing.T) {
	t.Run("nil key allows all", func(t *testing.T) {
		assert.True(t, IsComboAllowed(nil, "coding-stack"))
	})
	t.Run("null allow-list allows all", func(t *testing.T) {
		key := &repos.APIKey{}
		assert.True(t, IsComboAllowed(key, "coding-stack"))
	})
	t.Run("empty allow-list denies all", func(t *testing.T) {
		key := &repos.APIKey{AllowedCombos: []string{}}
		assert.False(t, IsComboAllowed(key, "coding-stack"))
	})
	t.Run("explicit allow-list", func(t *testing.T) {
		key := &repos.APIKey{AllowedCombos: []string{"coding-stack"}}
		assert.True(t, IsComboAllowed(key, "coding-stack"))
		assert.True(t, IsComboAllowed(key, "combo/coding-stack"))
		assert.False(t, IsComboAllowed(key, "free-forever"))
		assert.False(t, IsComboAllowed(key, "Coding-Stack"))
	})
}

func TestIsKindAllowed(t *testing.T) {
	kinds := []struct {
		name string
	}{
		{"llm"}, {"embedding"}, {"image"}, {"tts"}, {"stt"}, {"web"},
	}
	t.Run("nil key allows all", func(t *testing.T) {
		for _, k := range kinds {
			assert.True(t, IsKindAllowed(nil, k.name))
		}
	})
	t.Run("empty allow-list denies all", func(t *testing.T) {
		key := &repos.APIKey{AllowedKinds: []string{}}
		for _, k := range kinds {
			assert.False(t, IsKindAllowed(key, k.name))
		}
	})
	t.Run("explicit allow-list", func(t *testing.T) {
		key := &repos.APIKey{AllowedKinds: []string{"llm", "web"}}
		assert.True(t, IsKindAllowed(key, "llm"))
		assert.True(t, IsKindAllowed(key, "web"))
		assert.False(t, IsKindAllowed(key, "image"))
	})
}

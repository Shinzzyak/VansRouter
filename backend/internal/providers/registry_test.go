package providers

import (
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLoadRegistry(t *testing.T) {
	path := filepath.Join("..", "..", "data", "providers.json")
	r, err := LoadRegistry(path)

	require.NoError(t, err)
	assert.NotEmpty(t, r.GeneratedAt)
	assert.NotEmpty(t, r.NodeVersion)
	assert.GreaterOrEqual(t, len(r.Providers), 100, "expected at least 100 providers")
	assert.NotEmpty(t, r.PROVIDERS, "expected PROVIDERS to be populated")
	assert.NotEmpty(t, r.PROVIDER_MODELS)
	assert.NotEmpty(t, r.PROVIDER_OAUTH)
	assert.NotEmpty(t, r.PROVIDER_MEDIA)

	// Sanity-check a representative provider.
	p, ok := r.Providers["agentrouter"]
	require.True(t, ok, "expected provider 'agentrouter' to exist")
	assert.Equal(t, "agentrouter", p.ID)
	assert.Equal(t, "agentrouter", p.Alias)
	assert.NotEmpty(t, p.Display)
	assert.NotEmpty(t, p.Transport)
	assert.NotEmpty(t, p.Models)

}

func TestLoadRegistryMissingFile(t *testing.T) {
	_, err := LoadRegistry(filepath.Join("..", "..", "data", "does-not-exist.json"))
	require.Error(t, err)
}

func TestLoadRegistryEmptyPath(t *testing.T) {
	_, err := LoadRegistry("")
	require.Error(t, err)
}

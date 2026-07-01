package repos

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestKeyRepo(t *testing.T) {
	database, cleanup := openReposTestDB(t)
	defer cleanup()

	r := NewKeysRepo(database)

	k, err := r.Create("test", "machine-1", "ak-12345")
	require.NoError(t, err)
	require.NotEmpty(t, k.ID)
	assert.Equal(t, "test", k.Name)
	assert.Equal(t, "machine-1", k.MachineID)
	assert.Equal(t, "ak-12345", k.Key)
	assert.True(t, k.IsActive)

	// Cache hit on second GetByKey.
	cached, err := r.GetByKey(k.Key)
	require.NoError(t, err)
	assert.Equal(t, k.ID, cached.ID)

	list, err := r.List()
	require.NoError(t, err)
	assert.Len(t, list, 1)

	updated, err := r.Update(k.ID, func(key *APIKey) {
		key.Name = "renamed"
		key.IsActive = false
		key.AllowedProviders = []string{"openai"}
	})
	require.NoError(t, err)
	require.NotNil(t, updated)
	assert.Equal(t, "renamed", updated.Name)
	assert.False(t, updated.IsActive)
	assert.Equal(t, []string{"openai"}, updated.AllowedProviders)

	fetched, err := r.GetByID(k.ID)
	require.NoError(t, err)
	assert.Equal(t, "renamed", fetched.Name)
	assert.Equal(t, []string{"openai"}, fetched.AllowedProviders)

	ok, err := r.Delete(k.ID)
	require.NoError(t, err)
	assert.True(t, ok)

	_, err = r.GetByKey(k.Key)
	require.NoError(t, err)
	list, err = r.List()
	require.NoError(t, err)
	assert.Empty(t, list)
}

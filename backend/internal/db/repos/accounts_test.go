package repos

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAccountRepo(t *testing.T) {
	database, cleanup := openReposTestDB(t)
	defer cleanup()

	r := NewAccountsRepo(database)

	account := &Account{
		Provider:    "openai",
		AuthType:    "apikey",
		Name:        "prod",
		Email:       "prod@example.com",
		Priority:    1,
		IsActive:    true,
		AccessToken: "sk-secret",
		Data:        map[string]any{"foo": "bar"},
	}
	created, err := r.Create(account)
	require.NoError(t, err)
	require.NotEmpty(t, created.ID)
	assert.Equal(t, "openai", created.Provider)

	// Cache hit on second list.
	list, err := r.List("openai", nil)
	require.NoError(t, err)
	assert.Len(t, list, 1)
	assert.Equal(t, created.ID, list[0].ID)
	assert.Equal(t, "sk-secret", list[0].AccessToken)

	active := true
	list, err = r.List("openai", &active)
	require.NoError(t, err)
	assert.Len(t, list, 1)

	updated, err := r.Update(created.ID, func(a *Account) {
		a.Name = "renamed"
		a.AccessToken = "sk-new"
	})
	require.NoError(t, err)
	require.NotNil(t, updated)
	assert.Equal(t, "renamed", updated.Name)

	fetched, err := r.GetByID(created.ID)
	require.NoError(t, err)
	assert.Equal(t, "renamed", fetched.Name)
	assert.Equal(t, "sk-new", fetched.AccessToken)

	ok, err := r.Delete(created.ID)
	require.NoError(t, err)
	assert.True(t, ok)

	list, err = r.List("openai", nil)
	require.NoError(t, err)
	assert.Empty(t, list)
}

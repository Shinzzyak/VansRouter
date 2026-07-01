package repos

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestUsageRepo(t *testing.T) {
	database, cleanup := openReposTestDB(t)
	defer cleanup()

	r := NewUsageRepo(database)

	e := &UsageEntry{
		Provider:         "openai",
		Model:            "gpt-4",
		ConnectionID:     "conn-1",
		APIKey:           "ak-1",
		Endpoint:         "chat",
		PromptTokens:     10,
		CompletionTokens: 5,
		Cost:             0.001,
		Status:           "ok",
		Tokens: map[string]any{
			"prompt_tokens":     10,
			"completion_tokens": 5,
		},
	}
	require.NoError(t, r.Save(e))

	history, err := r.ListHistory(10)
	require.NoError(t, err)
	assert.Len(t, history, 1)
	assert.Equal(t, 10, history[0].PromptTokens)

	lifetime, err := r.GetLifetimeCounter()
	require.NoError(t, err)
	assert.Equal(t, 1, lifetime)

	day, err := r.GetDaily(time.Now().UTC().Format("2006-01-02"))
	require.NoError(t, err)
	require.NotNil(t, day)
	assert.Equal(t, 1, day.Requests)
	assert.Equal(t, 10, day.PromptTokens)
	assert.Equal(t, 5, day.CompletionTokens)
	assert.Equal(t, 0.001, day.Cost)
	assert.Equal(t, 1, day.ByProvider["openai"].Requests)
}

package refresh

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestShouldRefresh_NearExpiry(t *testing.T) {
	now := time.Now()
	creds := &Credentials{AccessToken: "tok", ExpiresAt: now.Add(1 * time.Minute)}
	assert.True(t, ShouldRefresh("openai", creds, now))
}

func TestShouldRefresh_Fresh(t *testing.T) {
	now := time.Now()
	creds := &Credentials{AccessToken: "tok", ExpiresAt: now.Add(1 * time.Hour)}
	assert.False(t, ShouldRefresh("openai", creds, now))
}

func TestShouldRefresh_MaxAge(t *testing.T) {
	now := time.Now()
	creds := &Credentials{RefreshToken: "rt", LastRefreshAt: now.Add(-9 * 24 * time.Hour)}
	Register("codex", func(ctx context.Context, c Credentials) (*Refreshed, error) { return nil, nil }, ProviderConfig{MaxRefreshAgeMs: 8 * 24 * time.Hour, TrackRefreshAt: true})
	assert.True(t, ShouldRefresh("codex", creds, now))
}

func TestShouldRefresh_NoCredentials(t *testing.T) {
	assert.False(t, ShouldRefresh("openai", nil, time.Now()))
}

func TestIsUnrecoverableError(t *testing.T) {
	assert.True(t, IsUnrecoverableError(&Refreshed{Error: "invalid_grant"}))
	assert.True(t, IsUnrecoverableError(&Refreshed{Error: "refresh_token_reused"}))
	assert.False(t, IsUnrecoverableError(&Refreshed{Error: "network_error"}))
	assert.False(t, IsUnrecoverableError(nil))
}

func TestMergeRefreshedCredentials(t *testing.T) {
	now := time.Now()
	current := &Credentials{AccessToken: "old", RefreshToken: "rt", IDToken: "id"}
	refreshed := &Refreshed{AccessToken: "new", ExpiresIn: 3600, ProjectID: "proj"}
	merged, err := MergeRefreshedCredentials("openai", current, refreshed, now)
	require.NoError(t, err)
	assert.Equal(t, "new", merged.AccessToken)
	assert.Equal(t, "rt", merged.RefreshToken)
	assert.Equal(t, "id", merged.IDToken)
	assert.Equal(t, "proj", merged.ProjectID)
	assert.WithinDuration(t, now.Add(3600*time.Second), merged.ExpiresAt, time.Second)
}

func TestMergeRefreshedCredentials_Unrecoverable(t *testing.T) {
	_, err := MergeRefreshedCredentials("openai", nil, &Refreshed{Error: "invalid_grant"}, time.Now())
	require.Error(t, err)
}

func TestMergeRefreshedCredentials_Nil(t *testing.T) {
	merged, err := MergeRefreshedCredentials("openai", nil, nil, time.Now())
	require.NoError(t, err)
	assert.Nil(t, merged)
}

func TestRefreshProviderCredentials_NoRegistry(t *testing.T) {
	creds := &Credentials{AccessToken: "tok"}
	out, err := RefreshProviderCredentials(context.Background(), "unknown", creds)
	require.NoError(t, err)
	assert.Equal(t, "tok", out.AccessToken)
}

func TestRefreshProviderCredentials_Lock(t *testing.T) {
	called := 0
	Register("test-lock", func(ctx context.Context, c Credentials) (*Refreshed, error) {
		called++
		return &Refreshed{AccessToken: "refreshed"}, nil
	}, ProviderConfig{})
	creds := &Credentials{AccessToken: "old", RefreshToken: "rt"}
	out, err := RefreshProviderCredentials(context.Background(), "test-lock", creds)
	require.NoError(t, err)
	assert.Equal(t, "refreshed", out.AccessToken)
	assert.Equal(t, 1, called)
}

func TestRefreshProviderCredentials_Error(t *testing.T) {
	Register("test-err", func(ctx context.Context, c Credentials) (*Refreshed, error) {
		return nil, errors.New("boom")
	}, ProviderConfig{})
	_, err := RefreshProviderCredentials(context.Background(), "test-err", &Credentials{})
	require.Error(t, err)
}

func TestMarshalForLog(t *testing.T) {
	s := MarshalForLog(&Credentials{AccessToken: "sk-1234567890abcdef"})
	assert.Contains(t, s, "sk-1...cdef")
	assert.NotContains(t, s, "sk-1234567890abcdef")
}

func TestRefreshLockKey(t *testing.T) {
	a := refreshLockKey("p", &Credentials{RefreshToken: "0123456789abcdef"})
	b := refreshLockKey("p", &Credentials{RefreshToken: "0123456789abcdef"})
	c := refreshLockKey("p", &Credentials{RefreshToken: "fedcba9876543210"})
	assert.Equal(t, a, b)
	assert.NotEqual(t, a, c)
}

func TestInit(t *testing.T) {
	Init()
	_, ok := registry["codex"]
	assert.True(t, ok)
}

package auth

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestIsTrustedInternalRequestHappyPath(t *testing.T) {
	dir := t.TempDir()
	ResetMachineCache()
	DataDirSource = func() string { return dir }
	t.Cleanup(func() { DataDirSource = nil; ResetMachineCache() })

	token, err := GetConsistentMachineId(dir, CLIAuthSalt)
	require.NoError(t, err)
	require.Regexp(t, expectedTokenRe, token)

	t.Run("accepts exact valid token", func(t *testing.T) {
		assert.True(t, IsTrustedInternalRequest(reqWithHeader(token)))
	})
}

func TestIsTrustedInternalRequestMalformed(t *testing.T) {
	dir := t.TempDir()
	ResetMachineCache()
	DataDirSource = func() string { return dir }
	t.Cleanup(func() { DataDirSource = nil; ResetMachineCache() })

	tests := []struct {
		name  string
		token string
	}{
		{"absent", ""},
		{"empty", ""},
		{"whitespace", "   "},
		{"wrong length short", "a1b2c3d4"},
		{"wrong length long", "a1b2c3d4e5f6a7b8x"},
		{"wrong chars", "ffffffffffffffff"},
		{"near miss", "a1b2c3d4e5f6a7b9"},
		{"uppercase", strings.ToUpper("a1b2c3d4e5f6a7b8")},
		{"surrounding space", " a1b2c3d4e5f6a7b8 "},
		{"trailing newline", "a1b2c3d4e5f6a7b8\n"},
		{"unicode lookalike", "a1b2c3d4e5f6a7\uFF18"},
		{"error text", `HTTP 404: Model is not available.`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assert.False(t, IsTrustedInternalRequest(reqWithHeader(tc.token)))
		})
	}
}

func TestIsTrustedInternalRequestHugeToken(t *testing.T) {
	dir := t.TempDir()
	ResetMachineCache()
	DataDirSource = func() string { return dir }
	t.Cleanup(func() { DataDirSource = nil; ResetMachineCache() })

	huge := strings.Repeat("a", 5_000_000)
	assert.False(t, IsTrustedInternalRequest(reqWithHeader(huge)))
}

func TestIsTrustedInternalRequestNoHeaders(t *testing.T) {
	assert.False(t, IsTrustedInternalRequest(&http.Request{Header: nil}))
	assert.False(t, IsTrustedInternalRequest(httptest.NewRequest(http.MethodGet, "/", nil)))
}

func TestIsTrustedInternalRequestFailClosedWhenSecretMissing(t *testing.T) {
	dir := t.TempDir()
	ResetMachineCache()
	DataDirSource = func() string { return dir }
	t.Cleanup(func() { DataDirSource = nil; ResetMachineCache() })

	// Derive once to create files, then corrupt the on-disk secret.
	_, err := GetConsistentMachineId(dir, CLIAuthSalt)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(dir, authDir, cliSecretFile), []byte(""), 0o600))
	assert.False(t, IsTrustedInternalRequest(reqWithHeader("a1b2c3d4e5f6a7b8")))
}

func reqWithHeader(token string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	if token != "" {
		r.Header.Set(cliTokenHeader, token)
	}
	return r
}

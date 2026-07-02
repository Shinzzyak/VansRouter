package oauth

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGeneratePKCE(t *testing.T) {
	p, err := GeneratePKCE(32)
	require.NoError(t, err)
	assert.NotEmpty(t, p.CodeVerifier)
	assert.NotEmpty(t, p.CodeChallenge)
	assert.NotEmpty(t, p.State)
	assert.Equal(t, GenerateCodeChallenge(p.CodeVerifier), p.CodeChallenge)
}

func TestGenerateCodeChallenge(t *testing.T) {
	verifier := "hello-world"
	challenge := GenerateCodeChallenge(verifier)
	assert.Equal(t, "r6J7RNQ7Aqn-pB0TztwuQBbPz4fF2_mQ5ZNmmqjOKG0", challenge)
}

func TestProvider_AuthURL(t *testing.T) {
	p := Providers["github"]
	url, err := p.BuildAuthURL("http://localhost/cb", "state-xyz", "challenge-abc")
	require.NoError(t, err)
	assert.Contains(t, url, "https://github.com/login/oauth/authorize")
	assert.Contains(t, url, "client_id=Ov23liRpx8jRDDT8v8gz")
	assert.Contains(t, url, "redirect_uri=http%3A%2F%2Flocalhost%2Fcb")
	assert.Contains(t, url, "state=state-xyz")
	assert.Contains(t, url, "code_challenge=challenge-abc")
	assert.Contains(t, url, "code_challenge_method=S256")
}

func TestProvider_AuthURL_ExtraParams(t *testing.T) {
	p := Providers["gemini"]
	url, err := p.BuildAuthURL("http://localhost/cb", "state", "challenge")
	require.NoError(t, err)
	assert.Contains(t, url, "access_type=offline")
	assert.Contains(t, url, "scope=openid+email+profile")
}

func TestGetProvider(t *testing.T) {
	p, ok := GetProvider("claude")
	assert.True(t, ok)
	assert.Equal(t, "claude", p.Name)

	_, ok = GetProvider("unknown")
	assert.False(t, ok)
}

func TestExchange_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Equal(t, "application/x-www-form-urlencoded", r.Header.Get("Content-Type"))
		body, _ := io.ReadAll(r.Body)
		assert.Contains(t, string(body), "grant_type=authorization_code")
		assert.Contains(t, string(body), "code_verifier=verifier-123")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(TokenResponse{AccessToken: "tok-123", RefreshToken: "refresh-456"})
	}))
	defer server.Close()

	p := Provider{ClientID: "client", TokenURL: server.URL}
	resp, err := Exchange(context.Background(), server.Client(), p, "code-123", "http://cb", "verifier-123")
	require.NoError(t, err)
	assert.Equal(t, "tok-123", resp.AccessToken)
	assert.Equal(t, "refresh-456", resp.RefreshToken)
}

func TestExchange_UpstreamError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"invalid_grant"}`))
	}))
	defer server.Close()

	p := Provider{ClientID: "client", TokenURL: server.URL}
	_, err := Exchange(context.Background(), server.Client(), p, "bad", "http://cb", "verifier")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "token endpoint 400")
}

func TestExchange_InvalidJSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("not json"))
	}))
	defer server.Close()

	p := Provider{ClientID: "client", TokenURL: server.URL}
	_, err := Exchange(context.Background(), server.Client(), p, "code", "http://cb", "verifier")
	require.Error(t, err)
}

func TestExchange_DefaultClient(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(TokenResponse{AccessToken: "tok"})
	}))
	defer server.Close()

	p := Provider{ClientID: "client", TokenURL: server.URL}
	resp, err := Exchange(context.Background(), nil, p, "code", "http://cb", "verifier")
	require.NoError(t, err)
	assert.Equal(t, "tok", resp.AccessToken)
}

func TestExchange_BodyContainsExpectedFields(t *testing.T) {
	var captured string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		captured = string(body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{}`))
	}))
	defer server.Close()

	p := Provider{ClientID: "client-id", TokenURL: server.URL}
	_, err := Exchange(context.Background(), server.Client(), p, "auth-code", "http://localhost/cb", "verifier-xyz")
	require.NoError(t, err)
	assert.Contains(t, captured, "client_id=client-id")
	assert.Contains(t, captured, "code=auth-code")
	assert.Contains(t, captured, "redirect_uri=http%3A%2F%2Flocalhost%2Fcb")
	assert.Contains(t, captured, "code_verifier=verifier-xyz")
}

func TestExchange_ContextCancel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// slow server; client won't actually hit it because context is canceled.
	}))
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	p := Provider{ClientID: "client", TokenURL: server.URL}
	_, err := Exchange(ctx, nil, p, "code", "http://cb", "verifier")
	require.Error(t, err)
}

func TestExchange_URLParsingError(t *testing.T) {
	// Invalid URL should fail request construction.
	p := Provider{ClientID: "client", TokenURL: "://bad-url"}
	_, err := Exchange(context.Background(), nil, p, "code", "http://cb", "verifier")
	require.Error(t, err)
	assert.True(t, strings.Contains(err.Error(), "parse") || strings.Contains(err.Error(), "build request"))
}

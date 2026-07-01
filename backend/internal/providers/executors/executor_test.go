package executors

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestExecutorDefault_SimpleOK(t *testing.T) {
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	ex := NewDefaultExecutor("openai", &ProviderConfig{BaseUrl: srv.URL})
	resp, err := ex.Execute(context.Background(), ExecuteRequest{
		Model:  "gpt-4o",
		Body:   map[string]any{"messages": []any{map[string]any{"role": "user", "content": "hi"}}},
		Stream: true,
	})
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Contains(t, string(gotBody), `"messages"`)
	assert.Equal(t, "text/event-stream", resp.Request.Header.Get("Accept"))
	_ = resp.Body.Close()
}

func TestExecutorDefault_PropagatesCancel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
			w.WriteHeader(499)
			return
		case <-time.After(500 * time.Millisecond):
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer srv.Close()

	ex := NewDefaultExecutor("openai", &ProviderConfig{BaseUrl: srv.URL})
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()

	_, err := ex.Execute(ctx, ExecuteRequest{Model: "gpt-4o", Body: map[string]any{}})
	require.Error(t, err)
	assert.True(t, err == context.Canceled || err.Error() == "context canceled", "got %v", err)
}

func TestExecutorDefault_Retry429ThenFallback(t *testing.T) {
	var first atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if first.CompareAndSwap(false, true) {
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	cfg := &ProviderConfig{
		BaseUrls: []string{srv.URL + "/first", srv.URL + "/second"},
		Retry: RetryConfig{
			http.StatusTooManyRequests: {Attempts: 0, DelayMs: 0},
		},
	}
	ex := NewDefaultExecutor("openai", cfg)
	resp, err := ex.Execute(context.Background(), ExecuteRequest{Model: "gpt-4o", Body: map[string]any{}})
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	_ = resp.Body.Close()
}

func TestExecutorDefault_ConnectTimeout(t *testing.T) {
	// Listener that accepts but never responds.
	ex := NewDefaultExecutor("openai", &ProviderConfig{
		BaseUrl:   "http://127.0.0.1:1",
		TimeoutMs: 50,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err := ex.Execute(ctx, ExecuteRequest{Model: "gpt-4o", Body: map[string]any{}})
	require.Error(t, err)
}

func TestExecutorDefault_AuthBearer(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	ex := NewDefaultExecutor("openai", &ProviderConfig{BaseUrl: srv.URL})
	resp, err := ex.Execute(context.Background(), ExecuteRequest{
		Model: "gpt-4o",
		Body:  map[string]any{},
		Credentials: Credentials{
			APIKey: "sk-xxx",
		},
	})
	require.NoError(t, err)
	assert.Equal(t, "Bearer sk-xxx", got)
	_ = resp.Body.Close()
}

func TestExecutorDefault_AnthropicCompatibleXApiKey(t *testing.T) {
	var gotXAPI string
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotXAPI = r.Header.Get("x-api-key")
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	ex := NewDefaultExecutor("anthropic-compatible-test", &ProviderConfig{})
	resp, err := ex.Execute(context.Background(), ExecuteRequest{
		Model: "claude-3-5",
		Body:  map[string]any{},
		Credentials: Credentials{
			APIKey: "ak-xxx",
			ProviderSpecificData: map[string]any{"baseUrl": srv.URL},
		},
	})
	require.NoError(t, err)
	assert.Equal(t, "ak-xxx", gotXAPI)
	assert.Empty(t, gotAuth)
	assert.Equal(t, "2023-06-01", resp.Request.Header.Get("anthropic-version"))
	_ = resp.Body.Close()
}

func TestExecutorDefault_RuntimeTransportOverride(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	ex := NewDefaultExecutor("openai", &ProviderConfig{BaseUrl: "http://ignored"})
	resp, err := ex.Execute(context.Background(), ExecuteRequest{
		Model: "gpt-4o",
		Body:  map[string]any{},
		Credentials: Credentials{
			RuntimeTransport: &RuntimeTransport{
				BaseURL:   srv.URL,
				URLSuffix: "/custom/path",
				Headers:   map[string]string{"X-Custom": "yes"},
			},
		},
	})
	require.NoError(t, err)
	assert.Equal(t, "/custom/path", gotPath)
	assert.Equal(t, "yes", resp.Request.Header.Get("X-Custom"))
	_ = resp.Body.Close()
}

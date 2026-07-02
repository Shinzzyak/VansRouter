package middleware

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func testLogger(buf *bytes.Buffer) *slog.Logger {
	return slog.New(slog.NewJSONHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
}

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("hello"))
	})
}

func TestRealIPFromXForwardedFor(t *testing.T) {
	var seen string
	h := RealIP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.RemoteAddr
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "127.0.0.1:1234"
	req.Header.Set("X-Forwarded-For", "203.0.113.5, 10.0.0.1")
	h.ServeHTTP(httptest.NewRecorder(), req)
	assert.Equal(t, "203.0.113.5", seen)
}

func TestRealIPFromXRealIP(t *testing.T) {
	var seen string
	h := RealIP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.RemoteAddr
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "127.0.0.1:1234"
	req.Header.Set("X-Real-IP", "198.51.100.7")
	h.ServeHTTP(httptest.NewRecorder(), req)
	assert.Equal(t, "198.51.100.7", seen)
}

func TestRealIPFallback(t *testing.T) {
	var seen string
	h := RealIP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.RemoteAddr
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "127.0.0.1:9999"
	h.ServeHTTP(httptest.NewRecorder(), req)
	assert.Equal(t, "127.0.0.1:9999", seen)
}

func TestCORSPreflight(t *testing.T) {
	h := NewCORS("").Wrap(okHandler())
	req := httptest.NewRequest(http.MethodOptions, "/v1/chat/completions", nil)
	req.Header.Set("Origin", "https://example.com")
	req.Header.Set("Access-Control-Request-Method", "POST")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, "*", rec.Header().Get("Access-Control-Allow-Origin"))
	assert.Equal(t, "GET, POST, PUT, DELETE, OPTIONS, PATCH", rec.Header().Get("Access-Control-Allow-Methods"))
	assert.NotEmpty(t, rec.Header().Get("Access-Control-Allow-Headers"))
	assert.Equal(t, "86400", rec.Header().Get("Access-Control-Max-Age"))
}

func TestCORSAddsHeadersToResponse(t *testing.T) {
	h := NewCORS("").Wrap(okHandler())
	req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	req.Header.Set("Origin", "https://example.com")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "*", rec.Header().Get("Access-Control-Allow-Origin"))
	body, _ := io.ReadAll(rec.Body)
	assert.Equal(t, "hello", string(body))
}

func TestCORSCustomOrigin(t *testing.T) {
	h := NewCORS("https://app.example.com").Wrap(okHandler())
	req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	assert.Equal(t, "https://app.example.com", rec.Header().Get("Access-Control-Allow-Origin"))
}

func TestRequestLogger(t *testing.T) {
	var buf bytes.Buffer
	logger := testLogger(&buf)
	h := RequestLogger(logger)(okHandler())
	req := httptest.NewRequest(http.MethodGet, "/v1/models?foo=bar", nil)
	req.RemoteAddr = "10.0.0.1:4242"
	req.Header.Set("User-Agent", "test-client/1.0")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	var entry map[string]any
	require.NoError(t, json.Unmarshal(buf.Bytes(), &entry))
	assert.Equal(t, "http_request", entry["msg"])
	assert.Equal(t, "GET", entry["method"])
	assert.Equal(t, "/v1/models", entry["path"])
	assert.Equal(t, "foo=bar", entry["query"])
	assert.Equal(t, float64(200), entry["status"])
	assert.Equal(t, "10.0.0.1:4242", entry["ip"])
	assert.Equal(t, "test-client/1.0", entry["ua"])
}

func TestRequestLoggerRecords4xxStatus(t *testing.T) {
	var buf bytes.Buffer
	logger := testLogger(&buf)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusNotFound)
	})
	h := RequestLogger(logger)(handler)
	req := httptest.NewRequest(http.MethodGet, "/missing", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	var entry map[string]any
	require.NoError(t, json.Unmarshal(buf.Bytes(), &entry))
	assert.Equal(t, float64(404), entry["status"])
}

func TestRecovery(t *testing.T) {
	var buf bytes.Buffer
	logger := testLogger(&buf)
	panicHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("boom")
	})
	h := Recovery(logger)(panicHandler)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	require.NotPanics(t, func() { h.ServeHTTP(rec, req) })
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Contains(t, rec.Body.String(), "internal server error")
	assert.True(t, strings.Contains(buf.String(), "panic_recovered"), "expected panic log entry, got %s", buf.String())
}

func TestRecoveryPassesThrough(t *testing.T) {
	var buf bytes.Buffer
	logger := testLogger(&buf)
	h := Recovery(logger)(okHandler())
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Empty(t, buf.String())
}

func TestMiddlewareChainOrder(t *testing.T) {
	var buf bytes.Buffer
	logger := testLogger(&buf)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("seen=" + r.RemoteAddr))
	})
	chain := RealIP(Recovery(logger)(RequestLogger(logger)(handler)))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "127.0.0.1:1111"
	req.Header.Set("X-Forwarded-For", "198.51.100.99")
	rec := httptest.NewRecorder()
	chain.ServeHTTP(rec, req)

	body, _ := io.ReadAll(rec.Body)
	assert.Equal(t, "seen=198.51.100.99", string(body))

	// request logger should have logged with the resolved IP.
	var entry map[string]any
	require.NoError(t, json.Unmarshal(buf.Bytes(), &entry))
	assert.Equal(t, "198.51.100.99", entry["ip"])
}

func TestClientIPHelper(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "127.0.0.1:1"
	req.Header.Set("X-Forwarded-For", "1.2.3.4, 5.6.7.8")
	assert.Equal(t, "1.2.3.4", ClientIP(req))
}

var _ = context.Background // keep import used if we add context-aware tests later

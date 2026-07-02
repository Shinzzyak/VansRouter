package v1

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

type fakeFetchExecutor struct {
	calls int
	last  FetchRequest
	resp  *http.Response
	err   error
}

func (e *fakeFetchExecutor) Fetch(ctx context.Context, req FetchRequest) (*http.Response, error) {
	e.calls++
	e.last = req
	if e.err != nil {
		return nil, e.err
	}
	return e.resp, nil
}

func TestWebFetchHandler_Success(t *testing.T) {
	exec := &fakeFetchExecutor{
		resp: &http.Response{
			StatusCode: 200,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(`{"provider":"jina","url":"https://example.com"}`)),
		},
	}
	h := &FetchHandler{Executor: exec}
	req := httptest.NewRequest(http.MethodPost, "/v1/fetch", strings.NewReader(`{"url":"https://example.com","provider":"jina"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, 1, exec.calls)
	assert.Equal(t, "https://example.com", exec.last.URL)
	assert.Equal(t, "jina", exec.last.Provider)
}

func TestWebFetchHandler_MissingURL(t *testing.T) {
	h := &FetchHandler{}
	req := httptest.NewRequest(http.MethodPost, "/v1/fetch", strings.NewReader(`{"provider":"jina"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "Missing required field: url")
}

func TestWebFetchHandler_NoExecutorFallback(t *testing.T) {
	h := &FetchHandler{}
	req := httptest.NewRequest(http.MethodPost, "/v1/fetch", strings.NewReader(`{"url":"https://example.com"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	var payload map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, "jina-reader", payload["provider"])
	assert.Equal(t, "https://example.com", payload["url"])
}

func TestWebFetchHandler_ExecutorError(t *testing.T) {
	exec := &fakeFetchExecutor{err: assert.AnError}
	h := &FetchHandler{Executor: exec}
	req := httptest.NewRequest(http.MethodPost, "/v1/fetch", strings.NewReader(`{"url":"https://x.com"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusBadGateway, rec.Code)
}

func TestWebFetchHandler_WrongMethod(t *testing.T) {
	h := &FetchHandler{}
	req := httptest.NewRequest(http.MethodGet, "/v1/fetch", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusMethodNotAllowed, rec.Code)
}

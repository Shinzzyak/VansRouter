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

type fakeSearchExecutor struct {
	calls int
	last  SearchRequest
	resp  *http.Response
	err   error
}

func (e *fakeSearchExecutor) Search(ctx context.Context, req SearchRequest) (*http.Response, error) {
	e.calls++
	e.last = req
	if e.err != nil {
		return nil, e.err
	}
	return e.resp, nil
}

func TestSearchHandler_Success(t *testing.T) {
	exec := &fakeSearchExecutor{
		resp: &http.Response{
			StatusCode: 200,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(`{"provider":"tavily","results":[]}`)),
		},
	}
	h := &SearchHandler{Executor: exec}
	req := httptest.NewRequest(http.MethodPost, "/v1/search", strings.NewReader(`{"query":"golang","provider":"tavily"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, 1, exec.calls)
	assert.Equal(t, "golang", exec.last.Query)
	assert.Equal(t, "tavily", exec.last.Provider)
}

func TestSearchHandler_MissingQuery(t *testing.T) {
	h := &SearchHandler{}
	req := httptest.NewRequest(http.MethodPost, "/v1/search", strings.NewReader(`{"provider":"tavily"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "Missing required field: query")
}

func TestSearchHandler_NoExecutorFallback(t *testing.T) {
	h := &SearchHandler{}
	req := httptest.NewRequest(http.MethodPost, "/v1/search", strings.NewReader(`{"query":"golang"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	var payload map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, "tavily", payload["provider"])
	assert.NotNil(t, payload["results"])
}

func TestSearchHandler_ExecutorError(t *testing.T) {
	exec := &fakeSearchExecutor{err: assert.AnError}
	h := &SearchHandler{Executor: exec}
	req := httptest.NewRequest(http.MethodPost, "/v1/search", strings.NewReader(`{"query":"x"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusBadGateway, rec.Code)
}

func TestSearchHandler_WrongMethod(t *testing.T) {
	h := &SearchHandler{}
	req := httptest.NewRequest(http.MethodGet, "/v1/search", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusMethodNotAllowed, rec.Code)
}

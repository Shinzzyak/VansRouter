package v1

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeResponsesExecutor struct {
	calls int
	last  map[string]any
	resp  *http.Response
	err   error
}

func (e *fakeResponsesExecutor) Complete(ctx context.Context, body map[string]any) (*http.Response, error) {
	e.calls++
	e.last = body
	if e.err != nil {
		return nil, e.err
	}
	return e.resp, nil
}

func TestResponsesHandler_Success(t *testing.T) {
	exec := &fakeResponsesExecutor{
		resp: &http.Response{
			StatusCode: 200,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(`{"id":"resp-1"}`)),
		},
	}
	h := &ResponsesHandler{Executor: exec}
	req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"gpt-4o","input":"hello"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, 1, exec.calls)
	assert.Equal(t, "gpt-4o", exec.last["model"])
}

func TestResponsesHandler_MissingModel(t *testing.T) {
	h := &ResponsesHandler{}
	req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"input":"hello"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "Missing required field: model")
}

func TestResponsesHandler_NoExecutor(t *testing.T) {
	h := &ResponsesHandler{}
	req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"gpt-4o","input":"hello"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
}

func TestResponsesHandler_ExecutorError(t *testing.T) {
	exec := &fakeResponsesExecutor{err: assert.AnError}
	h := &ResponsesHandler{Executor: exec}
	req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"gpt-4o","input":"hello"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusBadGateway, rec.Code)
}

func TestResponsesHandler_WrongMethod(t *testing.T) {
	h := &ResponsesHandler{}
	req := httptest.NewRequest(http.MethodGet, "/v1/responses", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusMethodNotAllowed, rec.Code)
}

func TestResponsesHandler_ConvertsToChatBody(t *testing.T) {
	exec := &fakeResponsesExecutor{
		resp: &http.Response{
			StatusCode: 200,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(`{}`)),
		},
	}
	h := &ResponsesHandler{Executor: exec}
	req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"gpt-4o","input":"hello","stream":true}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, 1, exec.calls)
	assert.Equal(t, true, exec.last["stream"])
	assert.NotNil(t, exec.last["messages"])
}

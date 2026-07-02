package sse

import (
	"bytes"
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

type fakeTtsExecutor struct {
	calls int
	last  TtsRequest
	resp  *http.Response
	err   error
}

func (e *fakeTtsExecutor) Synthesize(ctx context.Context, req TtsRequest) (*http.Response, error) {
	e.calls++
	e.last = req
	if e.err != nil {
		return nil, e.err
	}
	return e.resp, nil
}

func TestTtsHandler_Success(t *testing.T) {
	exec := &fakeTtsExecutor{
		resp: &http.Response{
			StatusCode: 200,
			Header:     http.Header{"Content-Type": []string{"audio/mpeg"}},
			Body:       io.NopCloser(bytes.NewReader([]byte("mp3-bytes"))),
		},
	}
	h := &TtsHandler{Executor: exec}
	req := httptest.NewRequest(http.MethodPost, "/v1/audio/speech", strings.NewReader(`{"input":"hello","voice":"alloy"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "audio/mpeg", rec.Header().Get("Content-Type"))
	require.Equal(t, 1, exec.calls)
	assert.Equal(t, "hello", exec.last.Input)
	assert.Equal(t, "alloy", exec.last.Voice)
}

func TestTtsHandler_MissingInput(t *testing.T) {
	h := &TtsHandler{}
	req := httptest.NewRequest(http.MethodPost, "/v1/audio/speech", strings.NewReader(`{"voice":"alloy"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "Missing required field: input")
}

func TestTtsHandler_NoExecutorFallback(t *testing.T) {
	h := &TtsHandler{}
	req := httptest.NewRequest(http.MethodPost, "/v1/audio/speech", strings.NewReader(`{"input":"hello","response_format":"mp3"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	var payload map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, "mp3", payload["format"])
	assert.NotEmpty(t, payload["audio"])
}

func TestTtsHandler_ExecutorError(t *testing.T) {
	exec := &fakeTtsExecutor{err: assert.AnError}
	h := &TtsHandler{Executor: exec}
	req := httptest.NewRequest(http.MethodPost, "/v1/audio/speech", strings.NewReader(`{"input":"hello"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusBadGateway, rec.Code)
}

func TestTtsHandler_WrongMethod(t *testing.T) {
	h := &TtsHandler{}
	req := httptest.NewRequest(http.MethodGet, "/v1/audio/speech", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusMethodNotAllowed, rec.Code)
}

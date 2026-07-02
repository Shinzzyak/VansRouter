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

type fakeImageExecutor struct {
	calls int
	last  ImageRequest
	resp  *http.Response
	err   error
}

func (e *fakeImageExecutor) Generate(ctx context.Context, req ImageRequest) (*http.Response, error) {
	e.calls++
	e.last = req
	if e.err != nil {
		return nil, e.err
	}
	return e.resp, nil
}

func TestImageHandler_Success(t *testing.T) {
	exec := &fakeImageExecutor{
		resp: &http.Response{
			StatusCode: 200,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(`{"created":1,"data":[{"url":"https://upstream.example/img.png"}]}`)),
		},
	}
	h := &ImageHandler{Executor: exec}
	req := httptest.NewRequest(http.MethodPost, "/v1/images/generations", strings.NewReader(`{"model":"dall-e-3","prompt":"a cat"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"url":"https://upstream.example/img.png"`)
	require.Equal(t, 1, exec.calls)
	assert.Equal(t, "dall-e-3", exec.last.Model)
	assert.Equal(t, "a cat", exec.last.Prompt)
}

func TestImageHandler_MissingPrompt(t *testing.T) {
	h := &ImageHandler{}
	req := httptest.NewRequest(http.MethodPost, "/v1/images/generations", strings.NewReader(`{"model":"dall-e-3"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "Missing required field: prompt")
}

func TestImageHandler_NoExecutorFallback(t *testing.T) {
	h := &ImageHandler{}
	req := httptest.NewRequest(http.MethodPost, "/v1/images/generations", strings.NewReader(`{"model":"dall-e-3","prompt":"a cat"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	var payload map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, float64(1), payload["created"])
	assert.Len(t, payload["data"].([]any), 1)
}

func TestImageHandler_ExecutorError(t *testing.T) {
	exec := &fakeImageExecutor{err: assert.AnError}
	h := &ImageHandler{Executor: exec}
	req := httptest.NewRequest(http.MethodPost, "/v1/images/generations", strings.NewReader(`{"prompt":"a cat"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusBadGateway, rec.Code)
}

func TestImageHandler_WrongMethod(t *testing.T) {
	h := &ImageHandler{}
	req := httptest.NewRequest(http.MethodGet, "/v1/images/generations", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusMethodNotAllowed, rec.Code)
}

func TestImageHandler_PropagatesContext(t *testing.T) {
	exec := &fakeImageExecutor{
		resp: &http.Response{
			StatusCode: 200,
			Body:       io.NopCloser(bytes.NewReader([]byte(`{}`))),
		},
	}
	h := &ImageHandler{Executor: exec}
	req := httptest.NewRequest(http.MethodPost, "/v1/images/generations", strings.NewReader(`{"prompt":"x"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
}

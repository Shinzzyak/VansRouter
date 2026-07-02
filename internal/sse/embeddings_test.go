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

type fakeEmbeddingsExecutor struct {
	calls int
	last  EmbeddingsRequest
	resp  *http.Response
	err   error
}

func (e *fakeEmbeddingsExecutor) Embed(ctx context.Context, req EmbeddingsRequest) (*http.Response, error) {
	e.calls++
	e.last = req
	if e.err != nil {
		return nil, e.err
	}
	return e.resp, nil
}

func TestEmbeddingsHandler_Success(t *testing.T) {
	exec := &fakeEmbeddingsExecutor{
		resp: &http.Response{
			StatusCode: 200,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(`{"object":"list","data":[{"embedding":[0.1]}]}`)),
		},
	}
	h := &EmbeddingsHandler{Executor: exec}
	req := httptest.NewRequest(http.MethodPost, "/v1/embeddings", strings.NewReader(`{"model":"text-embedding-3-small","input":"hello"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"object":"list"`)
	require.Equal(t, 1, exec.calls)
	assert.Equal(t, "text-embedding-3-small", exec.last.Model)
	assert.Equal(t, "hello", exec.last.Input)
}

func TestEmbeddingsHandler_MissingModel(t *testing.T) {
	h := &EmbeddingsHandler{}
	req := httptest.NewRequest(http.MethodPost, "/v1/embeddings", strings.NewReader(`{"input":"hello"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "Missing required field: model")
}

func TestEmbeddingsHandler_MissingInput(t *testing.T) {
	h := &EmbeddingsHandler{}
	req := httptest.NewRequest(http.MethodPost, "/v1/embeddings", strings.NewReader(`{"model":"x"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "Missing required field: input")
}

func TestEmbeddingsHandler_InvalidInputType(t *testing.T) {
	h := &EmbeddingsHandler{}
	req := httptest.NewRequest(http.MethodPost, "/v1/embeddings", strings.NewReader(`{"model":"x","input":42}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "input must be a string or array of strings")
}

func TestEmbeddingsHandler_ArrayInput(t *testing.T) {
	exec := &fakeEmbeddingsExecutor{
		resp: &http.Response{
			StatusCode: 200,
			Body:       io.NopCloser(strings.NewReader(`{"object":"list"}`)),
		},
	}
	h := &EmbeddingsHandler{Executor: exec}
	req := httptest.NewRequest(http.MethodPost, "/v1/embeddings", strings.NewReader(`{"model":"x","input":["a","b"]}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, 1, exec.calls)
	assert.Equal(t, []any{"a", "b"}, exec.last.Input)
}

func TestEmbeddingsHandler_ExecutorError(t *testing.T) {
	exec := &fakeEmbeddingsExecutor{err: assert.AnError}
	h := &EmbeddingsHandler{Executor: exec}
	req := httptest.NewRequest(http.MethodPost, "/v1/embeddings", strings.NewReader(`{"model":"x","input":"hi"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusBadGateway, rec.Code)
}

func TestEmbeddingsHandler_NoExecutor(t *testing.T) {
	h := &EmbeddingsHandler{}
	req := httptest.NewRequest(http.MethodPost, "/v1/embeddings", strings.NewReader(`{"model":"x","input":"hi"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
}

func TestEmbeddingsHandler_WrongMethod(t *testing.T) {
	h := &EmbeddingsHandler{}
	req := httptest.NewRequest(http.MethodGet, "/v1/embeddings", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusMethodNotAllowed, rec.Code)
}

func TestEmbeddingsHandler_PropagatesContext(t *testing.T) {
	exec := &fakeEmbeddingsExecutor{
		resp: &http.Response{
			StatusCode: 200,
			Body:       io.NopCloser(bytes.NewReader([]byte(`{}`))),
		},
	}
	h := &EmbeddingsHandler{Executor: exec}
	req := httptest.NewRequest(http.MethodPost, "/v1/embeddings", strings.NewReader(`{"model":"x","input":"hi"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestEmbeddingsHandler_ErrorBodyFormat(t *testing.T) {
	exec := &fakeEmbeddingsExecutor{
		resp: &http.Response{
			StatusCode: 400,
			Body:       io.NopCloser(strings.NewReader(`{"error":{"message":"bad model"}}`)),
		},
	}
	h := &EmbeddingsHandler{Executor: exec}
	req := httptest.NewRequest(http.MethodPost, "/v1/embeddings", strings.NewReader(`{"model":"x","input":"hi"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	var payload map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, "bad model", payload["error"].(map[string]any)["message"])
}

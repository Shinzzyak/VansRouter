package sse

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeSttExecutor struct {
	calls int
	last  SttRequest
	resp  *http.Response
	err   error
}

func (e *fakeSttExecutor) Transcribe(ctx context.Context, req SttRequest) (*http.Response, error) {
	e.calls++
	e.last = req
	if e.err != nil {
		return nil, e.err
	}
	return e.resp, nil
}

func buildSttForm(t *testing.T, fileContent string, model string, extra map[string]string) (io.Reader, string) {
	var b bytes.Buffer
	w := multipart.NewWriter(&b)
	fw, err := w.CreateFormFile("file", "audio.mp3")
	require.NoError(t, err)
	_, err = io.Copy(fw, strings.NewReader(fileContent))
	require.NoError(t, err)
	if model != "" {
		require.NoError(t, w.WriteField("model", model))
	}
	for k, v := range extra {
		require.NoError(t, w.WriteField(k, v))
	}
	require.NoError(t, w.Close())
	return &b, w.FormDataContentType()
}

func TestSttHandler_Success(t *testing.T) {
	exec := &fakeSttExecutor{
		resp: &http.Response{
			StatusCode: 200,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(`{"text":"hello world"}`)),
		},
	}
	h := &SttHandler{Executor: exec}
	body, ct := buildSttForm(t, "fake-audio", "whisper-1", map[string]string{"language": "en"})
	req := httptest.NewRequest(http.MethodPost, "/v1/audio/transcriptions", body)
	req.Header.Set("Content-Type", ct)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"text":"hello world"`)
	require.Equal(t, 1, exec.calls)
	assert.Equal(t, "whisper-1", exec.last.Model)
	assert.Equal(t, "en", exec.last.Language)
}

func TestSttHandler_MissingFile(t *testing.T) {
	h := &SttHandler{}
	var b bytes.Buffer
	w := multipart.NewWriter(&b)
	require.NoError(t, w.WriteField("model", "whisper-1"))
	require.NoError(t, w.Close())
	req := httptest.NewRequest(http.MethodPost, "/v1/audio/transcriptions", &b)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "Missing required field: file")
}

func TestSttHandler_MissingModel(t *testing.T) {
	h := &SttHandler{}
	body, ct := buildSttForm(t, "fake-audio", "", nil)
	req := httptest.NewRequest(http.MethodPost, "/v1/audio/transcriptions", body)
	req.Header.Set("Content-Type", ct)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "Missing required field: model")
}

func TestSttHandler_NoExecutorFallback(t *testing.T) {
	h := &SttHandler{}
	body, ct := buildSttForm(t, "fake-audio", "whisper-1", nil)
	req := httptest.NewRequest(http.MethodPost, "/v1/audio/transcriptions", body)
	req.Header.Set("Content-Type", ct)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	var payload map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, "placeholder transcript", payload["text"])
}

func TestSttHandler_ExecutorError(t *testing.T) {
	exec := &fakeSttExecutor{err: assert.AnError}
	h := &SttHandler{Executor: exec}
	body, ct := buildSttForm(t, "fake-audio", "whisper-1", nil)
	req := httptest.NewRequest(http.MethodPost, "/v1/audio/transcriptions", body)
	req.Header.Set("Content-Type", ct)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusBadGateway, rec.Code)
}

func TestSttHandler_WrongMethod(t *testing.T) {
	h := &SttHandler{}
	req := httptest.NewRequest(http.MethodGet, "/v1/audio/transcriptions", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusMethodNotAllowed, rec.Code)
}

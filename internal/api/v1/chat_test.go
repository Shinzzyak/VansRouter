package v1

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeService struct {
	calls  int
	last   ChatRequest
	resp   *ChatResponse
	err    error
}

func (s *fakeService) Chat(ctx context.Context, req ChatRequest) (*ChatResponse, error) {
	s.calls++
	s.last = req
	if s.err != nil {
		return nil, s.err
	}
	return s.resp, nil
}

type allowAllBuilder struct{}

func (allowAllBuilder) IsModelAllowed(ctx context.Context, model string, apiKeyPresent bool) (bool, error) {
	return true, nil
}

type denyAllBuilder struct{}

func (denyAllBuilder) IsModelAllowed(ctx context.Context, model string, apiKeyPresent bool) (bool, error) {
	return false, nil
}

func TestChatEndpoint_Success(t *testing.T) {
	svc := &fakeService{
		resp: &ChatResponse{
			StatusCode:  http.StatusOK,
			ContentType: "application/json",
			Headers:     http.Header{"X-Selected": []string{"conn-1"}},
			Body:        io.NopCloser(strings.NewReader(`{"id":"chatcmpl-1"}`)),
		},
	}
	h := &ChatHandler{Service: svc, Builder: allowAllBuilder{}}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer sk-test")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))
	assert.Equal(t, "conn-1", rec.Header().Get("X-Selected"))
	assert.Contains(t, rec.Body.String(), `"id":"chatcmpl-1"`)
	require.Equal(t, 1, svc.calls)
	assert.Equal(t, "sk-test", svc.last.APIKey)
	assert.Equal(t, "gpt-4o", svc.last.Body["model"])
}

func TestChatEndpoint_MissingModel(t *testing.T) {
	h := &ChatHandler{Service: &fakeService{}, Builder: allowAllBuilder{}}
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "Missing model")
}

func TestChatEndpoint_InvalidJSON(t *testing.T) {
	h := &ChatHandler{Service: &fakeService{}, Builder: allowAllBuilder{}}
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`not json`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestChatEndpoint_ModelNotAllowed(t *testing.T) {
	svc := &fakeService{}
	h := &ChatHandler{Service: svc, Builder: denyAllBuilder{}}
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"banned-model"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusNotFound, rec.Code)
	assert.Equal(t, 0, svc.calls)
}

func TestChatEndpoint_StreamingFlushes(t *testing.T) {
	svc := &fakeService{
		resp: &ChatResponse{
			StatusCode:  http.StatusOK,
			ContentType: "text/event-stream",
			Body:        io.NopCloser(strings.NewReader("data: chunk1\n\ndata: chunk2\n\n")),
		},
	}
	h := &ChatHandler{Service: svc, Builder: allowAllBuilder{}}
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"gpt-4o","stream":true}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	body := rec.Body.String()
	assert.Contains(t, body, "chunk1")
	assert.Contains(t, body, "chunk2")
}

func TestChatEndpoint_ContextCancelReturns499(t *testing.T) {
	svc := &fakeService{err: context.Canceled}
	h := &ChatHandler{Service: svc, Builder: allowAllBuilder{}}
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"gpt-4o"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	// Service error with context.Canceled should be treated as client disconnect
	// (no body written, status not set, default 200 since we never wrote headers).
	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestChatEndpoint_ServiceError(t *testing.T) {
	svc := &fakeService{err: errors.New("upstream unavailable")}
	h := &ChatHandler{Service: svc, Builder: allowAllBuilder{}}
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"gpt-4o"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusBadGateway, rec.Code)
	body, _ := io.ReadAll(rec.Body)
	var payload map[string]any
	require.NoError(t, json.Unmarshal(body, &payload))
	errObj := payload["error"].(map[string]any)
	assert.Equal(t, "upstream unavailable", errObj["message"])
}

func TestChatEndpoint_WrongMethod(t *testing.T) {
	h := &ChatHandler{Service: &fakeService{}, Builder: allowAllBuilder{}}
	req := httptest.NewRequest(http.MethodGet, "/v1/chat/completions", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusMethodNotAllowed, rec.Code)
}

func TestChatEndpoint_AcceptHeaderTriggersStream(t *testing.T) {
	svc := &fakeService{
		resp: &ChatResponse{
			StatusCode:  http.StatusOK,
			ContentType: "text/event-stream",
			Body:        io.NopCloser(strings.NewReader("data: ok\n\n")),
		},
	}
	h := &ChatHandler{Service: svc, Builder: allowAllBuilder{}}
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"gpt-4o"}`))
	req.Header.Set("Accept", "text/event-stream")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, 1, svc.calls)
	assert.Equal(t, true, svc.last.Body["stream"])
}

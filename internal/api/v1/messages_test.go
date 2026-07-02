package v1

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMessagesHandler_StringContent(t *testing.T) {
	h := &MessagesHandler{}
	body := `{"messages":[{"role":"user","content":"hello world"}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/messages/count_tokens", strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	var payload map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, float64(3), payload["input_tokens"]) // ceil(11/4)
}

func TestMessagesHandler_ArrayContent(t *testing.T) {
	h := &MessagesHandler{}
	body := `{"messages":[{"role":"user","content":[{"type":"text","text":"abc"}]}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/messages/count_tokens", strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	var payload map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, float64(1), payload["input_tokens"]) // ceil(3/4)
}

func TestMessagesHandler_EmptyMessages(t *testing.T) {
	h := &MessagesHandler{}
	body := `{}`
	req := httptest.NewRequest(http.MethodPost, "/v1/messages/count_tokens", strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	var payload map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, float64(0), payload["input_tokens"])
}

func TestMessagesHandler_InvalidJSON(t *testing.T) {
	h := &MessagesHandler{}
	req := httptest.NewRequest(http.MethodPost, "/v1/messages/count_tokens", strings.NewReader(`not json`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestMessagesHandler_WrongMethod(t *testing.T) {
	h := &MessagesHandler{}
	req := httptest.NewRequest(http.MethodGet, "/v1/messages/count_tokens", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusMethodNotAllowed, rec.Code)
}

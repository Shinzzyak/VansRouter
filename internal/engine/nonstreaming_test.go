package engine

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/9router/9router/internal/sse"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNonStreaming_Passthrough(t *testing.T) {
	upstream := strings.NewReader(`{"id":"chatcmpl-1","choices":[{"message":{"role":"assistant","content":"hi"}}]}`)
	rec := httptest.NewRecorder()
	ctrl := sse.NewStreamController(context.Background())
	h := NewNonStreamingHandler(rec, ctrl)

	err := h.Handle(upstream, nil)
	require.NoError(t, err)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))
	assert.Contains(t, rec.Body.String(), `"id":"chatcmpl-1"`)
	assert.Contains(t, rec.Body.String(), `"content":"hi"`)
}

func TestNonStreaming_Translate(t *testing.T) {
	upstream := strings.NewReader(`{"raw":"value"}`)
	rec := httptest.NewRecorder()
	ctrl := sse.NewStreamController(context.Background())
	h := NewNonStreamingHandler(rec, ctrl)

	err := h.Handle(upstream, func(b []byte) ([]byte, error) {
		return []byte(`{"translated":true}`), nil
	})
	require.NoError(t, err)

	assert.Contains(t, rec.Body.String(), `"translated":true`)
	assert.NotContains(t, rec.Body.String(), `"raw"`)
}

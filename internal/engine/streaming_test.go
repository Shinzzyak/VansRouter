package engine

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/9router/9router/internal/sse"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestStreaming_PassthroughAndDone(t *testing.T) {
	upstream := strings.NewReader("data: {\"id\":\"1\"}\n\ndata: {\"id\":\"2\"}\n\n")
	rec := httptest.NewRecorder()
	ctrl := sse.NewStreamController(context.Background())

	h := NewStreamingHandler(rec, ctrl)
	err := h.Stream(upstream)
	require.NoError(t, err)

	body := rec.Body.String()
	assert.Contains(t, body, "data: {\"id\":\"1\"}\n\n")
	assert.Contains(t, body, "data: {\"id\":\"2\"}\n\n")
	assert.Contains(t, body, "data: [DONE]\n\n")
	assert.True(t, strings.HasSuffix(body, "data: [DONE]\n\n"), "response must end with [DONE] terminator")
	assert.Equal(t, "text/event-stream", rec.Header().Get("Content-Type"))
	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestStreaming_FlushesPerWrite(t *testing.T) {
	upstream := strings.NewReader("data: {\"id\":\"1\"}\n\ndata: {\"id\":\"2\"}\n\n")
	rec := httptest.NewRecorder()
	ctrl := sse.NewStreamController(context.Background())

	h := NewStreamingHandler(rec, ctrl)
	err := h.Stream(upstream)
	require.NoError(t, err)

	assert.GreaterOrEqual(t, h.w.FlushCount(), 1, "streaming must flush at least once")
}

func TestStreaming_WriteEventAndDone(t *testing.T) {
	rec := httptest.NewRecorder()
	w := NewSSEWriter(rec)
	w.WriteHeaders()

	err := w.WriteEvent(map[string]any{"id": "1"})
	require.NoError(t, err)
	err = w.WriteEvent(map[string]any{"id": "2"})
	require.NoError(t, err)
	err = w.WriteDone()
	require.NoError(t, err)

	body := rec.Body.String()
	assert.Contains(t, body, "data: {\"id\":\"1\"}\n\n")
	assert.Contains(t, body, "data: {\"id\":\"2\"}\n\n")
	assert.True(t, strings.HasSuffix(body, "data: [DONE]\n\n"))
	assert.GreaterOrEqual(t, w.FlushCount(), 3)
}

func TestStreaming_CancelDoesNotEmitDone(t *testing.T) {
	pr, pw := io.Pipe()
	rec := httptest.NewRecorder()
	ctx, cancel := context.WithCancel(context.Background())
	ctrl := sse.NewStreamController(ctx)

	h := NewStreamingHandler(rec, ctrl)

	done := make(chan struct{})
	var streamErr error
	go func() {
		streamErr = h.Stream(pr)
		close(done)
	}()

	go func() {
		time.Sleep(30 * time.Millisecond)
		cancel()
		_ = pw.Close()
	}()

	select {
	case <-done:
		body := rec.Body.String()
		assert.NotContains(t, body, "[DONE]", "cancelled stream must not emit [DONE] terminator")
		assert.NoError(t, streamErr)
	case <-time.After(2 * time.Second):
		t.Fatal("Stream did not abort after context cancellation")
	}
}

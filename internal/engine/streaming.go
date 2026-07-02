package engine

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/9router/9router/internal/sse"
)

// SSEWriter wraps http.ResponseWriter and explicitly uses http.Flusher to push
// every SSE event to the client. It implements io.Writer so it can be used as
// the destination for sse.PipeUpstream.
type SSEWriter struct {
	w       http.ResponseWriter
	flusher http.Flusher
	flushed int
	done    bool
}

// NewSSEWriter requires that w implements http.Flusher. In this service all
// streaming paths run over connections that support flushing; panicking on a
// non-flusher surface is a programming error.
func NewSSEWriter(w http.ResponseWriter) *SSEWriter {
	f, ok := w.(http.Flusher)
	if !ok {
		panic("http.ResponseWriter does not implement http.Flusher")
	}
	return &SSEWriter{w: w, flusher: f}
}

// Header exposes the underlying response header map.
func (s *SSEWriter) Header() http.Header { return s.w.Header() }

// WriteHeaders writes SSE response headers with status 200.
func (s *SSEWriter) WriteHeaders() {
	h := s.w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("Access-Control-Allow-Origin", "*")
	s.w.WriteHeader(http.StatusOK)
}

// Write implements io.Writer. Every non-empty write is followed by a flush so
// that streaming clients see each chunk immediately.
func (s *SSEWriter) Write(p []byte) (int, error) {
	if s.done {
		return 0, errors.New("sse writer already closed")
	}
	n, err := s.w.Write(p)
	if n > 0 {
		s.Flush()
	}
	return n, err
}

// WriteEvent marshals v to JSON and emits a single OpenAI-style SSE event.
func (s *SSEWriter) WriteEvent(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(s, "data: %s\n\n", b)
	return err
}

// WriteDone emits the OpenAI-standard [DONE] terminator and marks the writer
// closed. Subsequent writes return an error.
func (s *SSEWriter) WriteDone() error {
	if s.done {
		return nil
	}
	_, err := s.Write([]byte("data: [DONE]\n\n"))
	s.done = true
	return err
}

// Flush explicitly flushes buffered data to the client.
func (s *SSEWriter) Flush() {
	s.flusher.Flush()
	s.flushed++
}

// FlushCount returns how many times Flush has been invoked.
func (s *SSEWriter) FlushCount() int { return s.flushed }

// StreamingHandler drives a single chat/completions streaming request.
type StreamingHandler struct {
	w    *SSEWriter
	ctrl *sse.StreamController
}

// NewStreamingHandler creates a handler for the request. The controller links
// the request's lifecycle to the upstream fetch; when the client disconnects,
// the controller aborts the upstream.
func NewStreamingHandler(w http.ResponseWriter, ctrl *sse.StreamController) *StreamingHandler {
	return &StreamingHandler{
		w:    NewSSEWriter(w),
		ctrl: ctrl,
	}
}

// Stream copies upstream to the client using OpenAI-compatible SSE framing.
// On clean EOF it emits data: [DONE]\n\n. On client disconnect, stall, or
// upstream error it aborts without emitting the terminal event.
func (h *StreamingHandler) Stream(upstream io.Reader) error {
	h.w.WriteHeaders()
	res := sse.PipeUpstream(h.w, upstream, h.ctrl, 0)
	if res.Err != nil {
		h.ctrl.HandleError(res.Err)
		return res.Err
	}
	if res.Reason != "complete" {
		return nil
	}
	if err := h.w.WriteDone(); err != nil {
		return err
	}
	h.ctrl.HandleComplete()
	return nil
}

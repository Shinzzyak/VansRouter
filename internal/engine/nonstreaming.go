package engine

import (
	"io"
	"net/http"

	"github.com/9router/9router/internal/sse"
)

// TranslateFunc transforms a provider response body from provider format into
// the client-facing format. It returns the translated bytes or an error.
type TranslateFunc func([]byte) ([]byte, error)

// NonStreamingHandler drives a single non-streaming chat completion request.
type NonStreamingHandler struct {
	w    http.ResponseWriter
	ctrl *sse.StreamController
}

// NewNonStreamingHandler creates a handler for the request.
func NewNonStreamingHandler(w http.ResponseWriter, ctrl *sse.StreamController) *NonStreamingHandler {
	return &NonStreamingHandler{w: w, ctrl: ctrl}
}

// Handle reads the full upstream response body, optionally translates it, and
// writes it to the client as JSON. It reports completion to the stream
// controller on success and propagates upstream errors.
func (h *NonStreamingHandler) Handle(upstream io.Reader, translate TranslateFunc) error {
	body, err := io.ReadAll(upstream)
	if err != nil {
		h.ctrl.HandleError(err)
		return err
	}
	if translate != nil {
		body, err = translate(body)
		if err != nil {
			h.ctrl.HandleError(err)
			return err
		}
	}
	h.w.Header().Set("Content-Type", "application/json")
	h.w.Header().Set("Access-Control-Allow-Origin", "*")
	h.w.WriteHeader(http.StatusOK)
	if _, err := h.w.Write(body); err != nil {
		return err
	}
	h.ctrl.HandleComplete()
	return nil
}

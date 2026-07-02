package v1

import (
	"context"
	"encoding/json"
	"io"
	"net/http"

	"github.com/9router/9router/internal/engine"
)

// ResponsesExecutor runs a responses-format request by converting it to chat completions.
type ResponsesExecutor interface {
	Complete(ctx context.Context, body map[string]any) (*http.Response, error)
}

// ResponsesHandler handles POST /v1/responses.
// It converts the Responses API body to a Chat Completions body and forwards it.
type ResponsesHandler struct {
	Executor ResponsesExecutor
}

func (h *ResponsesHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST required")
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request_error", "failed to read body")
		return
	}
	defer r.Body.Close()

	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request_error", "invalid JSON")
		return
	}

	model, _ := payload["model"].(string)
	if model == "" {
		writeError(w, http.StatusBadRequest, "invalid_request_error", "Missing required field: model")
		return
	}

	converted, err := engine.ResponsesToChatCompletions(payload)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request_error", err.Error())
		return
	}

	// Preserve streaming preference; default to false.
	if _, ok := converted["stream"]; !ok {
		converted["stream"] = false
	}

	if h.Executor == nil {
		writeError(w, http.StatusServiceUnavailable, "service_unavailable", "responses executor not configured")
		return
	}

	upstream, err := h.Executor.Complete(r.Context(), converted)
	if err != nil {
		writeError(w, http.StatusBadGateway, "bad_gateway", err.Error())
		return
	}
	defer upstream.Body.Close()

	copyHeader(w.Header(), upstream.Header)
	w.WriteHeader(upstream.StatusCode)
	io.Copy(w, upstream.Body)
}

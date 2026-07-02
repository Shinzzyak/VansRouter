package sse

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
)

// EmbeddingsExecutor runs an embeddings request against a provider.
type EmbeddingsExecutor interface {
	Embed(ctx context.Context, req EmbeddingsRequest) (*http.Response, error)
}

// EmbeddingsRequest is the provider-facing embeddings payload.
type EmbeddingsRequest struct {
	Provider string
	Model    string
	Input    any
	Body     map[string]any
}

// EmbeddingsHandler handles POST /v1/embeddings.
type EmbeddingsHandler struct {
	Executor EmbeddingsExecutor
}

func (h *EmbeddingsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "failed to read body")
		return
	}
	defer r.Body.Close()

	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}

	model, _ := payload["model"].(string)
	if model == "" {
		writeError(w, http.StatusBadRequest, "Missing required field: model")
		return
	}

	input := payload["input"]
	if input == nil {
		writeError(w, http.StatusBadRequest, "Missing required field: input")
		return
	}
	switch input.(type) {
	case string, []any:
		// ok
	default:
		writeError(w, http.StatusBadRequest, "input must be a string or array of strings")
		return
	}

	// ponytail: model-to-provider resolver deferred to Phase 6 step 2.
	provider := "openai"
	if p, ok := payload["provider"].(string); ok && p != "" {
		provider = p
	}

	req := EmbeddingsRequest{
		Provider: provider,
		Model:    model,
		Input:    input,
		Body:     payload,
	}

	if h.Executor == nil {
		writeError(w, http.StatusServiceUnavailable, "embeddings executor not configured")
		return
	}

	upstream, err := h.Executor.Embed(r.Context(), req)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer upstream.Body.Close()

	copyHeader(w.Header(), upstream.Header)
	w.WriteHeader(upstream.StatusCode)
	io.Copy(w, upstream.Body)
}

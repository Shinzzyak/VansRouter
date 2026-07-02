package sse

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
)

// ImageExecutor runs an image generation request against a provider.
type ImageExecutor interface {
	Generate(ctx context.Context, req ImageRequest) (*http.Response, error)
}

// ImageRequest is the provider-facing image generation payload.
type ImageRequest struct {
	Provider string
	Model    string
	Prompt   string
	Body     map[string]any
}

// ImageHandler handles POST /v1/images/generations.
type ImageHandler struct {
	Executor ImageExecutor
}

func (h *ImageHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
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

	prompt, _ := payload["prompt"].(string)
	if prompt == "" {
		writeError(w, http.StatusBadRequest, "Missing required field: prompt")
		return
	}

	provider := "openai"
	if p, ok := payload["provider"].(string); ok && p != "" {
		provider = p
	}

	req := ImageRequest{
		Provider: provider,
		Model:    getString(payload, "model"),
		Prompt:   prompt,
		Body:     payload,
	}

	if h.Executor == nil {
		// ponytail: no executor configured; return a placeholder OpenAI-compatible image response.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]any{
			"created": 1,
			"data": []map[string]any{
				{"url": "https://example.com/placeholder.png"},
			},
		})
		return
	}

	upstream, err := h.Executor.Generate(r.Context(), req)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer upstream.Body.Close()

	copyHeader(w.Header(), upstream.Header)
	w.WriteHeader(upstream.StatusCode)
	io.Copy(w, upstream.Body)
}

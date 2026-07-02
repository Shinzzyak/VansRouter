package v1

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
)

// FetchExecutor runs a web fetch request against a provider.
type FetchExecutor interface {
	Fetch(ctx context.Context, req FetchRequest) (*http.Response, error)
}

// FetchRequest is the provider-facing fetch payload.
type FetchRequest struct {
	URL        string
	Format     string
	Provider   string
	MaxChars   int
	Body       map[string]any
}

// FetchHandler handles POST /v1/fetch.
type FetchHandler struct {
	Executor FetchExecutor
}

func (h *FetchHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
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

	url, _ := payload["url"].(string)
	if url == "" {
		writeError(w, http.StatusBadRequest, "invalid_request_error", "Missing required field: url")
		return
	}

	// ponytail: defaulting provider to "jina-reader" is a placeholder. The JS
	// port supports firecrawl, jina-reader, tavily, and exa with provider-
	// specific URL/body/parse logic. Add registry-driven provider selection
	// when provider fetch configs are loaded.
	provider := "jina-reader"
	if p, ok := payload["provider"].(string); ok && p != "" {
		provider = p
	}

	maxChars := 0
	if v, ok := payload["max_characters"].(float64); ok {
		maxChars = int(v)
	}

	req := FetchRequest{
		URL:      url,
		Format:   getString(payload, "format", "markdown"),
		Provider: provider,
		MaxChars: maxChars,
		Body:     payload,
	}

	if h.Executor == nil {
		writeFetchFallback(w, req)
		return
	}

	upstream, err := h.Executor.Fetch(r.Context(), req)
	if err != nil {
		writeError(w, http.StatusBadGateway, "bad_gateway", err.Error())
		return
	}
	defer upstream.Body.Close()

	copyHeader(w.Header(), upstream.Header)
	w.WriteHeader(upstream.StatusCode)
	io.Copy(w, upstream.Body)
}

func writeFetchFallback(w http.ResponseWriter, req FetchRequest) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]any{
		"provider": req.Provider,
		"url":      req.URL,
		"title":    nil,
		"content": map[string]any{
			"format": req.Format,
			"text":   "Placeholder fetched content.",
			"length": len("Placeholder fetched content."),
		},
		"metadata": map[string]any{
			"author":       nil,
			"published_at": nil,
			"language":     nil,
		},
		"usage": map[string]any{
			"fetch_cost_usd": nil,
		},
		"metrics": map[string]any{
			"response_time_ms": 0,
		},
	})
}

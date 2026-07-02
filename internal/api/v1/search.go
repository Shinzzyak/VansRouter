package v1

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
)

// SearchExecutor runs a web search request against a provider.
type SearchExecutor interface {
	Search(ctx context.Context, req SearchRequest) (*http.Response, error)
}

// SearchRequest is the provider-facing search payload.
type SearchRequest struct {
	Query   string
	Body    map[string]any
	Model   string
	Provider string
}

// SearchHandler handles POST /v1/search.
type SearchHandler struct {
	Executor SearchExecutor
}

func (h *SearchHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
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

	query, _ := payload["query"].(string)
	if query == "" {
		writeError(w, http.StatusBadRequest, "invalid_request_error", "Missing required field: query")
		return
	}

	// ponytail: defaulting provider to "tavily" is a placeholder. The JS port
	// resolves via provider registry + model mapping and supports dedicated
	// search APIs plus chat-based fallback. Add real resolution when the
	// registry exposes model/provider search lookup.
	provider := "tavily"
	if p, ok := payload["provider"].(string); ok && p != "" {
		provider = p
	}

	req := SearchRequest{
		Query:    query,
		Body:     payload,
		Model:    getString(payload, "model"),
		Provider: provider,
	}

	if h.Executor == nil {
		writeSearchFallback(w, req)
		return
	}

	upstream, err := h.Executor.Search(r.Context(), req)
	if err != nil {
		writeError(w, http.StatusBadGateway, "bad_gateway", err.Error())
		return
	}
	defer upstream.Body.Close()

	copyHeader(w.Header(), upstream.Header)
	w.WriteHeader(upstream.StatusCode)
	io.Copy(w, upstream.Body)
}

// writeSearchFallback returns a placeholder search result when no executor is configured.
func writeSearchFallback(w http.ResponseWriter, req SearchRequest) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]any{
		"provider": req.Provider,
		"query":    req.Query,
		"results": []map[string]any{
			{
				"title":   "Example result",
				"url":     "https://example.com",
				"snippet": "This is a placeholder search result.",
			},
		},
		"answer": nil,
		"usage": map[string]any{
			"queries_used":   1,
			"search_cost_usd": 0,
		},
		"metrics": map[string]any{
			"response_time_ms": 0,
		},
		"errors": []string{},
	})
}

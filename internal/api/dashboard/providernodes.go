package dashboard

import "net/http"

// ProviderNodesHandlers holds provider-nodes endpoint stubs.
type ProviderNodesHandlers struct{}

// NewProviderNodesHandlers creates provider-nodes handlers.
func NewProviderNodesHandlers() *ProviderNodesHandlers {
	return &ProviderNodesHandlers{}
}

// List handles GET /api/provider-nodes.
func (h *ProviderNodesHandlers) List(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET required")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"nodes": []any{},
	})
}

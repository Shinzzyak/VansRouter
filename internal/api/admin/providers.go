package admin

import (
	"net/http"

	"github.com/9router/9router/internal/providers"
)

// ProvidersHandler lists the loaded provider registry.
type ProvidersHandler struct {
	Registry *providers.Registry
}

func (h *ProvidersHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET required")
		return
	}
	if h.Registry == nil {
		writeJSON(w, http.StatusOK, []map[string]any{})
		return
	}
	list := make([]providers.Provider, 0, len(h.Registry.Providers))
	for _, p := range h.Registry.Providers {
		list = append(list, p)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"providers": list,
	})
}

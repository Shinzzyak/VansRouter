package dashboard

import "net/http"

// HeadroomHandlers holds headroom endpoint stubs.
type HeadroomHandlers struct{}

// NewHeadroomHandlers creates headroom handlers.
func NewHeadroomHandlers() *HeadroomHandlers {
	return &HeadroomHandlers{}
}

// Status handles GET /api/headroom/status.
func (h *HeadroomHandlers) Status(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET required")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":     "stopped",
		"enabled":    false,
		"lastRunAt":  nil,
		"nextRunAt":  nil,
		"queueDepth": 0,
	})
}

package dashboard

import "net/http"

// TunnelHandlers holds tunnel endpoint stubs.
type TunnelHandlers struct{}

// NewTunnelHandlers creates tunnel handlers.
func NewTunnelHandlers() *TunnelHandlers {
	return &TunnelHandlers{}
}

// Status handles GET /api/tunnel/status.
func (h *TunnelHandlers) Status(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET required")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled":   false,
		"connected": false,
		"url":       "",
		"error":     "",
	})
}

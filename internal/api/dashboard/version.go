package dashboard

import (
	"net/http"
	"os"
)

// VersionHandlers holds version endpoint dependencies.
type VersionHandlers struct {
	Commit  string
	Version string
}

// NewVersionHandlers creates version handlers.
func NewVersionHandlers() *VersionHandlers {
	return &VersionHandlers{
		Version: os.Getenv("APP_VERSION"),
		Commit:  os.Getenv("APP_COMMIT"),
	}
}

// GetVersion handles GET /api/version.
func (h *VersionHandlers) GetVersion(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET required")
		return
	}
	v := h.Version
	if v == "" {
		v = "dev"
	}
	c := h.Commit
	if c == "" {
		c = "unknown"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"version": v,
		"commit":  c,
	})
}

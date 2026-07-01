package api

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/9router/9router/backend/internal/log"
	"github.com/go-chi/chi/v5"
)

// Routes builds the chi router with logging, recovery, and placeholder handlers.
func Routes(logger *slog.Logger) http.Handler {
	r := chi.NewRouter()

	r.Use(log.Recovery(logger))
	r.Use(log.RequestLogger(logger))

	r.Get("/health", healthHandler)
	r.Get("/shutdown", shutdownHandler)
	r.Get("/version", versionHandler)
	r.Get("/api/v1/models", modelsHandler)

	r.Mount("/v1", v1Router())

	return r
}

func v1Router() http.Handler {
	r := chi.NewRouter()
	return r
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func shutdownHandler(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"message": "Shutting down...",
	})
}

func versionHandler(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"currentVersion": "0.0.0-go",
		"latestVersion":  nil,
		"githubVersion":  nil,
		"hasUpdate":      false,
		"githubStatus":   "current",
		"runtime":        "go",
		"canAutoRestart": false,
		"installCommand": nil,
	})
}

func modelsHandler(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"object": "list",
		"data":   []any{},
	})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

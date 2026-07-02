package api

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/9router/9router/internal/api/dashboard"
	"github.com/9router/9router/internal/api/middleware"
	"github.com/9router/9router/internal/api/v1"
	"github.com/9router/9router/internal/auth"
	"github.com/9router/9router/internal/db/repos"
	"github.com/9router/9router/internal/models"
	"github.com/9router/9router/internal/providers"
	"github.com/go-chi/chi/v5"
)

// Routes builds the chi router with logging, recovery, CORS, real-IP,
// auth, and v1 handlers.
func Routes(logger *slog.Logger, r *repos.Repos, registry *providers.Registry) http.Handler {
	builder := models.NewBuilder(registry, models.NewSQLSource(r.DB))

	router := chi.NewRouter()

	router.Use(middleware.RealIP)
	router.Use(middleware.Recovery(logger))
	router.Use(middleware.RequestLogger(logger))
	router.Use(middleware.NewCORS("").Wrap)

	router.Get("/health", healthHandler)
	router.Get("/shutdown", shutdownHandler)
	router.Get("/version", versionHandler)

	// Public model list used by the dashboard (no API key required).
	router.Get("/models", v1.ModelsHandler(builder))

	// Public OpenAI-compatible surface.
	router.Mount("/v1", v1Router(r, builder))

	// Legacy dashboard path kept for compatibility during the port.
	router.With(auth.APIKeyMiddleware(r.Keys)).Get("/api/v1/models", v1.ModelsHandler(builder))

	// Dashboard API routes (auth, settings, providers, keys, usage, etc).
	router.Mount("/api", dashboardRouter(r, registry, builder))

	return router
}

func dashboardRouter(r *repos.Repos, registry *providers.Registry, builder *models.Builder) http.Handler {
	router := chi.NewRouter()

	authHandlers := dashboard.NewAuthHandlers(r.Settings)
	router.Post("/auth/login", authHandlers.Login)
	router.Post("/auth/logout", authHandlers.Logout)
	router.Get("/auth/status", authHandlers.Status)
	router.Get("/auth/check", authHandlers.Check)
	router.Post("/auth/reset-password", authHandlers.ResetPassword)

	settingsHandlers := dashboard.NewSettingsHandlers(r.Settings)
	router.With(dashboard.RequireSession).Get("/settings", settingsHandlers.GetSettings)
	router.With(dashboard.RequireSession).Patch("/settings", settingsHandlers.UpdateSettings)

	providersHandlers := dashboard.NewProvidersHandlers(r)
	providersHandlers.Registry = registry
	router.With(dashboard.RequireSession).Get("/providers", providersHandlers.ListConnections)

	keysHandlers := dashboard.NewKeysHandlers(r)
	router.With(dashboard.RequireSession).Get("/keys", keysHandlers.ListKeys)
	router.With(dashboard.RequireSession).Post("/keys", keysHandlers.CreateKey)
	router.With(dashboard.RequireSession).Get("/keys/{id}", keysHandlers.GetKey)
	router.With(dashboard.RequireSession).Patch("/keys/{id}", keysHandlers.UpdateKey)
	router.With(dashboard.RequireSession).Delete("/keys/{id}", keysHandlers.DeleteKey)

	combosHandlers := dashboard.NewCombosHandlers(r)
	router.With(dashboard.RequireSession).Get("/combos", combosHandlers.ListCombos)
	router.With(dashboard.RequireSession).Post("/combos", combosHandlers.CreateCombo)
	router.With(dashboard.RequireSession).Get("/combos/{id}", combosHandlers.GetCombo)
	router.With(dashboard.RequireSession).Patch("/combos/{id}", combosHandlers.UpdateCombo)
	router.With(dashboard.RequireSession).Delete("/combos/{id}", combosHandlers.DeleteCombo)

	usageHandlers := dashboard.NewUsageHandlers(r)
	router.With(dashboard.RequireSession).Get("/usage/history", usageHandlers.History)
	router.With(dashboard.RequireSession).Get("/usage/logs", usageHandlers.Logs)
	router.With(dashboard.RequireSession).Get("/usage/stats", usageHandlers.Stats)
	router.With(dashboard.RequireSession).Get("/usage/stream", usageHandlers.Stream)
	router.With(dashboard.RequireSession).Get("/usage/providers", usageHandlers.Providers)
	router.With(dashboard.RequireSession).Get("/usage/request-details", usageHandlers.RequestDetails)
	router.With(dashboard.RequireSession).Get("/usage/request-details/{id}", usageHandlers.RequestDetailByID)
	router.With(dashboard.RequireSession).Get("/usage/chart", usageHandlers.Chart)
	router.With(dashboard.RequireSession).Get("/usage/{connectionId}", usageHandlers.ConnectionUsage)
	router.With(dashboard.RequireSession).Post("/usage/{connectionId}/codex-reset-credits", usageHandlers.CodexResetCredits)

	providerNodesHandlers := dashboard.NewProviderNodesHandlers()
	router.With(dashboard.RequireSession).Get("/provider-nodes", providerNodesHandlers.List)

	tunnelHandlers := dashboard.NewTunnelHandlers()
	router.With(dashboard.RequireSession).Get("/tunnel/status", tunnelHandlers.Status)

	headroomHandlers := dashboard.NewHeadroomHandlers()
	router.With(dashboard.RequireSession).Get("/headroom/status", headroomHandlers.Status)

	versionHandlers := dashboard.NewVersionHandlers()
	router.Get("/version", versionHandlers.GetVersion)

	// TODO: proxy-pools, models, cli-tools, oauth, translator, locale, pricing, tags.

	return router
}

func v1Router(r *repos.Repos, builder *models.Builder) http.Handler {
	router := chi.NewRouter()
	router.Use(auth.APIKeyMiddleware(r.Keys))
	router.Get("/models", v1.ModelsHandler(builder))
	chatHandler := v1.NewChatHandler(nil, builder)
	router.Post("/chat/completions", http.HandlerFunc(chatHandler.ServeHTTP))

	searchHandler := &v1.SearchHandler{}
	router.Post("/search", http.HandlerFunc(searchHandler.ServeHTTP))

	fetchHandler := &v1.FetchHandler{}
	router.Post("/fetch", http.HandlerFunc(fetchHandler.ServeHTTP))

	responsesHandler := &v1.ResponsesHandler{}
	router.Post("/responses", http.HandlerFunc(responsesHandler.ServeHTTP))

	messagesHandler := &v1.MessagesHandler{}
	router.Post("/messages/count_tokens", http.HandlerFunc(messagesHandler.ServeHTTP))

	return router
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

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

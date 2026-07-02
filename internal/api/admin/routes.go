package admin

import (
	"net/http"

	"github.com/9router/9router/internal/providers"
	"github.com/9router/9router/internal/usage"
	"github.com/go-chi/chi/v5"
)

// Router mounts all dashboard admin route groups.
func Router(registry *providers.Registry, store usage.Store) http.Handler {
	r := chi.NewRouter()

	r.Get("/health", (&HealthHandler{}).ServeHTTP)
	r.Get("/providers", (&ProvidersHandler{Registry: registry}).ServeHTTP)
	r.Get("/usage", (&UsageHandler{Store: store}).ServeHTTP)
	r.Post("/usage/detail", (&UsageHandler{Store: store}).ServeHTTP)
	r.Get("/usage/details", (&RequestDetailsHandler{Store: store}).ServeHTTP)

	return r
}

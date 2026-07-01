package middleware

import "net/http"

// CORS wraps a handler with permissive CORS headers mirroring
// corsHeadersFrom() in src/app/api/v1beta/models. CLI clients connect
// from arbitrary origins, so we reflect an explicit allow-list (default
// "*") and answer OPTIONS preflight requests with 204.
type CORS struct {
	AllowOrigin string
}

// NewCORS returns a CORS middleware with the given allow-origin. Pass ""
// for a permissive "*" default.
func NewCORS(allowOrigin string) *CORS {
	if allowOrigin == "" {
		allowOrigin = "*"
	}
	return &CORS{AllowOrigin: allowOrigin}
}

func (c *CORS) Wrap(next http.Handler) http.Handler {
	origin := c.AllowOrigin
	// ponytail: when origin == "*", Vary: Origin is wasted header bytes;
	// skip it. Only relevant once the dashboard locks to a non-wildcard origin.
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, x-9r-cli-token, x-requested-with")
		w.Header().Set("Access-Control-Max-Age", "86400")
		w.Header().Set("Vary", "Origin")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

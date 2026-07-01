package auth

import (
	"context"
	"net/http"
	"strings"

	"github.com/9router/9router/backend/internal/db/repos"
)

// APIKeyHeaderContextKey is the context key for the resolved API key.
type APIKeyHeaderContextKey struct{}

// ExtractAPIKey returns the API key from the Authorization Bearer header or
// the x-api-key header. It mirrors the JS extractApiKey logic.
func ExtractAPIKey(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	if strings.HasPrefix(auth, "Bearer ") {
		return strings.TrimPrefix(auth, "Bearer ")
	}
	if key := r.Header.Get("x-api-key"); key != "" {
		return key
	}
	return ""
}

// WithAPIKey stores the resolved API key info on the context.
func WithAPIKey(ctx context.Context, key *repos.APIKey) context.Context {
	return context.WithValue(ctx, APIKeyHeaderContextKey{}, key)
}

// APIKeyFromContext returns the API key info stored on the context, or nil.
func APIKeyFromContext(ctx context.Context) *repos.APIKey {
	v, _ := ctx.Value(APIKeyHeaderContextKey{}).(*repos.APIKey)
	return v
}

// APIKeyMiddleware resolves and validates the API key, attaching the key row
// to the request context. Requests without a valid key receive 401.
func APIKeyMiddleware(keys *repos.KeysRepo) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			k := ExtractAPIKey(r)
			if k == "" {
				http.Error(w, `{"error":"missing api key"}`, http.StatusUnauthorized)
				return
			}
			info, err := keys.GetByKey(k)
			if err != nil || info == nil || !info.IsActive {
				http.Error(w, `{"error":"invalid api key"}`, http.StatusUnauthorized)
				return
			}
			next.ServeHTTP(w, r.WithContext(WithAPIKey(r.Context(), info)))
		})
	}
}

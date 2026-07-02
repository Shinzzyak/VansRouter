package dashboard

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"

	"github.com/9router/9router/internal/auth"
	"github.com/go-chi/chi/v5"
)

// writeJSON writes a JSON response with the given status code.
func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

// writeError writes a JSON error response.
func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"error": message, "code": code})
}

// clientIP returns the best-effort client IP, honoring x-forwarded-for.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		if len(parts) > 0 {
			return strings.TrimSpace(parts[0])
		}
	}
	if xri := r.Header.Get("X-Real-Ip"); xri != "" {
		return xri
	}
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	if host != "" {
		return host
	}
	return r.RemoteAddr
}

// isLocalRequest returns true when the request comes from localhost or a
// private/internal network. Dashboard uses this to decide remote behavior.
func isLocalRequest(r *http.Request) bool {
	ip := clientIP(r)
	if ip == "" {
		return false
	}
	if ip == "127.0.0.1" || ip == "::1" || ip == "localhost" {
		return true
	}
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return false
	}
	return parsed.IsLoopback() || parsed.IsPrivate() || parsed.IsLinkLocalUnicast()
}

// SessionFromRequest extracts and verifies the session cookie.
func SessionFromRequest(r *http.Request) *auth.Session {
	cookie, err := r.Cookie(auth.SessionCookieName)
	if err != nil {
		return nil
	}
	session, err := auth.VerifySession(cookie.Value)
	if err != nil {
		return nil
	}
	return session
}

// RequireSession returns a middleware that rejects requests without a valid
// dashboard session.
func RequireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if SessionFromRequest(r) == nil {
			WriteError(w, http.StatusUnauthorized, "unauthorized", "Not authenticated")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// WriteError writes a JSON error response. It is exported so route mounting
// code in package api can render dashboard-style errors.
func WriteError(w http.ResponseWriter, status int, code, message string) {
	writeError(w, status, code, message)
}

// stringSetting returns a string value from settings, falling back to def.
func stringSetting(settings map[string]any, key, def string) string {
	if settings == nil {
		return def
	}
	v, ok := settings[key].(string)
	if !ok {
		return def
	}
	return v
}

// boolSetting returns a bool value from settings, falling back to def.
func boolSetting(settings map[string]any, key string, def bool) bool {
	if settings == nil {
		return def
	}
	v, ok := settings[key].(bool)
	if !ok {
		return def
	}
	return v
}

// cloneMap returns a shallow copy of m.
func cloneMap(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// idFromPath returns the {id} URL parameter when mounted with chi.
func idFromPath(r *http.Request) string {
	return chi.URLParam(r, "id")
}

// readJSONBody reads and re-reads the request body as JSON.
// The returned bytes can be decoded again by the caller if needed.
func readJSONBody(r *http.Request) (map[string]any, []byte, error) {
	b, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, nil, err
	}
	var body map[string]any
	if err := json.Unmarshal(b, &body); err != nil {
		return nil, b, err
	}
	return body, b, nil
}

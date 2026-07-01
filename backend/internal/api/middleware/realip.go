// Package middleware contains HTTP middleware used by the Go backend.
// It mirrors the request-handling stack in src/app (Next.js) where present
// and fills the gaps the Node runtime used to provide implicitly
// (recovery, access logs, CORS preflight, real-IP resolution).
package middleware

import (
	"net/http"
	"strings"
)

// RealIP extracts the originating client IP from X-Forwarded-For (first
// hop) or X-Real-IP. When neither header is present it returns the
// connection's remote address. The chosen value is stored on the request
// context so downstream handlers and access logs can read it via
// RemoteAddr (chi automatically rewrites r.RemoteAddr).
func RealIP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r)
		if ip != "" {
			r.RemoteAddr = ip
		}
		next.ServeHTTP(w, r)
	})
}

// ClientIP returns the resolved client IP without consuming the request.
// Useful for loggers that need the value after the middleware chain.
func ClientIP(r *http.Request) string { return clientIP(r) }

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.IndexByte(xff, ','); i >= 0 {
			xff = xff[:i]
		}
		if ip := strings.TrimSpace(xff); ip != "" {
			return ip
		}
	}
	if xri := strings.TrimSpace(r.Header.Get("X-Real-IP")); xri != "" {
		return xri
	}
	return r.RemoteAddr
}

package auth

import (
	"fmt"
	"net/http"
	"os"
	"strings"
)

const (
	defaultOidcScopes      = "openid profile email"
	defaultOidcLoginLabel  = "Sign in with OIDC"
	oidcCookieNameState    = "oidc_state"
	oidcCookieNameNonce    = "oidc_nonce"
	oidcCookieNameVerifier = "oidc_code_verifier"
)

// OidcConfig holds the runtime OIDC provider settings loaded from environment
// variables. This is intentionally thin; real ID-token verification and the
// authorization-code exchange are deferred to Phase 3.
type OidcConfig struct {
	IssuerURL    string
	ClientID     string
	ClientSecret string
	Scopes       string
	LoginLabel   string
}

// OidcCookieNames returns the cookie names used during the OIDC flow.
func OidcCookieNames() map[string]string {
	return map[string]string{
		"state":    oidcCookieNameState,
		"nonce":    oidcCookieNameNonce,
		"verifier": oidcCookieNameVerifier,
	}
}

// LoadOidcConfig reads OIDC settings from the environment. It returns nil when
// OIDC is not configured.
func LoadOidcConfig() *OidcConfig {
	issuer := trimTrailingSlashes(os.Getenv("OIDC_ISSUER_URL"))
	clientID := strings.TrimSpace(os.Getenv("OIDC_CLIENT_ID"))
	clientSecret := strings.TrimSpace(os.Getenv("OIDC_CLIENT_SECRET"))

	if issuer == "" || clientID == "" || clientSecret == "" {
		return nil
	}

	scopes := strings.TrimSpace(os.Getenv("OIDC_SCOPES"))
	if scopes == "" {
		scopes = defaultOidcScopes
	}
	label := strings.TrimSpace(os.Getenv("OIDC_LOGIN_LABEL"))
	if label == "" {
		label = defaultOidcLoginLabel
	}

	return &OidcConfig{
		IssuerURL:    issuer,
		ClientID:     clientID,
		ClientSecret: clientSecret,
		Scopes:       scopes,
		LoginLabel:   label,
	}
}

// IsOidcConfigured reports whether all required OIDC provider fields are set.
func IsOidcConfigured(cfg *OidcConfig) bool {
	if cfg == nil {
		return false
	}
	return cfg.IssuerURL != "" && cfg.ClientID != "" && cfg.ClientSecret != ""
}

// GetPublicOrigin derives the public origin for OIDC callback URLs. It mirrors
// src/lib/auth/oidc.js: prefer BASE_URL / NEXT_PUBLIC_BASE_URL, then trust
// x-forwarded-proto / x-forwarded-host, then fall back to the request URL.
func GetPublicOrigin(r *http.Request) string {
	if base := os.Getenv("BASE_URL"); base != "" {
		return trimTrailingSlashes(base)
	}
	if base := os.Getenv("NEXT_PUBLIC_BASE_URL"); base != "" {
		return trimTrailingSlashes(base)
	}
	if r == nil {
		return ""
	}

	forwardedProto := r.Header.Get("x-forwarded-proto")
	forwardedHost := r.Header.Get("x-forwarded-host")
	host := forwardedHost
	if host == "" {
		host = r.Host
	}
	if host != "" {
		proto := forwardedProto
		if proto == "" {
			if r.TLS != nil || strings.ToLower(forwardedProto) == "https" {
				proto = "https"
			} else {
				proto = "http"
			}
		}
		return fmt.Sprintf("%s://%s", proto, host)
	}

	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return trimTrailingSlashes(fmt.Sprintf("%s://%s", scheme, r.Host))
}

// BuildCallbackURL returns the fully-qualified OIDC callback URL for the given
// origin and relative callback path.
func BuildCallbackURL(origin, callbackPath string) string {
	path := "/" + strings.TrimPrefix(callbackPath, "/")
	return trimTrailingSlashes(origin) + path
}

func trimTrailingSlashes(value string) string {
	return strings.TrimRight(strings.TrimSpace(value), "/")
}

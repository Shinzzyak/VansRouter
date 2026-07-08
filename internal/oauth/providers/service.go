// Package providers implements provider-specific OAuth flows that extend the
// generic OAuth provider in internal/oauth. Each provider service encapsulates
// its unique authorization endpoints, token formats, and flow variations
// (device code, social login, token import, etc.).
package providers

import (
	"context"
	"net/http"

	"github.com/9router/9router/internal/oauth"
)

// HTTPClient is the interface for making HTTP requests. Matches oauth.HTTPClient.
type HTTPClient = oauth.HTTPClient

// TokenResponse mirrors of oauth.TokenResponse, re-exported for convenience.
type TokenResponse = oauth.TokenResponse

// Service defines the interface for provider-specific OAuth operations.
// Each provider implements its own flow: standard auth code, device code,
// token import, social login, etc.
type Service interface {
	// Name returns the provider identifier (e.g. "codex", "kiro", "xai").
	Name() string

	// GetProvider returns the base OAuth provider configuration.
	// Providers that don't use standard auth-code flow (e.g. cursor import,
	// kiro device code) may return a zero-value Provider.
	GetProvider() oauth.Provider
}

// RefreshableService extends Service with token refresh capability.
type RefreshableService interface {
	Service
	// Refresh uses a refresh token to obtain new tokens.
	Refresh(ctx context.Context, client HTTPClient, refreshToken string) (*TokenResponse, error)
}

// Registry maps provider IDs to their Service implementations.
var Registry = map[string]Service{}

// Register adds a service to the provider registry.
func Register(s Service) {
	Registry[s.Name()] = s
}

// GetService returns the registered service for a provider ID.
func GetService(id string) (Service, bool) {
	s, ok := Registry[id]
	return s, ok
}

// init registers all known provider services.
func init() {
	Register(NewCodexService())
	Register(NewCursorService())
	Register(NewKiroService())
	Register(NewQoderService())
	Register(NewXaiService())
}

// defaultClient returns the given client or http.DefaultClient if nil.
func defaultClient(c HTTPClient) HTTPClient {
	if c == nil {
		return http.DefaultClient
	}
	return c
}

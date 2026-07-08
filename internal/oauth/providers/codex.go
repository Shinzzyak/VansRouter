package providers

import (
	"context"
	"fmt"

	"github.com/9router/9router/internal/oauth"
)

// CodexService implements OpenAI Codex OAuth (authorization code + PKCE).
type CodexService struct {
	provider oauth.Provider
}

// NewCodexService creates a Codex OAuth service.
func NewCodexService() *CodexService {
	p, _ := oauth.GetProvider("codex")
	return &CodexService{provider: p}
}

func (s *CodexService) Name() string          { return "codex" }
func (s *CodexService) GetProvider() oauth.Provider { return s.provider }

// BuildAuthURL constructs the Codex authorization URL.
// Codex uses %20 for space encoding instead of + (handled by url.QueryEscape).
func (s *CodexService) BuildAuthURL(redirectURI, state, codeChallenge string) (string, error) {
	return s.provider.BuildAuthURL(redirectURI, state, codeChallenge)
}

// ExchangeCode swaps an authorization code for tokens.
func (s *CodexService) ExchangeCode(ctx context.Context, client HTTPClient, code, redirectURI, codeVerifier string) (*TokenResponse, error) {
	return oauth.Exchange(ctx, defaultClient(client), s.provider, code, redirectURI, codeVerifier)
}

// Authenticate performs the complete Codex OAuth flow.
// In CLI context: start local server on port 1455, open browser, wait for callback.
// In server context: this would be handled by the web UI.
func (s *CodexService) Authenticate(ctx context.Context, client HTTPClient) (*TokenResponse, error) {
	return nil, fmt.Errorf("codex: interactive flow not implemented in server context")
}

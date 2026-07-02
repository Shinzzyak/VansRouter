package oauth

import (
	"fmt"
	"net/url"
	"strings"
)

// Provider holds the OAuth configuration for a single identity provider.
type Provider struct {
	Name                string
	ClientID            string
	AuthURL             string
	TokenURL            string
	Scopes              []string
	CodeChallengeMethod string
	ExtraAuthParams     map[string]string
}

// BuildAuthURL builds the authorization URL for the provider.
func (p *Provider) BuildAuthURL(redirectURI, state, codeChallenge string) (string, error) {
	u, err := url.Parse(p.AuthURL)
	if err != nil {
		return "", fmt.Errorf("invalid auth url: %w", err)
	}
	q := u.Query()
	q.Set("client_id", p.ClientID)
	q.Set("response_type", "code")
	q.Set("redirect_uri", redirectURI)
	q.Set("scope", strings.Join(p.Scopes, " "))
	q.Set("state", state)
	q.Set("code_challenge", codeChallenge)
	q.Set("code_challenge_method", p.CodeChallengeMethod)
	for k, v := range p.ExtraAuthParams {
		q.Set(k, v)
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

// ponytail: hardcoded client IDs and endpoints mirror the JS constants file
// but should be loaded from configuration or the provider registry so new
// OAuth providers don't require a code change.
// Known providers. Client IDs should be overridden from configuration/env.
var Providers = map[string]Provider{
	"claude": {
		Name:                "claude",
		ClientID:            "anthropic_console_pkce_client",
		AuthURL:             "https://console.anthropic.com/oauth/authorize",
		TokenURL:            "https://api.anthropic.com/oauth/token",
		Scopes:              []string{"oidc"},
		CodeChallengeMethod: "S256",
		ExtraAuthParams:     map[string]string{"code": "true"},
	},
	"gemini": {
		Name:                "gemini",
		ClientID:            "426090742574-bngni3gtdanj8rblmhj1v0uvv1l924i9.apps.googleusercontent.com",
		AuthURL:             "https://accounts.google.com/o/oauth2/v2/auth",
		TokenURL:            "https://oauth2.googleapis.com/token",
		Scopes:              []string{"openid", "email", "profile"},
		CodeChallengeMethod: "S256",
		ExtraAuthParams:     map[string]string{"access_type": "offline"},
	},
	"github": {
		Name:                "github",
		ClientID:            "Ov23liRpx8jRDDT8v8gz",
		AuthURL:             "https://github.com/login/oauth/authorize",
		TokenURL:            "https://github.com/login/oauth/access_token",
		Scopes:              []string{"read:user", "user:email"},
		CodeChallengeMethod: "S256",
	},
	"codex": {
		Name:                "codex",
		ClientID:            "codex-cli",
		AuthURL:             "https://auth.openai.com/authorize",
		TokenURL:            "https://auth.openai.com/token",
		Scopes:              []string{"openid", "email", "profile"},
		CodeChallengeMethod: "S256",
	},
	"xai": {
		Name:                "xai",
		ClientID:            "xai-cli",
		AuthURL:             "https://accounts.x.ai/authorize",
		TokenURL:            "https://accounts.x.ai/token",
		Scopes:              []string{"openid", "email", "profile"},
		CodeChallengeMethod: "S256",
	},
}

// GetProvider returns a provider config by ID.
func GetProvider(id string) (Provider, bool) {
	p, ok := Providers[id]
	return p, ok
}

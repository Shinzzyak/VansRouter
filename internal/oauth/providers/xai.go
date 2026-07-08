package providers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"

	"github.com/9router/9router/internal/oauth"
)

// XaiService implements xAI (Grok) OAuth flow using PKCE with endpoint discovery.
type XaiService struct {
	provider oauth.Provider
}

// NewXaiService creates an xAI OAuth service.
func NewXaiService() *XaiService {
	p, _ := oauth.GetProvider("xai")
	return &XaiService{provider: p}
}

func (s *XaiService) Name() string              { return "xai" }
func (s *XaiService) GetProvider() oauth.Provider { return s.provider }

// DiscoveredEndpoints holds discovered OAuth endpoints.
type DiscoveredEndpoints struct {
	AuthorizeURL string
	TokenURL     string
}

var (
	discoveredEndpoints *DiscoveredEndpoints
	discoveryOnce       sync.Once
)

// ValidateOAuthEndpoint validates that an OAuth endpoint is on x.ai domain and uses HTTPS.
func ValidateOAuthEndpoint(rawURL, field string) (string, error) {
	value := strings.TrimSpace(rawURL)
	if value == "" {
		return "", fmt.Errorf("xai discovery %s is empty", field)
	}

	parsed, err := url.Parse(value)
	if err != nil {
		return "", fmt.Errorf("xai discovery %s is invalid: %w", field, err)
	}

	if parsed.Scheme != "https" {
		return "", fmt.Errorf("xai discovery %s must use https: %s", field, value)
	}

	host := strings.ToLower(strings.TrimSpace(parsed.Hostname()))
	if host != "x.ai" && !strings.HasSuffix(host, ".x.ai") {
		return "", fmt.Errorf("xai discovery %s host %s is not on x.ai", field, host)
	}

	return value, nil
}

// DiscoverEndpoints discovers xAI OAuth endpoints from well-known configuration.
func DiscoverEndpoints(ctx context.Context, client HTTPClient) (*DiscoveredEndpoints, error) {
	var discoverErr error
	discoveryOnce.Do(func() {
		discoveryURL := "https://auth.x.ai/.well-known/openid-configuration"
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, discoveryURL, nil)
		if err != nil {
			discoverErr = err
			return
		}
		req.Header.Set("Accept", "application/json")

		resp, err := defaultClient(client).Do(req)
		if err != nil {
			discoverErr = err
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			// Fall back to static config
			discoveredEndpoints = &DiscoveredEndpoints{
				AuthorizeURL: "https://auth.x.ai/oauth2/authorize",
				TokenURL:     "https://auth.x.ai/oauth2/token",
			}
			return
		}

		body, err := io.ReadAll(resp.Body)
		if err != nil {
			discoverErr = err
			return
		}

		var data struct {
			AuthorizationEndpoint string `json:"authorization_endpoint"`
			TokenEndpoint         string `json:"token_endpoint"`
		}
		if err := json.Unmarshal(body, &data); err != nil {
			discoveredEndpoints = &DiscoveredEndpoints{
				AuthorizeURL: "https://auth.x.ai/oauth2/authorize",
				TokenURL:     "https://auth.x.ai/oauth2/token",
			}
			return
		}

		authURL, err := ValidateOAuthEndpoint(data.AuthorizationEndpoint, "authorization_endpoint")
		if err != nil {
			discoverErr = err
			return
		}

		tokenURL, err := ValidateOAuthEndpoint(data.TokenEndpoint, "token_endpoint")
		if err != nil {
			discoverErr = err
			return
		}

		discoveredEndpoints = &DiscoveredEndpoints{
			AuthorizeURL: authURL,
			TokenURL:     tokenURL,
		}
	})

	if discoverErr != nil {
		return nil, discoverErr
	}
	return discoveredEndpoints, nil
}

// DecodeIdTokenEmail extracts email from an xAI id_token JWT.
func DecodeIdTokenEmail(idToken string) string {
	if idToken == "" {
		return ""
	}

	parts := strings.Split(idToken, ".")
	if len(parts) != 3 {
		return ""
	}

	base64 := strings.ReplaceAll(parts[1], "-", "+")
	base64 = strings.ReplaceAll(base64, "_", "/")
	padding := (4 - len(base64)%4) % 4
	base64 += strings.Repeat("=", padding)

	decoded, err := base64Decode(base64)
	if err != nil {
		return ""
	}

	var payload struct {
		Email             string `json:"email"`
		PreferredUsername string `json:"preferred_username"`
		Sub               string `json:"sub"`
	}
	if err := json.Unmarshal(decoded, &payload); err != nil {
		return ""
	}

	if payload.Email != "" {
		return payload.Email
	}
	if payload.PreferredUsername != "" {
		return payload.PreferredUsername
	}
	return payload.Sub
}

func base64Decode(s string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(s)
}

// BuildAuthURL constructs the xAI authorization URL.
func (s *XaiService) BuildAuthURL(redirectURI, state, codeChallenge string, authorizeURL string) string {
	params := map[string]string{
		"response_type":         "code",
		"client_id":             s.provider.ClientID,
		"redirect_uri":          redirectURI,
		"scope":                 "openid profile email offline_access grok-cli:access api:access",
		"code_challenge":        codeChallenge,
		"code_challenge_method": "S256",
		"state":                 state,
		"nonce":                 generateNonce(),
		"plan":                  "generic",
		"referrer":              "cli-proxy-api",
	}

	var queryParts []string
	for k, v := range params {
		queryParts = append(queryParts, fmt.Sprintf("%s=%s", k, url.QueryEscape(v)))
	}

	return fmt.Sprintf("%s?%s", authorizeURL, strings.Join(queryParts, "&"))
}

// ExchangeCode exchanges an authorization code for tokens.
func (s *XaiService) ExchangeCode(ctx context.Context, client HTTPClient, tokenURL, code, redirectURI, codeVerifier string) (*TokenResponse, error) {
	data := url.Values{}
	data.Set("grant_type", "authorization_code")
	data.Set("client_id", s.provider.ClientID)
	data.Set("code", code)
	data.Set("redirect_uri", redirectURI)
	data.Set("code_verifier", codeVerifier)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, strings.NewReader(data.Encode()))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := defaultClient(client).Do(req)
	if err != nil {
		return nil, fmt.Errorf("token request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("token exchange failed: %s", string(body))
	}

	var tr TokenResponse
	if err := json.Unmarshal(body, &tr); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	return &tr, nil
}

// Refresh refreshes an access token using a refresh token.
func (s *XaiService) Refresh(ctx context.Context, client HTTPClient, refreshToken string) (*TokenResponse, error) {
	endpoints, err := DiscoverEndpoints(ctx, client)
	if err != nil {
		return nil, fmt.Errorf("discover endpoints: %w", err)
	}

	data := url.Values{}
	data.Set("grant_type", "refresh_token")
	data.Set("client_id", s.provider.ClientID)
	data.Set("refresh_token", refreshToken)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoints.TokenURL, strings.NewReader(data.Encode()))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := defaultClient(client).Do(req)
	if err != nil {
		return nil, fmt.Errorf("refresh request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("token refresh failed: %s", string(body))
	}

	var tr TokenResponse
	if err := json.Unmarshal(body, &tr); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	return &tr, nil
}

// Authenticate is not supported in server context for xAI.
func (s *XaiService) Authenticate(ctx context.Context, client HTTPClient) (*TokenResponse, error) {
	return nil, fmt.Errorf("xai: interactive flow not implemented in server context")
}

func generateNonce() string {
	b := make([]byte, 16)
	_, _ = strings.NewReader("").Read(b)
	return fmt.Sprintf("%x", b)
}

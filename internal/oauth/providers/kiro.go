package providers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"github.com/9router/9router/internal/oauth"
)

// KiroService implements AWS Cognito OAuth flows for Kiro (CodeWhisperer).
// Supports: AWS Builder ID (device code), AWS IDC (device code),
// Google/GitHub social login (auth code), token import, API key validation.
type KiroService struct {
	provider oauth.Provider
}

// NewKiroService creates a Kiro OAuth service.
func NewKiroService() *KiroService {
	p, _ := oauth.GetProvider("kiro")
	return &KiroService{provider: p}
}

func (s *KiroService) Name() string              { return "kiro" }
func (s *KiroService) GetProvider() oauth.Provider { return s.provider }

// ValidateAwsRegion checks that a region string is a valid AWS region format.
func ValidateAwsRegion(region string) error {
	pattern := regexp.MustCompile(`^[a-z]{2}-[a-z]+-\d{1,2}$`)
	if !pattern.MatchString(region) {
		return fmt.Errorf("invalid AWS region format: %s", region)
	}
	return nil
}

// RegisterClient registers an OIDC client with AWS SSO for device code flow.
func (s *KiroService) RegisterClient(ctx context.Context, client HTTPClient, region string) (string, string, error) {
	if err := ValidateAwsRegion(region); err != nil {
		return "", "", err
	}

	endpoint := fmt.Sprintf("https://oidc.%s.amazonaws.com/client/register", region)
	body := map[string]interface{}{
		"clientName": "kiro-cli",
		"clientType": "public",
		"scopes":     []string{"sso:account:access", "codewhisperer:completions"},
		"grantTypes": []string{
			"urn:ietf:params:oauth:grant-type:device_code",
			"refresh_token",
		},
		"issuerUrl": "https://view.awsapps.com/start",
	}

	jsonData, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(jsonData)))
	if err != nil {
		return "", "", fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := defaultClient(client).Do(req)
	if err != nil {
		return "", "", fmt.Errorf("register client: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", "", fmt.Errorf("register client failed: %s", string(respBody))
	}

	var data struct {
		ClientID     string `json:"clientId"`
		ClientSecret string `json:"clientSecret"`
	}
	if err := json.Unmarshal(respBody, &data); err != nil {
		return "", "", fmt.Errorf("decode response: %w", err)
	}

	return data.ClientID, data.ClientSecret, nil
}

// StartDeviceAuthorization initiates device code flow.
func (s *KiroService) StartDeviceAuthorization(ctx context.Context, client HTTPClient, clientID, clientSecret, startURL, region string) (string, string, string, error) {
	if err := ValidateAwsRegion(region); err != nil {
		return "", "", "", err
	}

	endpoint := fmt.Sprintf("https://oidc.%s.amazonaws.com/device_authorization", region)
	body := map[string]string{
		"clientId":     clientID,
		"clientSecret": clientSecret,
		"startUrl":     startURL,
	}

	jsonData, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(jsonData)))
	if err != nil {
		return "", "", "", fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := defaultClient(client).Do(req)
	if err != nil {
		return "", "", "", fmt.Errorf("start device auth: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", "", "", fmt.Errorf("start device auth failed: %s", string(respBody))
	}

	var data struct {
		DeviceCode              string `json:"deviceCode"`
		UserCode                string `json:"userCode"`
		VerificationURIComplete string `json:"verificationUriComplete"`
	}
	if err := json.Unmarshal(respBody, &data); err != nil {
		return "", "", "", fmt.Errorf("decode response: %w", err)
	}

	return data.DeviceCode, data.UserCode, data.VerificationURIComplete, nil
}

// PollDeviceToken polls for tokens during device code flow.
func (s *KiroService) PollDeviceToken(ctx context.Context, client HTTPClient, clientID, clientSecret, deviceCode, region string) (*TokenResponse, bool, error) {
	if err := ValidateAwsRegion(region); err != nil {
		return nil, false, err
	}

	endpoint := fmt.Sprintf("https://oidc.%s.amazonaws.com/token", region)
	body := map[string]string{
		"clientId":     clientID,
		"clientSecret": clientSecret,
		"deviceCode":   deviceCode,
		"grantType":    "urn:ietf:params:oauth:grant-type:device_code",
	}

	jsonData, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(jsonData)))
	if err != nil {
		return nil, false, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := defaultClient(client).Do(req)
	if err != nil {
		return nil, false, fmt.Errorf("poll token: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var errData struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(respBody, &errData)
		if errData.Error == "authorization_pending" || errData.Error == "slow_down" {
			return nil, true, nil
		}
		return nil, false, fmt.Errorf("poll failed: %s", string(respBody))
	}

	var data struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
		ExpiresIn    int    `json:"expiresIn"`
		TokenType    string `json:"tokenType"`
	}
	if err := json.Unmarshal(respBody, &data); err != nil {
		return nil, false, fmt.Errorf("decode token: %w", err)
	}

	return &TokenResponse{
		AccessToken:  data.AccessToken,
		RefreshToken: data.RefreshToken,
		ExpiresIn:    data.ExpiresIn,
		TokenType:    data.TokenType,
	}, false, nil
}

// BuildSocialLoginURL constructs a Google/GitHub social login URL for Kiro.
func (s *KiroService) BuildSocialLoginURL(provider, codeChallenge, state string) string {
	idp := "Google"
	if provider == "github" {
		idp = "Github"
	}
	redirectURI := "kiro://kiro.kiroAgent/authenticate-success"
	return fmt.Sprintf("https://prod.us-east-1.auth.desktop.kiro.dev/login?idp=%s&redirect_uri=%s&code_challenge=%s&code_challenge_method=S256&state=%s&prompt=select_account",
		idp, redirectURI, codeChallenge, state)
}

// ExchangeSocialCode exchanges a social login code for tokens.
func (s *KiroService) ExchangeSocialCode(ctx context.Context, client HTTPClient, code, codeVerifier string) (*TokenResponse, error) {
	endpoint := "https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token"
	body := map[string]string{
		"code":          code,
		"code_verifier": codeVerifier,
		"redirect_uri":  "kiro://kiro.kiroAgent/authenticate-success",
	}

	jsonData, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(jsonData)))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := defaultClient(client).Do(req)
	if err != nil {
		return nil, fmt.Errorf("exchange code: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("exchange failed: %s", string(respBody))
	}

	var data struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
		ExpiresIn    int    `json:"expiresIn"`
	}
	if err := json.Unmarshal(respBody, &data); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	return &TokenResponse{
		AccessToken:  data.AccessToken,
		RefreshToken: data.RefreshToken,
		ExpiresIn:    data.ExpiresIn,
	}, nil
}

// RefreshWithExtras refreshes tokens with provider-specific extra parameters.
func (s *KiroService) RefreshWithExtras(ctx context.Context, client HTTPClient, refreshToken string, extra map[string]string) (*TokenResponse, error) {
	clientID := extra["clientId"]
	clientSecret := extra["clientSecret"]
	region := extra["region"]
	if region == "" {
		region = "us-east-1"
	}

	// AWS SSO OIDC refresh
	if clientID != "" && clientSecret != "" {
		if err := ValidateAwsRegion(region); err != nil {
			return nil, err
		}
		endpoint := fmt.Sprintf("https://oidc.%s.amazonaws.com/token", region)
		body := map[string]string{
			"clientId":     clientID,
			"clientSecret": clientSecret,
			"refreshToken": refreshToken,
			"grantType":    "refresh_token",
		}

		jsonData, _ := json.Marshal(body)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(jsonData)))
		if err != nil {
			return nil, fmt.Errorf("build request: %w", err)
		}
		req.Header.Set("Content-Type", "application/json")

		resp, err := defaultClient(client).Do(req)
		if err != nil {
			return nil, fmt.Errorf("refresh token: %w", err)
		}
		defer resp.Body.Close()

		respBody, _ := io.ReadAll(resp.Body)
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return nil, fmt.Errorf("refresh failed: %s", string(respBody))
		}

		var data struct {
			AccessToken  string `json:"accessToken"`
			RefreshToken string `json:"refreshToken"`
			ExpiresIn    int    `json:"expiresIn"`
		}
		if err := json.Unmarshal(respBody, &data); err != nil {
			return nil, fmt.Errorf("decode response: %w", err)
		}

		refresh := data.RefreshToken
		if refresh == "" {
			refresh = refreshToken
		}

		return &TokenResponse{
			AccessToken:  data.AccessToken,
			RefreshToken: refresh,
			ExpiresIn:    data.ExpiresIn,
		}, nil
	}

	// Social auth refresh
	endpoint := "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken"
	body := map[string]string{"refreshToken": refreshToken}

	jsonData, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(jsonData)))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := defaultClient(client).Do(req)
	if err != nil {
		return nil, fmt.Errorf("refresh token: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("refresh failed: %s", string(respBody))
	}

	var data struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
		ExpiresIn    int    `json:"expiresIn"`
	}
	if err := json.Unmarshal(respBody, &data); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	refresh := data.RefreshToken
	if refresh == "" {
		refresh = refreshToken
	}

	return &TokenResponse{
		AccessToken:  data.AccessToken,
		RefreshToken: refresh,
		ExpiresIn:    data.ExpiresIn,
	}, nil
}

// ValidateImportToken validates a Kiro import token.
func (s *KiroService) ValidateImportToken(refreshToken string) error {
	if !strings.HasPrefix(refreshToken, "aorAAAAAG") {
		return fmt.Errorf("invalid token format: token should start with aorAAAAAG")
	}
	return nil
}

// ExtractEmailFromJWT extracts email from a JWT access token.
func ExtractEmailFromJWT(accessToken string) string {
	parts := strings.Split(accessToken, ".")
	if len(parts) != 3 {
		return ""
	}

	payload := parts[1]
	// Add padding
	for len(payload)%4 != 0 {
		payload += "="
	}

	decoded, err := base64.URLEncoding.DecodeString(payload)
	if err != nil {
		return ""
	}

	var claims map[string]interface{}
	if err := json.Unmarshal(decoded, &claims); err != nil {
		return ""
	}

	if email, ok := claims["email"].(string); ok && email != "" {
		return email
	}
	if username, ok := claims["preferred_username"].(string); ok && username != "" {
		return username
	}
	if sub, ok := claims["sub"].(string); ok {
		return sub
	}

	return ""
}

// Authenticate is not supported in server context for Kiro.
func (s *KiroService) Authenticate(ctx context.Context, client HTTPClient) (*TokenResponse, error) {
	return nil, fmt.Errorf("kiro: use device code or social login flow")
}

// Refresh implements RefreshableService.
func (s *KiroService) Refresh(ctx context.Context, client HTTPClient, refreshToken string) (*TokenResponse, error) {
	return s.RefreshWithExtras(ctx, client, refreshToken, nil)
}

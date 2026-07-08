package services

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// KiroService handles Kiro (AWS CodeWhisperer) OAuth flows.
// Source: src/lib/oauth/services/kiro.js
// Supports: AWS Builder ID (device code), AWS IDC (device code),
// Google/GitHub Social Login (auth code), Import Token, API Key.
const KiroAuthService = "https://prod.us-east-1.auth.desktop.kiro.dev"

// KiroConfig holds Kiro OAuth configuration.
type KiroConfig struct {
	ClientName  string
	ClientType  string
	Scopes      []string
	GrantTypes  []string
	IssuerURL   string
}

// DefaultKiroConfig returns default Kiro config.
func DefaultKiroConfig() KiroConfig {
	return KiroConfig{
		ClientName: "kiro-agent",
		ClientType: "public",
		Scopes:     []string{"codewhisperer:completions", "codewhisperer:analysis", "codewhisperer:conversations"},
		GrantTypes: []string{"urn:ietf:params:oauth:grant-type:device_code", "refresh_token"},
		IssuerURL:  "https://auth.desktop.kiro.dev",
	}
}

// KiroClientRegistration holds the result of client registration.
type KiroClientRegistration struct {
	ClientID              string `json:"clientId"`
	ClientSecret          string `json:"clientSecret"`
	ClientSecretExpiresAt int64  `json:"clientSecretExpiresAt"`
}

// KiroDeviceAuth holds the result of device authorization start.
type KiroDeviceAuth struct {
	DeviceCode              string `json:"deviceCode"`
	UserCode                string `json:"userCode"`
	VerificationURI         string `json:"verificationUri"`
	VerificationURIComplete string `json:"verificationUriComplete"`
	ExpiresIn               int    `json:"expiresIn"`
	Interval                int    `json:"interval"`
}

// KiroTokenResult holds tokens from device code or social login.
type KiroTokenResult struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	ProfileArn   string `json:"profileArn"`
	ExpiresIn    int    `json:"expiresIn"`
	TokenType    string `json:"tokenType"`
	AuthMethod   string `json:"authMethod,omitempty"`
}

// KiroPollResult holds the result of polling for device token.
type KiroPollResult struct {
	Success         bool
	Pending         bool
	Error           string
	ErrorDescription string
	Tokens          *KiroTokenResult
}

// KiroProviderData holds provider-specific data for refresh.
type KiroProviderData struct {
	AuthMethod   string
	ClientID     string
	ClientSecret string
	Region       string
}

// KiroService handles Kiro OAuth operations.
type KiroService struct {
	HTTPClient *http.Client
	Config     KiroConfig
}

// NewKiroService creates a new KiroService.
func NewKiroService(client *http.Client) *KiroService {
	if client == nil {
		client = http.DefaultClient
	}
	return &KiroService{
		HTTPClient: client,
		Config:     DefaultKiroConfig(),
	}
}

// RegisterClient registers an OIDC client with AWS SSO.
func (s *KiroService) RegisterClient(ctx context.Context, region string) (*KiroClientRegistration, error) {
	if region == "" {
		region = "us-east-1"
	}
	if !isValidAWSRegion(region) {
		return nil, fmt.Errorf("invalid AWS region: %s", region)
	}

	endpoint := fmt.Sprintf("https://oidc.%s.amazonaws.com/client/register", region)
	body, _ := json.Marshal(s.Config)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build register request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("register client: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("register client failed %d: %s", resp.StatusCode, string(respBody))
	}

	var reg KiroClientRegistration
	if err := json.Unmarshal(respBody, &reg); err != nil {
		return nil, fmt.Errorf("decode register response: %w", err)
	}
	return &reg, nil
}

// StartDeviceAuthorization starts device authorization for AWS Builder ID or IDC.
func (s *KiroService) StartDeviceAuthorization(ctx context.Context, clientID, clientSecret, startURL, region string) (*KiroDeviceAuth, error) {
	if region == "" {
		region = "us-east-1"
	}
	if !isValidAWSRegion(region) {
		return nil, fmt.Errorf("invalid AWS region: %s", region)
	}

	endpoint := fmt.Sprintf("https://oidc.%s.amazonaws.com/device_authorization", region)
	body, _ := json.Marshal(map[string]string{
		"clientId":     clientID,
		"clientSecret": clientSecret,
		"startUrl":     startURL,
	})

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build device auth request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("device authorization: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("device authorization failed %d: %s", resp.StatusCode, string(respBody))
	}

	var da KiroDeviceAuth
	if err := json.Unmarshal(respBody, &da); err != nil {
		return nil, fmt.Errorf("decode device auth response: %w", err)
	}
	if da.Interval == 0 {
		da.Interval = 5
	}
	return &da, nil
}

// PollDeviceToken polls for token using device code.
func (s *KiroService) PollDeviceToken(ctx context.Context, clientID, clientSecret, deviceCode, region string) (*KiroPollResult, error) {
	if region == "" {
		region = "us-east-1"
	}
	if !isValidAWSRegion(region) {
		return nil, fmt.Errorf("invalid AWS region: %s", region)
	}

	endpoint := fmt.Sprintf("https://oidc.%s.amazonaws.com/token", region)
	body, _ := json.Marshal(map[string]string{
		"clientId":     clientID,
		"clientSecret": clientSecret,
		"deviceCode":   deviceCode,
		"grantType":    "urn:ietf:params:oauth:grant-type:device_code",
	})

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build poll request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("poll device token: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)

	var data struct {
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
		AccessToken      string `json:"accessToken"`
		RefreshToken     string `json:"refreshToken"`
		ExpiresIn        int    `json:"expiresIn"`
		TokenType        string `json:"tokenType"`
	}
	_ = json.Unmarshal(respBody, &data)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 || data.Error != "" {
		pending := data.Error == "authorization_pending" || data.Error == "slow_down"
		return &KiroPollResult{
			Success:         false,
			Pending:         pending,
			Error:           data.Error,
			ErrorDescription: data.ErrorDescription,
		}, nil
	}

	return &KiroPollResult{
		Success: true,
		Tokens: &KiroTokenResult{
			AccessToken:  data.AccessToken,
			RefreshToken: data.RefreshToken,
			ExpiresIn:    data.ExpiresIn,
			TokenType:    data.TokenType,
		},
	}, nil
}

// BuildSocialLoginURL builds the Google/GitHub social login URL.
// Uses kiro:// custom protocol as required by AWS Cognito whitelist.
func (s *KiroService) BuildSocialLoginURL(provider, codeChallenge, state string) string {
	idp := "Github"
	if provider == "google" {
		idp = "Google"
	}
	redirectURI := "kiro://kiro.kiroAgent/authenticate-success"
	return fmt.Sprintf("%s/login?idp=%s&redirect_uri=%s&code_challenge=%s&code_challenge_method=S256&state=%s&prompt=select_account",
		KiroAuthService, idp, redirectURI, codeChallenge, state)
}

// ExchangeSocialCode exchanges authorization code for tokens (Social Login).
func (s *KiroService) ExchangeSocialCode(ctx context.Context, code, codeVerifier string) (*KiroTokenResult, error) {
	redirectURI := "kiro://kiro.kiroAgent/authenticate-success"
	body, _ := json.Marshal(map[string]string{
		"code":         code,
		"code_verifier": codeVerifier,
		"redirect_uri":  redirectURI,
	})

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, KiroAuthService+"/oauth/token", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build social exchange request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("social code exchange: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("social code exchange failed %d: %s", resp.StatusCode, string(respBody))
	}

	var data struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
		ProfileArn   string `json:"profileArn"`
		ExpiresIn    int    `json:"expiresIn"`
	}
	if err := json.Unmarshal(respBody, &data); err != nil {
		return nil, fmt.Errorf("decode social exchange response: %w", err)
	}
	if data.ExpiresIn == 0 {
		data.ExpiresIn = 3600
	}

	return &KiroTokenResult{
		AccessToken:  data.AccessToken,
		RefreshToken: data.RefreshToken,
		ProfileArn:   data.ProfileArn,
		ExpiresIn:    data.ExpiresIn,
	}, nil
}

// RefreshToken refreshes an access token using a refresh token.
// Uses AWS SSO OIDC if clientId+clientSecret are available, otherwise social auth.
func (s *KiroService) RefreshToken(ctx context.Context, refreshToken string, providerData KiroProviderData) (*KiroTokenResult, error) {
	if providerData.ClientID != "" && providerData.ClientSecret != "" {
		region := providerData.Region
		if region == "" {
			region = "us-east-1"
		}
		if !isValidAWSRegion(region) {
			return nil, fmt.Errorf("invalid AWS region: %s", region)
		}

		endpoint := fmt.Sprintf("https://oidc.%s.amazonaws.com/token", region)
		body, _ := json.Marshal(map[string]string{
			"clientId":     providerData.ClientID,
			"clientSecret": providerData.ClientSecret,
			"refreshToken": refreshToken,
			"grantType":    "refresh_token",
		})

		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
		if err != nil {
			return nil, fmt.Errorf("build refresh request: %w", err)
		}
		req.Header.Set("Content-Type", "application/json")

		resp, err := s.HTTPClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("refresh token: %w", err)
		}
		defer resp.Body.Close()

		respBody, _ := io.ReadAll(resp.Body)
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return nil, fmt.Errorf("refresh token failed %d: %s", resp.StatusCode, string(respBody))
		}

		var data struct {
			AccessToken  string `json:"accessToken"`
			RefreshToken string `json:"refreshToken"`
			ProfileArn   string `json:"profileArn"`
			ExpiresIn    int    `json:"expiresIn"`
		}
		if err := json.Unmarshal(respBody, &data); err != nil {
			return nil, fmt.Errorf("decode refresh response: %w", err)
		}
		if data.RefreshToken == "" {
			data.RefreshToken = refreshToken
		}
		return &KiroTokenResult{
			AccessToken:  data.AccessToken,
			RefreshToken: data.RefreshToken,
			ProfileArn:   data.ProfileArn,
			ExpiresIn:    data.ExpiresIn,
		}, nil
	}

	// Social auth refresh
	body, _ := json.Marshal(map[string]string{
		"refreshToken": refreshToken,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, KiroAuthService+"/refreshToken", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build social refresh request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("social refresh: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("social refresh failed %d: %s", resp.StatusCode, string(respBody))
	}

	var data struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
		ProfileArn   string `json:"profileArn"`
		ExpiresIn    int    `json:"expiresIn"`
	}
	if err := json.Unmarshal(respBody, &data); err != nil {
		return nil, fmt.Errorf("decode social refresh response: %w", err)
	}
	if data.RefreshToken == "" {
		data.RefreshToken = refreshToken
	}
	if data.ExpiresIn == 0 {
		data.ExpiresIn = 3600
	}
	return &KiroTokenResult{
		AccessToken:  data.AccessToken,
		RefreshToken: data.RefreshToken,
		ProfileArn:   data.ProfileArn,
		ExpiresIn:    data.ExpiresIn,
	}, nil
}

// ValidateImportToken validates an imported refresh token.
func (s *KiroService) ValidateImportToken(ctx context.Context, refreshToken string) (*KiroTokenResult, error) {
	if !strings.HasPrefix(refreshToken, "aorAAAAAG") {
		return nil, fmt.Errorf("invalid token format: token should start with aorAAAAAG...")
	}

	result, err := s.RefreshToken(ctx, refreshToken, KiroProviderData{})
	if err != nil {
		return nil, fmt.Errorf("token validation failed: %w", err)
	}
	result.AuthMethod = "imported"
	return result, nil
}

// ListAvailableProfiles lists CodeWhisperer profiles and returns the best match ARN.
func (s *KiroService) ListAvailableProfiles(ctx context.Context, accessToken, region string) (string, error) {
	if region == "" {
		region = "us-east-1"
	}
	if !isValidAWSRegion(region) {
		return "", fmt.Errorf("invalid AWS region: %s", region)
	}

	endpoint := fmt.Sprintf("https://codewhisperer.%s.amazonaws.com", region)
	body, _ := json.Marshal(map[string]int{"maxResults": 10})

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("build list profiles request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-amz-json-1.0")
	req.Header.Set("x-amz-target", "AmazonCodeWhispererService.ListAvailableProfiles")
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/json")

	resp, err := s.HTTPClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("list profiles: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("list profiles failed %d: %s", resp.StatusCode, string(respBody))
	}

	var data struct {
		Profiles []struct {
			Arn       string `json:"arn"`
			ProfileArn string `json:"profileArn"`
		} `json:"profiles"`
	}
	if err := json.Unmarshal(respBody, &data); err != nil {
		return "", fmt.Errorf("decode profiles response: %w", err)
	}

	if len(data.Profiles) == 0 {
		return "", nil
	}

	// Find profile matching region, fallback to first
	for _, p := range data.Profiles {
		arn := p.Arn
		if arn == "" {
			arn = p.ProfileArn
		}
		if arn != "" {
			parts := strings.Split(arn, ":")
			if len(parts) > 3 && parts[3] == region {
				return arn, nil
			}
		}
	}
	// Fallback to first profile
	p := data.Profiles[0]
	if p.Arn != "" {
		return p.Arn, nil
	}
	return p.ProfileArn, nil
}

// ValidateAPIKey validates an API key by listing profiles.
func (s *KiroService) ValidateAPIKey(ctx context.Context, apiKey, region string) (*KiroTokenResult, error) {
	if strings.TrimSpace(apiKey) == "" {
		return nil, fmt.Errorf("API key is required")
	}
	trimmed := strings.TrimSpace(apiKey)

	profileArn, err := s.ListAvailableProfiles(ctx, trimmed, region)
	if err != nil {
		return nil, fmt.Errorf("API key validation failed: %w", err)
	}

	return &KiroTokenResult{
		AccessToken: trimmed,
		ProfileArn:  profileArn,
		AuthMethod:  "api_key",
	}, nil
}

// ExtractEmailFromJWT extracts email from a JWT access token.
func (s *KiroService) ExtractEmailFromJWT(accessToken string) string {
	parts := strings.Split(accessToken, ".")
	if len(parts) != 3 {
		return ""
	}

	payload := parts[1]
	for len(payload)%4 != 0 {
		payload += "="
	}

	decoded, err := base64.StdEncoding.DecodeString(
		strings.ReplaceAll(strings.ReplaceAll(payload, "-", "+"), "_", "/"),
	)
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
	if pref, ok := claims["preferred_username"].(string); ok && pref != "" {
		return pref
	}
	if sub, ok := claims["sub"].(string); ok {
		return sub
	}
	return ""
}

// isValidAWSRegion validates an AWS region string.
func isValidAWSRegion(region string) bool {
	valid := map[string]bool{
		"us-east-1": true, "us-east-2": true, "us-west-1": true, "us-west-2": true,
		"eu-west-1": true, "eu-west-2": true, "eu-west-3": true,
		"eu-central-1": true, "ap-south-1": true, "ap-northeast-1": true,
		"ap-northeast-2": true, "ap-southeast-1": true, "ap-southeast-2": true,
		"ap-east-1": true, "sa-east-1": true, "ca-central-1": true,
	}
	return valid[region]
}

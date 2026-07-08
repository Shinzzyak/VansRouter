package providers

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/9router/9router/internal/oauth"
	"github.com/google/uuid"
)

// QoderService implements Qoder OAuth using device token flow with PKCE.
// Tokens live ~30 days; refresh returns 403, so users re-login when expired.
type QoderService struct {
	provider oauth.Provider
}

// NewQoderService creates a Qoder OAuth service.
func NewQoderService() *QoderService {
	p, _ := oauth.GetProvider("qoder")
	return &QoderService{provider: p}
}

func (s *QoderService) Name() string              { return "qoder" }
func (s *QoderService) GetProvider() oauth.Provider { return s.provider }

// GeneratePKCE generates a PKCE verifier and S256 challenge pair using 32 random bytes.
func (s *QoderService) GeneratePKCE() (string, string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", "", fmt.Errorf("generate random: %w", err)
	}

	verifier := base64.RawURLEncoding.EncodeToString(b)
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])

	return verifier, challenge, nil
}

// InitiateDeviceFlow starts the Qoder device token flow.
// Returns the verification URL, code verifier, nonce, and machine ID.
func (s *QoderService) InitiateDeviceFlow() (string, string, string, string, error) {
	verifier, challenge, err := s.GeneratePKCE()
	if err != nil {
		return "", "", "", "", err
	}

	nonce := uuid.New().String()
	machineID := uuid.New().String()

	params := fmt.Sprintf("challenge=%s&challenge_method=S256&machine_id=%s&nonce=%s",
		challenge, machineID, nonce)
	verificationURL := fmt.Sprintf("https://qoder.com/device/selectAccounts?%s", params)

	return verificationURL, verifier, nonce, machineID, nil
}

// PollDeviceToken polls for a token during device flow.
// Returns (token, pending, error) where pending=true means keep polling.
func (s *QoderService) PollDeviceToken(ctx context.Context, client HTTPClient, nonce, codeVerifier string) (*TokenResponse, bool, error) {
	if nonce == "" || codeVerifier == "" {
		return nil, false, fmt.Errorf("nonce and code verifier are required")
	}

	endpoint := fmt.Sprintf("https://openapi.qoder.sh/api/v1/deviceToken/poll?nonce=%s&verifier=%s&challenge_method=S256",
		nonce, codeVerifier)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, false, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Go-http-client/2.0")

	resp, err := defaultClient(client).Do(req)
	if err != nil {
		return nil, false, fmt.Errorf("poll token: %w", err)
	}
	defer resp.Body.Close()

	// 202 and 404 mean "keep polling"
	if resp.StatusCode == 202 || resp.StatusCode == 404 {
		return nil, true, nil
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, false, fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var errData struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(body, &errData)
		msg := errData.Message
		if msg == "" {
			msg = string(body)
		}
		return nil, false, fmt.Errorf("poll failed: %s", msg)
	}

	var data struct {
		Token       string `json:"token"`
		RefreshTok  string `json:"refresh_token"`
		UserID      string `json:"user_id"`
		ExpiresAt   int64  `json:"expires_at"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &data); err != nil {
		return nil, false, fmt.Errorf("decode response: %w", err)
	}

	if data.Token == "" {
		return nil, false, fmt.Errorf("token poll returned 200 but no token")
	}

	expireMs := parseExpiry(data.ExpiresAt, data.ExpiresIn)

	return &TokenResponse{
		AccessToken:  data.Token,
		RefreshToken: data.RefreshTok,
		ExpiresIn:    int(expireMs/1000 - time.Now().Unix()),
	}, false, nil
}

// FetchUserInfo fetches user profile information.
func (s *QoderService) FetchUserInfo(ctx context.Context, client HTTPClient, accessToken string) (string, string, string, error) {
	endpoint := "https://openapi.qoder.sh/api/v1/userinfo"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", "", "", fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", accessToken))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Go-http-client/2.0")

	resp, err := defaultClient(client).Do(req)
	if err != nil {
		return "", "", "", fmt.Errorf("fetch userinfo: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", "", "", nil
	}

	var data struct {
		Name           string `json:"name"`
		Username       string `json:"username"`
		Email          string `json:"email"`
		OrganizationID string `json:"organization_id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return "", "", "", nil
	}

	name := data.Name
	if name == "" {
		name = data.Username
	}

	return name, data.Email, data.OrganizationID, nil
}

// parseExpiry converts expiry hints to Unix milliseconds.
func parseExpiry(expiresAt int64, expiresInSeconds int) int64 {
	if expiresAt > 0 {
		return expiresAt
	}
	if expiresInSeconds >= 0 {
		return time.Now().UnixMilli() + int64(expiresInSeconds)*1000
	}
	// Default: 30 days
	return time.Now().UnixMilli() + 30*24*60*60*1000
}

// Authenticate is not supported in server context for Qoder.
func (s *QoderService) Authenticate(ctx context.Context, client HTTPClient) (*TokenResponse, error) {
	return nil, fmt.Errorf("qoder: use device token flow")
}

// Refresh is not supported for Qoder device tokens.
func (s *QoderService) Refresh(ctx context.Context, client HTTPClient, refreshToken string) (*TokenResponse, error) {
	return nil, fmt.Errorf("qoder: refresh not supported, re-login required")
}

// parseExpiryFromAny handles various expiry formats.
func parseExpiryFromAny(expiresAt interface{}, expiresInSeconds int) int64 {
	switch v := expiresAt.(type) {
	case int64:
		if v > 0 {
			return v
		}
	case float64:
		if v > 0 {
			return int64(v)
		}
	case string:
		if v == "" {
			break
		}
		// Try numeric string
		if ms, err := strconv.ParseInt(v, 10, 64); err == nil && ms > 0 {
			return ms
		}
		// Try RFC3339
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			return t.UnixMilli()
		}
	}

	if expiresInSeconds >= 0 {
		return time.Now().UnixMilli() + int64(expiresInSeconds)*1000
	}

	return time.Now().UnixMilli() + 30*24*60*60*1000
}

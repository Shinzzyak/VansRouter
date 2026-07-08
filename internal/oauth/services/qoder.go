package services

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
	"strings"
	"time"
)

// QoderService implements the Qoder device-token OAuth flow.
// Source: src/lib/oauth/services/qoder.js
//
// Flow: generate PKCE → open browser → poll for device token → fetch user info.
// Tokens live ~30 days. Refresh is a no-op (upstream returns 403).
// Users re-run login when expired.

const (
	qoderLoginURL       = "https://qoder.com/device/selectAccounts"
	qoderDeviceTokenURL = "https://openapi.qoder.sh/api/v1/deviceToken/poll"
	qoderUserInfoURL    = "https://openapi.qoder.sh/api/v1/userinfo"
	qoderFetchTimeout   = 15 * time.Second
)

// QoderPKCEPair holds a PKCE verifier/challenge pair.
type QoderPKCEPair struct {
	Verifier  string
	Challenge string
}

// QoderDeviceFlowResult holds the result of initiating device flow.
type QoderDeviceFlowResult struct {
	VerificationURIComplete string
	CodeVerifier            string
	Nonce                   string
	MachineID               string
}

// QoderPollResult holds the result of a single poll attempt.
type QoderPollResult struct {
	Status      string // "pending" or "ok"
	AccessToken string
	RefreshToken string
	UserID      string
	ExpireTime  int64  // Unix milliseconds
}

// QoderUserInfo holds profile info for a token.
type QoderUserInfo struct {
	Name           string
	Email          string
	OrganizationID string
}

// QoderService handles Qoder OAuth operations.
type QoderService struct {
	HTTPClient *http.Client
}

// NewQoderService creates a new QoderService.
func NewQoderService(client *http.Client) *QoderService {
	if client == nil {
		client = http.DefaultClient
		client.Timeout = qoderFetchTimeout
	}
	return &QoderService{HTTPClient: client}
}

// base64URLEncode encodes bytes using base64url (no padding).
func base64URLEncode(data []byte) string {
	return base64.RawURLEncoding.EncodeToString(data)
}

// GeneratePKCEPair generates a PKCE verifier + S256 challenge pair.
// Uses 32 random bytes (matches qodercli/Veria).
func (s *QoderService) GeneratePKCEPair() (*QoderPKCEPair, error) {
	verifierBytes := make([]byte, 32)
	if _, err := rand.Read(verifierBytes); err != nil {
		return nil, fmt.Errorf("generate verifier: %w", err)
	}
	verifier := base64URLEncode(verifierBytes)

	hash := sha256.Sum256([]byte(verifier))
	challenge := base64URLEncode(hash[:])

	return &QoderPKCEPair{
		Verifier:  verifier,
		Challenge: challenge,
	}, nil
}

// InitiateDeviceFlow starts the device flow. Returns the URL to open in a browser
// plus the verifier/nonce/machineId needed to poll.
func (s *QoderService) InitiateDeviceFlow() (*QoderDeviceFlowResult, error) {
	pair, err := s.GeneratePKCEPair()
	if err != nil {
		return nil, err
	}

	nonce, err := randomUUID()
	if err != nil {
		return nil, fmt.Errorf("generate nonce: %w", err)
	}

	machineID, err := randomUUID()
	if err != nil {
		return nil, fmt.Errorf("generate machine ID: %w", err)
	}

	params := fmt.Sprintf("challenge=%s&challenge_method=S256&machine_id=%s&nonce=%s",
		pair.Challenge, machineID, nonce)

	return &QoderDeviceFlowResult{
		VerificationURIComplete: qoderLoginURL + "?" + params,
		CodeVerifier:            pair.Verifier,
		Nonce:                   nonce,
		MachineID:               machineID,
	}, nil
}

// PollDeviceToken performs a single poll attempt.
// Returns QoderPollResult with Status="pending" or Status="ok".
func (s *QoderService) PollDeviceToken(ctx context.Context, nonce, codeVerifier string) (*QoderPollResult, error) {
	if nonce == "" || codeVerifier == "" {
		return nil, fmt.Errorf("missing nonce or code verifier")
	}

	url := fmt.Sprintf("%s?nonce=%s&verifier=%s&challenge_method=S256",
		qoderDeviceTokenURL,
		nonce,
		codeVerifier)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("build poll request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Go-http-client/2.0")

	resp, err := s.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("poll request: %w", err)
	}
	defer resp.Body.Close()

	// 202 and 404 mean "keep polling"
	if resp.StatusCode == 202 || resp.StatusCode == 404 {
		return &QoderPollResult{Status: "pending"}, nil
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read poll response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var errBody struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(body, &errBody) == nil && errBody.Message != "" {
			return nil, fmt.Errorf("poll failed: %s", errBody.Message)
		}
		return nil, fmt.Errorf("poll failed: HTTP %d", resp.StatusCode)
	}

	var data struct {
		Token        string `json:"token"`
		RefreshToken string `json:"refresh_token"`
		UserID       string `json:"user_id"`
		ExpiresAt    interface{} `json:"expires_at"`
		ExpiresIn    interface{} `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &data); err != nil {
		return nil, fmt.Errorf("invalid JSON response: %w", err)
	}

	if data.Token == "" {
		return nil, fmt.Errorf("poll returned 200 but no token")
	}

	expireTime := ParseExpiry(data.ExpiresAt, data.ExpiresIn)

	return &QoderPollResult{
		Status:       "ok",
		AccessToken:  data.Token,
		RefreshToken: data.RefreshToken,
		UserID:       data.UserID,
		ExpireTime:   expireTime,
	}, nil
}

// FetchUserInfo fetches profile info for a token. Best-effort — failures return empty strings.
func (s *QoderService) FetchUserInfo(ctx context.Context, accessToken string) *QoderUserInfo {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, qoderUserInfoURL, nil)
	if err != nil {
		return &QoderUserInfo{}
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Go-http-client/2.0")

	resp, err := s.HTTPClient.Do(req)
	if err != nil {
		return &QoderUserInfo{}
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &QoderUserInfo{}
	}

	var body struct {
		Name           string `json:"name"`
		Username       string `json:"username"`
		Email          string `json:"email"`
		OrganizationID string `json:"organization_id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return &QoderUserInfo{}
	}

	name := strings.TrimSpace(body.Name)
	if name == "" {
		name = strings.TrimSpace(body.Username)
	}

	return &QoderUserInfo{
		Name:           name,
		Email:          strings.TrimSpace(body.Email),
		OrganizationID: strings.TrimSpace(body.OrganizationID),
	}
}

// ParseExpiry converts the upstream's expiry hint into a Unix-millisecond timestamp.
// Accepts: numeric (ms-epoch), numeric string, RFC3339 string, or seconds-from-now.
// Falls back to "now + 30 days" when both are missing.
func ParseExpiry(expiresAt, expiresInSeconds interface{}) int64 {
	// Try numeric expiresAt
	switch v := expiresAt.(type) {
	case float64:
		if v > 0 {
			return int64(v)
		}
	case string:
		trimmed := strings.TrimSpace(v)
		if trimmed != "" {
			// Pure numeric string → ms-epoch
			if isNumeric(trimmed) {
				if ms, err := strconv.ParseInt(trimmed, 10, 64); err == nil && ms > 0 {
					return ms
				}
			}
			// Try RFC3339
			if parsed, err := time.Parse(time.RFC3339, trimmed); err == nil {
				return parsed.UnixMilli()
			}
		}
	}

	// Try expiresInSeconds
	switch v := expiresInSeconds.(type) {
	case float64:
		if v >= 0 {
			return time.Now().UnixMilli() + int64(v*1000)
		}
	case string:
		if isNumeric(v) {
			if secs, err := strconv.ParseInt(v, 10, 64); err == nil && secs >= 0 {
				return time.Now().UnixMilli() + secs*1000
			}
		}
	}

	// Fallback: 30 days
	return time.Now().UnixMilli() + 30*24*60*60*1000
}

// isNumeric checks if a string is all digits.
func isNumeric(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// randomUUID generates a v4 UUID string.
func randomUUID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40 // Version 4
	b[8] = (b[8] & 0x3f) | 0x80 // Variant 10
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

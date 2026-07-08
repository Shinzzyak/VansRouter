package providers

import (
	"context"
	"encoding/base64"
	"fmt"
	"regexp"
	"runtime"
	"time"

	"github.com/9router/9router/internal/oauth"
)

// CursorService implements Cursor IDE OAuth via token import from local SQLite.
// Cursor does not use a standard OAuth flow — users import tokens from
// their Cursor IDE's state.vscdb database.
type CursorService struct {
	provider oauth.Provider
}

// NewCursorService creates a Cursor OAuth service.
func NewCursorService() *CursorService {
	p, _ := oauth.GetProvider("cursor")
	return &CursorService{provider: p}
}

func (s *CursorService) Name() string              { return "cursor" }
func (s *CursorService) GetProvider() oauth.Provider { return s.provider }

// GenerateChecksum creates the jyh cipher checksum for Cursor API headers.
// Algorithm: XOR timestamp bytes with rolling key (initial 165), base64 encode.
// Format: {encoded_timestamp},{machineId}
func (s *CursorService) GenerateChecksum(machineID string) string {
	timestamp := fmt.Sprintf("%d", time.Now().Unix())
	key := byte(165)
	encoded := make([]byte, len(timestamp))

	for i := 0; i < len(timestamp); i++ {
		charCode := timestamp[i]
		encoded[i] = charCode ^ key
		key = key + charCode
	}

	b64 := base64.StdEncoding.EncodeToString(encoded)
	return fmt.Sprintf("%s,%s", b64, machineID)
}

// DetectOS returns the OS string for Cursor API headers.
func (s *CursorService) DetectOS() string {
	switch runtime.GOOS {
	case "darwin":
		return "macos"
	case "windows":
		return "windows"
	default:
		return "linux"
	}
}

// DetectArch returns the architecture string for Cursor API headers.
func (s *CursorService) DetectArch() string {
	switch runtime.GOARCH {
	case "amd64":
		return "x86_64"
	case "arm64":
		return "aarch64"
	default:
		return runtime.GOARCH
	}
}

// BuildHeaders constructs the HTTP headers for Cursor API requests.
func (s *CursorService) BuildHeaders(accessToken, machineID string, ghostMode bool) map[string]string {
	checksum := s.GenerateChecksum(machineID)
	ghost := "false"
	if ghostMode {
		ghost = "true"
	}

	return map[string]string{
		"Authorization":                 fmt.Sprintf("Bearer %s", accessToken),
		"Content-Type":                  "application/connect+proto",
		"Connect-Protocol-Version":      "1",
		"x-cursor-client-version":       "0.40.0",
		"x-cursor-client-type":          "ide",
		"x-cursor-client-os":            s.DetectOS(),
		"x-cursor-client-arch":          s.DetectArch(),
		"x-cursor-client-device-type":   "desktop",
		"x-cursor-checksum":             checksum,
		"x-ghost-mode":                  ghost,
	}
}

// ValidateImportToken validates a Cursor IDE import token.
// Returns token info or error. Does not make API calls since Cursor uses
// complex protobuf format — validation happens when the token is actually used.
func (s *CursorService) ValidateImportToken(accessToken, machineID string) (map[string]interface{}, error) {
	if accessToken == "" {
		return nil, fmt.Errorf("access token is required")
	}
	if machineID == "" {
		return nil, fmt.Errorf("machine ID is required")
	}
	if len(accessToken) < 50 {
		return nil, fmt.Errorf("invalid token format: token appears too short")
	}

	uuidRegex := regexp.MustCompile(`(?i)^[a-f0-9-]{32,}$`)
	cleaned := regexp.MustCompile(`-`).ReplaceAllString(machineID, "")
	if !uuidRegex.MatchString(cleaned) {
		return nil, fmt.Errorf("invalid machine ID format: expected UUID format")
	}

	return map[string]interface{}{
		"accessToken": accessToken,
		"machineId":   machineID,
		"expiresIn":   86400,
		"authMethod":  "imported",
	}, nil
}

// Authenticate is not supported in server context for Cursor.
func (s *CursorService) Authenticate(ctx context.Context, client HTTPClient) (*TokenResponse, error) {
	return nil, fmt.Errorf("cursor: use ValidateImportToken instead")
}

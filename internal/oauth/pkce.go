package oauth

import (
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"math/rand"
)

// PKCE holds a generated code verifier, challenge, and state.
type PKCE struct {
	CodeVerifier  string
	CodeChallenge string
	State         string
}

// GeneratePKCE returns a new PKCE pair using S256.
func GeneratePKCE(verifierBytes int) (*PKCE, error) {
	if verifierBytes < 32 {
		verifierBytes = 32
	}
	verifier, err := generateCodeVerifier(verifierBytes)
	if err != nil {
		return nil, err
	}
	return &PKCE{
		CodeVerifier:  verifier,
		CodeChallenge: GenerateCodeChallenge(verifier),
		State:         generateState(),
	}, nil
}

func generateCodeVerifier(bytes int) (string, error) {
	b := make([]byte, bytes)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("rand read: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// GenerateCodeChallenge returns the S256 challenge for a verifier.
func GenerateCodeChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func generateState() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		// Fallback to deterministic random string.
		for i := range b {
			b[i] = byte(rand.Intn(256))
		}
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

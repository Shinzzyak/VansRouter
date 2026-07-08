package providers

import (
	"testing"
)

func TestCodexService_Name(t *testing.T) {
	svc := NewCodexService()
	if svc.Name() != "codex" {
		t.Errorf("expected name 'codex', got %s", svc.Name())
	}
}

func TestCodexService_GetProvider(t *testing.T) {
	svc := NewCodexService()
	provider := svc.GetProvider()
	if provider.ClientID != "codex-cli" {
		t.Errorf("expected client ID 'codex-cli', got %s", provider.ClientID)
	}
}

func TestCursorService_Name(t *testing.T) {
	svc := NewCursorService()
	if svc.Name() != "cursor" {
		t.Errorf("expected name 'cursor', got %s", svc.Name())
	}
}

func TestCursorService_GenerateChecksum(t *testing.T) {
	svc := NewCursorService()
	machineID := "test-machine-id"
	checksum := svc.GenerateChecksum(machineID)
	if checksum == "" {
		t.Error("checksum should not be empty")
	}
}

func TestKiroService_Name(t *testing.T) {
	svc := NewKiroService()
	if svc.Name() != "kiro" {
		t.Errorf("expected name 'kiro', got %s", svc.Name())
	}
}

func TestKiroService_ValidateAwsRegion(t *testing.T) {
	tests := []struct {
		region  string
		isValid bool
	}{
		{"us-east-1", true},
		{"us-west-2", true},
		{"eu-west-1", true},
		{"invalid", false},
		{"us-east", false},
	}

	for _, tt := range tests {
		err := ValidateAwsRegion(tt.region)
		if tt.isValid && err != nil {
			t.Errorf("region %s should be valid, got error: %v", tt.region, err)
		}
		if !tt.isValid && err == nil {
			t.Errorf("region %s should be invalid", tt.region)
		}
	}
}

func TestQoderService_Name(t *testing.T) {
	svc := NewQoderService()
	if svc.Name() != "qoder" {
		t.Errorf("expected name 'qoder', got %s", svc.Name())
	}
}

func TestQoderService_GeneratePKCE(t *testing.T) {
	svc := NewQoderService()
	verifier, challenge, err := svc.GeneratePKCE()
	if err != nil {
		t.Fatalf("GeneratePKCE failed: %v", err)
	}
	if verifier == "" {
		t.Error("verifier should not be empty")
	}
	if challenge == "" {
		t.Error("challenge should not be empty")
	}
}

func TestXaiService_Name(t *testing.T) {
	svc := NewXaiService()
	if svc.Name() != "xai" {
		t.Errorf("expected name 'xai', got %s", svc.Name())
	}
}

func TestXaiService_ValidateOAuthEndpoint(t *testing.T) {
	tests := []struct {
		url     string
		field   string
		isValid bool
	}{
		{"https://auth.x.ai/oauth2/authorize", "auth", true},
		{"https://api.x.ai/v1", "api", true},
		{"http://auth.x.ai/oauth2/authorize", "auth", false},
		{"https://evil.com/oauth", "auth", false},
		{"", "auth", false},
	}

	for _, tt := range tests {
		_, err := ValidateOAuthEndpoint(tt.url, tt.field)
		if tt.isValid && err != nil {
			t.Errorf("URL %s should be valid, got error: %v", tt.url, err)
		}
		if !tt.isValid && err == nil {
			t.Errorf("URL %s should be invalid", tt.url)
		}
	}
}

func TestExtractEmailFromJWT(t *testing.T) {
	// This is a simplified test - real JWT would be properly encoded
	email := ExtractEmailFromJWT("")
	if email != "" {
		t.Error("empty token should return empty email")
	}

	email = ExtractEmailFromJWT("not.a.jwt")
	if email != "" {
		t.Error("invalid JWT should return empty email")
	}
}

func TestDecodeIdTokenEmail(t *testing.T) {
	email := DecodeIdTokenEmail("")
	if email != "" {
		t.Error("empty token should return empty email")
	}

	email = DecodeIdTokenEmail("not.a.jwt")
	if email != "" {
		t.Error("invalid JWT should return empty email")
	}
}

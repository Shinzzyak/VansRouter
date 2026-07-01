package executors

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSpecialExecutors_Registry_Azure(t *testing.T) {
	ex := Get("azure", &ProviderConfig{})
	_, ok := ex.(*AzureExecutor)
	assert.True(t, ok, "expected *AzureExecutor, got %T", ex)
}

func TestSpecialExecutors_Registry_DefaultFallback(t *testing.T) {
	ex := Get("unknown-provider", &ProviderConfig{})
	_, ok := ex.(*DefaultExecutor)
	assert.True(t, ok, "expected *DefaultExecutor, got %T", ex)
}

func TestSpecialExecutors_AzureURL(t *testing.T) {
	ex := NewAzureExecutor("azure", &ProviderConfig{})
	url := ex.BuildURL("gpt-4o", true, 0, Credentials{
		ProviderSpecificData: map[string]any{
			"azureEndpoint": "https://x.openai.azure.com",
			"apiVersion":    "2025-01-01",
			"deployment":    "dep1",
		},
	})
	assert.Equal(t, "https://x.openai.azure.com/openai/deployments/dep1/chat/completions?api-version=2025-01-01", url)
}

func TestSpecialExecutors_AzureApiKeyHeader(t *testing.T) {
	ex := NewAzureExecutor("azure", &ProviderConfig{})
	h := ex.BuildHeaders(Credentials{APIKey: "sk-az"}, true)
	assert.Equal(t, "sk-az", h.Get("api-key"))
	assert.Empty(t, h.Get("Authorization"))
	assert.Equal(t, "text/event-stream", h.Get("Accept"))
}

func TestSpecialExecutors_OllamaLocalHost(t *testing.T) {
	ex := NewOllamaLocalExecutor("ollama-local", &ProviderConfig{})
	url := ex.BuildURL("", false, 0, Credentials{
		ProviderSpecificData: map[string]any{"ollamaHost": "http://localhost:11435"},
	})
	assert.Equal(t, "http://localhost:11435/api/chat", url)
}

func TestSpecialExecutors_GithubEndpointAndBearer(t *testing.T) {
	ex := NewGithubExecutor("github", &ProviderConfig{})
	url := ex.BuildURL("gpt-4o", true, 0, Credentials{})
	assert.Equal(t, "https://models.inference.ai.azure.com/chat/completions", url)

	h := ex.BuildHeaders(Credentials{APIKey: "ghp_xxx"}, true)
	assert.Equal(t, "Bearer ghp_xxx", h.Get("Authorization"))
	assert.Equal(t, "text/event-stream", h.Get("Accept"))
}

func TestSpecialExecutors_VertexGeminiURL(t *testing.T) {
	ex := NewVertexExecutor("vertex", &ProviderConfig{})
	url := ex.BuildURL("gemini-1.5-pro", true, 0, Credentials{
		ProviderSpecificData: map[string]any{
			"projectId": "proj-123",
			"location":  "europe-west4",
		},
	})
	assert.Equal(t, "https://aiplatform.googleapis.com/v1/projects/proj-123/locations/europe-west4/publishers/google/models/gemini-1.5-pro:streamGenerateContent?alt=sse", url)
}

func TestSpecialExecutors_VertexPartnerURL(t *testing.T) {
	ex := NewVertexExecutor("vertex-partner", &ProviderConfig{})
	url := ex.BuildURL("llama", false, 0, Credentials{
		ProviderSpecificData: map[string]any{"projectId": "proj-abc"},
	})
	assert.Equal(t, "https://aiplatform.googleapis.com/v1/projects/proj-abc/locations/global/endpoints/openapi/chat/completions", url)
}

func TestSpecialExecutors_VertexPartnerRequiresProjectID(t *testing.T) {
	ex := NewVertexExecutor("vertex-partner", &ProviderConfig{})
	_, err := ex.Execute(context.Background(), ExecuteRequest{
		Model:       "llama",
		Body:        map[string]any{},
		Credentials: Credentials{ProviderSpecificData: map[string]any{}},
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "project_id")
}

func TestSpecialExecutors_CodexResponsesEndpoint(t *testing.T) {
	ex := NewCodexExecutor("codex", &ProviderConfig{})
	url := ex.BuildURL("o4-mini", false, 0, Credentials{})
	assert.Equal(t, "https://api.openai.com/v1/responses", url)
}

func TestSpecialExecutors_CodexHeaders(t *testing.T) {
	ex := NewCodexExecutor("codex", &ProviderConfig{})
	h := ex.BuildHeaders(Credentials{APIKey: "sk-codex"}, false)
	assert.Equal(t, "Bearer sk-codex", h.Get("Authorization"))
	assert.Equal(t, "codex_cli_rs", h.Get("originator"))
	assert.Equal(t, "default", h.Get("session_id"))
}

package executors

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
)

// VertexExecutor handles Google Cloud Vertex AI requests for Gemini and
// Vertex partner (OpenAI-compatible) models.
type VertexExecutor struct {
	BaseExecutor
}

// NewVertexExecutor creates a Vertex executor.
func NewVertexExecutor(provider string, cfg *ProviderConfig) *VertexExecutor {
	return &VertexExecutor{BaseExecutor: *NewBaseExecutor(provider, cfg)}
}

// BuildURL constructs the appropriate Vertex AI URL.
func (ex *VertexExecutor) BuildURL(model string, stream bool, urlIndex int, creds Credentials) string {
	psd := creds.ProviderSpecificData

	if ex.provider == "vertex-partner" {
		projectID, _ := psd["projectId"].(string)
		if projectID == "" {
			projectID = os.Getenv("VERTEX_PROJECT_ID")
		}
		// ponytail: auto-resolve projectId from raw API key on first 404, like JS.
		if projectID == "" {
			// Fall back to an empty path so execute() surfaces the required error.
		}
		return fmt.Sprintf("https://aiplatform.googleapis.com/v1/projects/%s/locations/global/endpoints/openapi/chat/completions", projectID)
	}

	projectID, _ := psd["projectId"].(string)
	if projectID == "" {
		projectID = os.Getenv("VERTEX_PROJECT_ID")
	}
	location := "us-central1"
	if v, _ := psd["location"].(string); v != "" {
		location = v
	} else if v := os.Getenv("VERTEX_LOCATION"); v != "" {
		location = v
	}

	action := "generateContent"
	if stream {
		action = "streamGenerateContent?alt=sse"
	}
	return fmt.Sprintf("https://aiplatform.googleapis.com/v1/projects/%s/locations/%s/publishers/google/models/%s:%s", projectID, location, model, action)
}

// BuildHeaders sets Vertex headers; Bearer auth is only applied when a
// pre-resolved access token is present.
func (ex *VertexExecutor) BuildHeaders(creds Credentials, stream bool) http.Header {
	h := make(http.Header)
	h.Set("Content-Type", "application/json")

	for k, v := range ex.config.Headers {
		h.Set(k, v)
	}

	if creds.AccessToken != "" {
		h.Set("Authorization", "Bearer "+creds.AccessToken)
	}

	if stream {
		h.Set("Accept", "text/event-stream")
	}
	return h
}

// Execute forwards to the base executor after validating required Vertex fields.
// ponytail: SA JSON token minting and ADC refresh are deferred to Step 3.
func (ex *VertexExecutor) Execute(ctx context.Context, req ExecuteRequest) (*http.Response, error) {
	if ex.provider == "vertex-partner" {
		projectID, _ := req.Credentials.ProviderSpecificData["projectId"].(string)
		if projectID == "" {
			projectID = os.Getenv("VERTEX_PROJECT_ID")
		}
		if projectID == "" {
			return nil, errors.New("vertex partner models require a project_id; add it in providerSpecificData or set VERTEX_PROJECT_ID")
		}
	}
	return ex.BaseExecutor.Execute(ctx, req)
}

func init() {
	Register("vertex", func(provider string, cfg *ProviderConfig) Executor {
		return NewVertexExecutor(provider, cfg)
	})
	Register("vertex-partner", func(provider string, cfg *ProviderConfig) Executor {
		return NewVertexExecutor(provider, cfg)
	})
}

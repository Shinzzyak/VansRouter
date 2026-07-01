package executors

import (
	"net/http"
	"strings"
)

// CodexExecutor targets the OpenAI Codex /responses endpoint.
type CodexExecutor struct {
	BaseExecutor
}

// NewCodexExecutor creates a Codex executor.
func NewCodexExecutor(provider string, cfg *ProviderConfig) *CodexExecutor {
	return &CodexExecutor{BaseExecutor: *NewBaseExecutor(provider, cfg)}
}

// BuildURL returns the OpenAI Codex responses endpoint.
func (ex *CodexExecutor) BuildURL(model string, stream bool, urlIndex int, creds Credentials) string {
	if url := ex.BaseExecutor.BuildURL(model, stream, urlIndex, creds); url != "" {
		return url
	}

	baseURL := "https://api.openai.com/v1"
	if b, _ := creds.ProviderSpecificData["baseUrl"].(string); b != "" {
		baseURL = strings.TrimSuffix(b, "/")
	}
	return baseURL + "/responses"
}

// BuildHeaders sets Codex identity headers and Bearer auth.
func (ex *CodexExecutor) BuildHeaders(creds Credentials, stream bool) http.Header {
	h := make(http.Header)
	h.Set("Content-Type", "application/json")

	for k, v := range ex.config.Headers {
		h.Set(k, v)
	}

	if creds.APIKey != "" {
		h.Set("Authorization", "Bearer "+creds.APIKey)
	}

	if sessionID, _ := creds.ProviderSpecificData["sessionId"].(string); sessionID != "" {
		h.Set("session_id", sessionID)
	} else if creds.APIKey != "" {
		h.Set("session_id", "default")
	}

	if h.Get("originator") == "" {
		h.Set("originator", "codex_cli_rs")
	}

	if workspaceID, _ := creds.ProviderSpecificData["workspaceId"].(string); workspaceID != "" {
		h.Set("chatgpt-account-id", workspaceID)
	}

	// ponytail: full Codex request transform, image prefetch, and SSE overload peeking
	// are deferred to later steps.
	return h
}

func init() {
	Register("codex", func(provider string, cfg *ProviderConfig) Executor {
		return NewCodexExecutor(provider, cfg)
	})
}

package executors

import (
	"net/http"
	"os"
)

// GithubExecutor targets GitHub Models inference endpoints.
type GithubExecutor struct {
	BaseExecutor
}

// NewGithubExecutor creates a GitHub executor.
func NewGithubExecutor(provider string, cfg *ProviderConfig) *GithubExecutor {
	return &GithubExecutor{BaseExecutor: *NewBaseExecutor(provider, cfg)}
}

// BuildURL returns the GitHub Models /chat/completions endpoint.
func (ex *GithubExecutor) BuildURL(model string, stream bool, urlIndex int, creds Credentials) string {
	if ex.config.BaseUrl != "" {
		return ex.config.BaseUrl
	}
	return "https://models.inference.ai.azure.com/chat/completions"
}

// BuildHeaders sets GitHub Models auth and optional API version headers.
func (ex *GithubExecutor) BuildHeaders(creds Credentials, stream bool) http.Header {
	h := make(http.Header)
	h.Set("Content-Type", "application/json")

	for k, v := range ex.config.Headers {
		h.Set(k, v)
	}

	token := creds.APIKey
	if token == "" {
		token = os.Getenv("GITHUB_TOKEN")
	}
	if token != "" {
		h.Set("Authorization", "Bearer "+token)
	}

	if v := os.Getenv("GITHUB_API_VERSION"); v != "" {
		h.Set("x-github-api-version", v)
	}

	if stream && !ex.config.PreserveAccept {
		h.Set("Accept", "text/event-stream")
	} else {
		h.Set("Accept", "application/json")
	}
	return h
}

func init() {
	Register("github", func(provider string, cfg *ProviderConfig) Executor {
		return NewGithubExecutor(provider, cfg)
	})
}

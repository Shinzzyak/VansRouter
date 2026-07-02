package executors

import (
	"os"
	"strings"
)

// OllamaLocalExecutor targets a locally running Ollama /api/chat endpoint.
type OllamaLocalExecutor struct {
	BaseExecutor
}

// NewOllamaLocalExecutor creates an Ollama local executor.
func NewOllamaLocalExecutor(provider string, cfg *ProviderConfig) *OllamaLocalExecutor {
	return &OllamaLocalExecutor{BaseExecutor: *NewBaseExecutor(provider, cfg)}
}

// BuildURL returns the Ollama chat endpoint at the configured or default host.
func (ex *OllamaLocalExecutor) BuildURL(model string, stream bool, urlIndex int, creds Credentials) string {
	if url := ex.BaseExecutor.BuildURL(model, stream, urlIndex, creds); url != "" {
		return url
	}

	host := "http://127.0.0.1:11434"
	if v, _ := creds.ProviderSpecificData["ollamaHost"].(string); v != "" {
		host = v
	} else if v, _ := creds.ProviderSpecificData["baseUrl"].(string); v != "" {
		// Mirrors resolveOllamaLocalHost in the JS provider config.
		host = v
	} else if v := os.Getenv("OLLAMA_HOST"); v != "" {
		host = v
	}

	host = strings.TrimSuffix(host, "/")
	return host + "/api/chat"
}

func init() {
	Register("ollama-local", func(provider string, cfg *ProviderConfig) Executor {
		return NewOllamaLocalExecutor(provider, cfg)
	})
}

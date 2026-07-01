package executors

import (
	"net/http"
	"os"
	"strings"
)

// AzureExecutor routes chat requests to Azure OpenAI deployments.
type AzureExecutor struct {
	BaseExecutor
}

// NewAzureExecutor creates an Azure executor.
func NewAzureExecutor(provider string, cfg *ProviderConfig) *AzureExecutor {
	return &AzureExecutor{BaseExecutor: *NewBaseExecutor(provider, cfg)}
}

// BuildURL constructs the Azure OpenAI deployment-scoped endpoint.
func (ex *AzureExecutor) BuildURL(model string, stream bool, urlIndex int, creds Credentials) string {
	if url := ex.BaseExecutor.BuildURL(model, stream, urlIndex, creds); url != "" {
		return url
	}

	psd := creds.ProviderSpecificData

	azureEndpoint := "https://api.openai.com"
	if v, _ := psd["azureEndpoint"].(string); v != "" {
		azureEndpoint = v
	} else if v := os.Getenv("AZURE_ENDPOINT"); v != "" {
		azureEndpoint = v
	}

	apiVersion := "2024-10-01-preview"
	if v, _ := psd["apiVersion"].(string); v != "" {
		apiVersion = v
	} else if v := os.Getenv("AZURE_API_VERSION"); v != "" {
		apiVersion = v
	}

	deployment := "gpt-4"
	if v, _ := psd["deployment"].(string); v != "" {
		deployment = v
	} else if model != "" {
		deployment = model
	} else if v := os.Getenv("AZURE_DEPLOYMENT"); v != "" {
		deployment = v
	}

	endpoint := strings.TrimSuffix(azureEndpoint, "/")
	return endpoint + "/openai/deployments/" + deployment + "/chat/completions?api-version=" + apiVersion
}

// BuildHeaders sets the Azure api-key header and optional OpenAI-Organization.
func (ex *AzureExecutor) BuildHeaders(creds Credentials, stream bool) http.Header {
	h := make(http.Header)
	h.Set("Content-Type", "application/json")

	for k, v := range ex.config.Headers {
		h.Set(k, v)
	}

	apiKey := creds.APIKey
	if apiKey == "" {
		apiKey = creds.AccessToken
	}
	if apiKey == "" {
		apiKey = os.Getenv("OPENAI_API_KEY")
	}
	if apiKey != "" {
		h.Set("api-key", apiKey)
	}

	if org, _ := creds.ProviderSpecificData["organization"].(string); org != "" {
		h.Set("OpenAI-Organization", org)
	} else if v := os.Getenv("AZURE_ORGANIZATION"); v != "" {
		h.Set("OpenAI-Organization", v)
	}

	if stream && !ex.config.PreserveAccept {
		h.Set("Accept", "text/event-stream")
	}
	return h
}

func init() {
	Register("azure", func(provider string, cfg *ProviderConfig) Executor {
		return NewAzureExecutor(provider, cfg)
	})
}

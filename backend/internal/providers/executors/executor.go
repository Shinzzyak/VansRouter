package executors

import (
	"context"
	"net/http"
)

// Execute runs the registered executor for provider with the given config.
// It is the public entry point used by the chat/image/embedding handlers.
func Execute(ctx context.Context, provider string, cfg *ProviderConfig, req ExecuteRequest) (*http.Response, error) {
	ex := Get(provider, cfg)
	return ex.Execute(ctx, req)
}

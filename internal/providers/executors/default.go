package executors

import (
	"context"
	"net/http"
)

// DefaultExecutor handles standard OpenAI-compatible upstream calls.
// Subclasses (Step 2) will override methods for provider-specific auth/transport.
type DefaultExecutor struct {
	BaseExecutor
}

// NewDefaultExecutor creates a DefaultExecutor for provider using the given config.
func NewDefaultExecutor(provider string, cfg *ProviderConfig) *DefaultExecutor {
	return &DefaultExecutor{BaseExecutor: *NewBaseExecutor(provider, cfg)}
}

// Execute forwards to the base executor. It is a separate method so subclasses
// can wrap or replace the retry/fallback behavior.
func (ex *DefaultExecutor) Execute(ctx context.Context, req ExecuteRequest) (*http.Response, error) {
	// ponytail: transient body error retries (_peekTransientBodyError) deferred to Step 2
	return ex.BaseExecutor.Execute(ctx, req)
}

// TransformRequest applies provider-specific request transformations.
// The base implementation returns the body unchanged.
func (ex *DefaultExecutor) TransformRequest(model string, body map[string]any, stream bool, creds Credentials) map[string]any {
	// ponytail: json_schema fallback, client_metadata drop, nvidia max_tokens clamp deferred to Step 2
	return body
}

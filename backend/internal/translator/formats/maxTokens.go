package formats

import "github.com/9router/9router/backend/internal/translator/concerns"

const (
	DefaultMaxTokens = 64000
	DefaultMinTokens = 32000
)

// AdjustMaxTokens returns a safe max_tokens value for the request body.
func AdjustMaxTokens(body map[string]any) int {
	maxTokens := concerns.IntNumber(body["max_tokens"])
	if maxTokens == 0 {
		maxTokens = DefaultMaxTokens
	}

	if tools, ok := body["tools"].([]any); ok && len(tools) > 0 {
		if maxTokens < DefaultMinTokens {
			maxTokens = DefaultMinTokens
		}
	}

	if thinking, ok := body["thinking"].(map[string]any); ok {
		if budget := concerns.IntNumber(thinking["budget_tokens"]); budget > 0 && maxTokens <= budget {
			maxTokens = budget + 1024
		}
	}

	if maxTokens > DefaultMaxTokens {
		maxTokens = DefaultMaxTokens
	}

	return maxTokens
}

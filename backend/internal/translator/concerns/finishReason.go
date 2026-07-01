package concerns

import "github.com/9router/9router/backend/internal/translator/schema"

// ponytail: full provider-specific finish-reason mapping deferred.
func MapFinishReason(format string, reason string) string {
	if mapped, ok := schema.OpenAIFinishReason[reason]; ok {
		return mapped
	}
	return reason
}

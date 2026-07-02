package concerns

import "github.com/9router/9router/internal/translator/schema"

// ToOpenAIFinish maps a provider-native stop reason to an OpenAI finish reason.
func ToOpenAIFinish(reason, format string) string {
	switch format {
	case "claude":
		if mapped, ok := schema.ClaudeStopReason[reason]; ok {
			return mapped
		}
	case "gemini":
		if mapped, ok := schema.GeminiFinishReason[reason]; ok {
			return mapped
		}
	}
	if mapped, ok := schema.OpenAIFinishReason[reason]; ok {
		return mapped
	}
	return reason
}

// ponytail: reverse-map lookups are O(n); precompute reverse maps in schema/ to avoid scanning on every call.
// FromOpenAIFinish maps an OpenAI finish reason to a provider-native stop reason.
func FromOpenAIFinish(reason, format string) string {
	switch format {
	case "claude":
		for native, openai := range schema.ClaudeStopReason {
			if openai == reason {
				return native
			}
		}
	case "gemini":
		for native, openai := range schema.GeminiFinishReason {
			if openai == reason {
				return native
			}
		}
	}
	return reason
}

// MapFinishReason is a thin alias around ToOpenAIFinish.
func MapFinishReason(format, reason string) string {
	return ToOpenAIFinish(reason, format)
}

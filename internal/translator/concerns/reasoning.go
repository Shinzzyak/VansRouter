package concerns

import "strings"

// NormalizeReasoning returns the chunk unchanged; deep normalization deferred.
func NormalizeReasoning(chunk map[string]any) map[string]any {
	return chunk
}

// ExtractReasoningText pulls reasoning text from OpenAI-style deltas across providers.
func ExtractReasoningText(delta map[string]any) string {
	for _, key := range []string{"reasoning_content", "reasoning", "reasoning_text", "thinking"} {
		if v, ok := delta[key].(string); ok && strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

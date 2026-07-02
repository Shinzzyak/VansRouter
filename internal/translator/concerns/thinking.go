package concerns

// Legacy aliases kept for backwards compatibility.
// ponytail: remove once all callers migrate to thinking_unified.go.

func CaptureThinking(chunk map[string]any) map[string]any {
	return chunk
}

func ApplyThinking(body map[string]any, thinking map[string]any) map[string]any {
	return body
}

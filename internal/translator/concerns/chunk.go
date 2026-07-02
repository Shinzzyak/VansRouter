package concerns

// BuildChunk constructs an OpenAI-style SSE chunk.
func BuildChunk(meta map[string]any, delta map[string]any, finishReason string) map[string]any {
	id := ""
	if v, ok := meta["id"].(string); ok {
		id = v
	}
	created := 0
	if v, ok := meta["created"].(int); ok {
		created = v
	}
	model := ""
	if v, ok := meta["model"].(string); ok {
		model = v
	}

	choice := map[string]any{
		"index": 0,
		"delta": delta,
	}
	if finishReason != "" {
		choice["finish_reason"] = finishReason
	} else {
		choice["finish_reason"] = nil
	}

	return map[string]any{
		"id":      id,
		"object":  "chat.completion.chunk",
		"created": created,
		"model":   model,
		"choices": []map[string]any{choice},
	}
}

// BuildClaudeChunk constructs a Claude-style SSE chunk.
func BuildClaudeChunk(chunkType string, payload map[string]any) map[string]any {
	out := map[string]any{"type": chunkType}
	for k, v := range payload {
		out[k] = v
	}
	return out
}

// SplitChunk is a no-op passthrough; real chunk-splitting deferred.
func SplitChunk(format string, chunk map[string]any) []map[string]any {
	return []map[string]any{chunk}
}

// ReasoningDelta returns an OpenAI delta shape for reasoning content.
func ReasoningDelta(text string) map[string]any {
	return map[string]any{
		"content":                    "", // clients may ignore empty content
		"reasoning_content":          text,
		"reasoning":                  text,
		"reasoning_type":             "token",
	}
}

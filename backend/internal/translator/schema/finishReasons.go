package schema

var (
	OpenAIFinishReason = map[string]string{
		"stop":          "stop",
		"length":        "length",
		"tool_calls":    "tool_calls",
		"content_filter": "content_filter",
		"function_call": "function_call",
	}

	ClaudeStopReason = map[string]string{
		"end_turn":        "stop",
		"max_tokens":      "length",
		"stop_sequence":   "stop",
		"tool_use":        "tool_calls",
		"content_filter":  "content_filter",
	}

	GeminiFinishReason = map[string]string{
		"STOP":                 "stop",
		"MAX_TOKENS":           "length",
		"SAFETY":               "content_filter",
		"RECITATION":           "content_filter",
		"OTHER":                "stop",
		"FINISH_REASON_UNSPECIFIED": "stop",
	}
)

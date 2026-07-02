package schema

var (
	ModelFallback = map[string]string{
		"claude":  "claude-sonnet-4-20250514",
		"openai":  "gpt-4o",
		"gemini":  "gemini-1.5-pro-latest",
		"vertex":  "gemini-1.5-pro-latest",
		"ollama":  "llama3",
	}

	DefaultImageMIME = "image/png"
)

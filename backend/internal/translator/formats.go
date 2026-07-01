package translator

type Format string

const (
	FormatOpenAI          Format = "openai"
	FormatClaude          Format = "claude"
	FormatGemini          Format = "gemini"
	FormatVertex          Format = "vertex"
	FormatKiro            Format = "kiro"
	FormatCursor          Format = "cursor"
	FormatOllama          Format = "ollama"
	FormatCommandCode     Format = "commandcode"
	FormatAntigravity     Format = "antigravity"
	FormatOpenAIResponses Format = "openai-responses"
)

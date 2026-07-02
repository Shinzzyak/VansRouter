package tokensaver

import (
	"fmt"
	"strings"
)

// Format identifiers mirror open-sse/translator/formats.js.
const (
	FormatOpenAI        = "openai"
	FormatClaude        = "claude"
	FormatGemini        = "gemini"
	FormatGeminiCLI     = "gemini-cli"
	FormatVertex        = "vertex"
	FormatAntigravity   = "antigravity"
	FormatKiro          = "kiro"
	FormatCursor        = "cursor"
	FormatCommandCode   = "commandcode"
	FormatOpenAIResponses = "openai-responses"
)

// promptSeparator is used when appending injected prompts.
const promptSeparator = "\n\n"

// InjectSystemPrompt appends prompt into body according to the target format.
// It mutates body in place. Body is assumed to be a map[string]any.
func InjectSystemPrompt(body map[string]any, format string, prompt string) {
	if body == nil || prompt == "" {
		return
	}
	switch format {
	case FormatClaude:
		injectClaudeSystem(body, prompt)
	case FormatGemini, FormatGeminiCLI, FormatVertex, FormatAntigravity:
		injectGeminiSystem(body, prompt)
	default:
		injectMessagesSystem(body, prompt)
	}
}

func injectMessagesSystem(body map[string]any, prompt string) {
	if instructions, ok := body["instructions"].(string); ok {
		body["instructions"] = joinPrompt(instructions, prompt)
		return
	}
	var arr []any
	if v, ok := body["messages"].([]any); ok {
		arr = v
	} else if v, ok := body["input"].([]any); ok {
		arr = v
	}
	if arr == nil {
		return
	}
	idx := -1
	for i, item := range arr {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		role, _ := m["role"].(string)
		if role == "system" || role == "developer" {
			idx = i
			break
		}
	}
	if idx >= 0 {
		appendToMessage(arr[idx].(map[string]any), prompt)
	} else {
		body["messages"] = append([]any{map[string]any{"role": "system", "content": prompt}}, arr...)
	}
}

func appendToMessage(msg map[string]any, prompt string) {
	if msg == nil {
		return
	}
	switch content := msg["content"].(type) {
	case string:
		msg["content"] = joinPrompt(content, prompt)
	case []any:
		if !hasTextPart(content, prompt) {
			msg["content"] = append(content, map[string]any{"type": "input_text", "text": prompt})
		}
	default:
		msg["content"] = prompt
	}
}

func hasTextPart(parts []any, text string) bool {
	for _, p := range parts {
		part, ok := p.(map[string]any)
		if !ok {
			continue
		}
		t, _ := part["text"].(string)
		if t == text {
			return true
		}
	}
	return false
}

func injectClaudeSystem(body map[string]any, prompt string) {
	switch sys := body["system"].(type) {
	case string:
		body["system"] = joinPrompt(sys, prompt)
	case []any:
		if !hasTextPart(sys, prompt) {
			// Insert before the last cache_control block if present.
			lastCache := -1
			for i := len(sys) - 1; i >= 0; i-- {
				part, ok := sys[i].(map[string]any)
				if ok && part["cache_control"] != nil {
					lastCache = i
					break
				}
			}
			block := map[string]any{"type": "text", "text": prompt}
			if lastCache >= 0 {
				body["system"] = append(sys[:lastCache], append([]any{block}, sys[lastCache:]...)...)
			} else {
				body["system"] = append(sys, block)
			}
		}
	default:
		body["system"] = prompt
	}
}

func injectGeminiSystem(body map[string]any, prompt string) {
	target := body
	if req, ok := body["request"].(map[string]any); ok {
		target = req
	}
	key := "systemInstruction"
	if _, ok := target["system_instruction"]; ok {
		key = "system_instruction"
	}
	sys, _ := target[key].(map[string]any)
	if sys == nil {
		target[key] = map[string]any{"parts": []any{map[string]any{"text": prompt}}}
		return
	}
	parts, _ := sys["parts"].([]any)
	if !hasTextPart(parts, prompt) {
		sys["parts"] = append(parts, map[string]any{"text": prompt})
	}
}

func joinPrompt(existing, prompt string) string {
	if existing == "" {
		return prompt
	}
	if strings.Contains(existing, prompt) {
		return existing
	}
	return fmt.Sprintf("%s%s%s", existing, promptSeparator, prompt)
}

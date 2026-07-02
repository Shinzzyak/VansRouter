package usage

import (
	"encoding/json"
	"math"
)

// ponytail: only the OpenAI/Claude/Gemini/Ollama usage shapes are ported.
// DeepSeek prompt_cache_hit_tokens and provider-specific counters (Qwen,
// MiniMax, etc.) are normalized to the common fields on demand.
const bufferTokens = 2000

// Usage holds normalized token counts in OpenAI-ish shape.
type Usage struct {
	PromptTokens            int            `json:"prompt_tokens,omitempty"`
	CompletionTokens        int            `json:"completion_tokens,omitempty"`
	TotalTokens             int            `json:"total_tokens,omitempty"`
	CachedTokens            int            `json:"cached_tokens,omitempty"`
	ReasoningTokens         int            `json:"reasoning_tokens,omitempty"`
	PromptTokensDetails     map[string]any `json:"prompt_tokens_details,omitempty"`
	CompletionTokensDetails map[string]any `json:"completion_tokens_details,omitempty"`
	Estimated               bool           `json:"estimated,omitempty"`
}

// Normalize returns a sanitized Usage struct. Nil is returned for empty input.
func Normalize(u map[string]any) *Usage {
	if u == nil {
		return nil
	}
	out := &Usage{}
	has := false
	if v := num(u, "prompt_tokens"); v >= 0 {
		out.PromptTokens = v
		has = true
	} else if v := num(u, "input_tokens"); v >= 0 {
		out.PromptTokens = v
		has = true
	}
	if v := num(u, "completion_tokens"); v >= 0 {
		out.CompletionTokens = v
		has = true
	} else if v := num(u, "output_tokens"); v >= 0 {
		out.CompletionTokens = v
		has = true
	}
	if v := num(u, "total_tokens"); v >= 0 {
		out.TotalTokens = v
		has = true
	}
	if v := num(u, "cached_tokens"); v >= 0 {
		out.CachedTokens = v
		has = true
	}
	if v := num(u, "reasoning_tokens"); v >= 0 {
		out.ReasoningTokens = v
		has = true
	}
	if v := anyMap(u, "prompt_tokens_details"); v != nil {
		out.PromptTokensDetails = v
		has = true
	}
	if v := anyMap(u, "completion_tokens_details"); v != nil {
		out.CompletionTokensDetails = v
		has = true
	}
	if !has {
		return nil
	}
	return out
}

// Extract pulls usage information from an upstream response chunk.
func Extract(chunk map[string]any) *Usage {
	if chunk == nil {
		return nil
	}

	// Claude message_delta
	if t, ok := chunk["type"].(string); ok && t == "message_delta" {
		if u, ok := chunk["usage"].(map[string]any); ok {
			return Normalize(map[string]any{
				"prompt_tokens":               u["input_tokens"],
				"completion_tokens":           u["output_tokens"],
				"cache_read_input_tokens":     u["cache_read_input_tokens"],
				"cache_creation_input_tokens": u["cache_creation_input_tokens"],
			})
		}
	}

	// OpenAI Responses API
	if t, ok := chunk["type"].(string); ok && (t == "response.completed" || t == "response.done") {
		if resp, ok := chunk["response"].(map[string]any); ok {
			if u, ok := resp["usage"].(map[string]any); ok {
				return Normalize(map[string]any{
					"prompt_tokens":    u["input_tokens"],
					"completion_tokens": u["output_tokens"],
				})
			}
		}
	}

	// Standard OpenAI / Gemini usageMetadata
	if u, ok := chunk["usage"].(map[string]any); ok {
		return Normalize(u)
	}
	if u, ok := chunk["usageMetadata"].(map[string]any); ok {
		return Normalize(map[string]any{
			"prompt_tokens":     u["promptTokenCount"],
			"completion_tokens": u["candidatesTokenCount"],
			"total_tokens":      u["totalTokenCount"],
			"cached_tokens":     u["cachedContentTokenCount"],
			"reasoning_tokens":  u["thoughtsTokenCount"],
		})
	}
	if resp, ok := chunk["response"].(map[string]any); ok {
		if u, ok := resp["usageMetadata"].(map[string]any); ok {
			return Normalize(map[string]any{
				"prompt_tokens":     u["promptTokenCount"],
				"completion_tokens": u["candidatesTokenCount"],
				"total_tokens":      u["totalTokenCount"],
				"cached_tokens":     u["cachedContentTokenCount"],
				"reasoning_tokens":  u["thoughtsTokenCount"],
			})
		}
	}

	// Ollama
	if done, _ := chunk["done"].(bool); done {
		return Normalize(map[string]any{
			"prompt_tokens":     chunk["prompt_eval_count"],
			"completion_tokens": chunk["eval_count"],
		})
	}

	return nil
}

// EstimateInputTokens approximates input tokens from a request body.
func EstimateInputTokens(body any) int {
	b, err := json.Marshal(body)
	if err != nil {
		return 0
	}
	return int(math.Ceil(float64(len(b)) / 4.0))
}

// EstimateOutputTokens approximates output tokens from content length.
func EstimateOutputTokens(contentLength int) int {
	if contentLength <= 0 {
		return 0
	}
	return int(math.Max(1, math.Floor(float64(contentLength)/4.0)))
}

// AddBuffer adds a safety buffer to usage fields.
func AddBuffer(u *Usage) *Usage {
	if u == nil {
		return nil
	}
	out := *u
	out.PromptTokens += bufferTokens
	out.CompletionTokens += bufferTokens
	if out.TotalTokens > 0 {
		out.TotalTokens += bufferTokens
	} else if out.PromptTokens > 0 || out.CompletionTokens > 0 {
		out.TotalTokens = out.PromptTokens + out.CompletionTokens
	}
	return &out
}

// Estimate returns a fully estimated Usage object.
func Estimate(body any, contentLength int) *Usage {
	return AddBuffer(&Usage{
		PromptTokens:     EstimateInputTokens(body),
		CompletionTokens: EstimateOutputTokens(contentLength),
		TotalTokens:      EstimateInputTokens(body) + EstimateOutputTokens(contentLength),
		Estimated:        true,
	})
}

// HasValidUsage reports whether the usage has any positive token count.
func HasValidUsage(u *Usage) bool {
	if u == nil {
		return false
	}
	return u.PromptTokens > 0 || u.CompletionTokens > 0 || u.TotalTokens > 0
}

func num(m map[string]any, key string) int {
	v, ok := m[key]
	if !ok {
		return -1
	}
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	}
	return -1
}

func anyMap(m map[string]any, key string) map[string]any {
	v, ok := m[key].(map[string]any)
	if ok {
		return v
	}
	return nil
}

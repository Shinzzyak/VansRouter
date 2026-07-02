package engine

import (
	"encoding/json"
	"fmt"
	"strings"
)

// ponytail: Responses API content parts conversion only handles
// function_call/function_call_output/message/reasoning types. The JS port
// also maps refusal, audio, and file-search items — add them when a client
// sends them.
func ResponsesToChatCompletions(body map[string]any) (map[string]any, error) {
	if body == nil {
		return nil, fmt.Errorf("nil body")
	}
	rawInput, ok := body["input"]
	if !ok || rawInput == nil {
		return body, nil
	}
	out := make(map[string]any, len(body))
	for k, v := range body {
		out[k] = v
	}
	out["messages"] = normalizeResponsesInput(rawInput, body["instructions"])
	delete(out, "input")
	delete(out, "instructions")
	delete(out, "include")
	delete(out, "prompt_cache_key")
	delete(out, "store")
	delete(out, "reasoning")
	if _, hasStream := out["stream"]; !hasStream {
		out["stream"] = false
	}
	return out, nil
}

func normalizeResponsesInput(input any, instructions any) []any {
	msgs := []any{}
	if instructions != nil {
		if s, ok := instructions.(string); ok && s != "" {
			msgs = append(msgs, map[string]any{"role": "system", "content": s})
		}
	}
	msgs = append(msgs, normalizeInputItems(input)...)
	return msgs
}

func normalizeInputItems(input any) []any {
	switch v := input.(type) {
	case string:
		text := strings.TrimSpace(v)
		if text == "" {
			text = "..."
		}
		return []any{map[string]any{"role": "user", "content": text}}
	case []any:
		if len(v) == 0 {
			return []any{map[string]any{"role": "user", "content": "..."}}
		}
		var out []any
		var currentAssistant map[string]any
		var pendingResults []any
		for _, item := range v {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			itemType, _ := m["type"].(string)
			if itemType == "" {
				if _, hasRole := m["role"]; hasRole {
					itemType = "message"
				}
			}
			switch itemType {
			case "message":
				if currentAssistant != nil {
					out = append(out, currentAssistant)
					currentAssistant = nil
				}
				if len(pendingResults) > 0 {
					out = append(out, pendingResults...)
					pendingResults = nil
				}
				msg := map[string]any{
					"role":    m["role"],
					"content": m["content"],
				}
				out = append(out, msg)
			case "function_call":
				if currentAssistant == nil {
					currentAssistant = map[string]any{
						"role":       "assistant",
						"content":    nil,
						"tool_calls": []any{},
					}
				}
				name, _ := m["name"].(string)
				if name == "" {
					continue
				}
				calls, _ := currentAssistant["tool_calls"].([]any)
				calls = append(calls, map[string]any{
					"id":   m["call_id"],
					"type": "function",
					"function": map[string]any{
						"name":      name,
						"arguments": m["arguments"],
					},
				})
				currentAssistant["tool_calls"] = calls
			case "function_call_output":
				if currentAssistant != nil {
					out = append(out, currentAssistant)
					currentAssistant = nil
				}
				output := m["output"]
				if output != nil {
					if _, ok := output.(string); !ok {
						b, _ := json.Marshal(output)
						output = string(b)
					}
				}
				pendingResults = append(pendingResults, map[string]any{
					"role":         "tool",
					"tool_call_id": m["call_id"],
					"content":      output,
				})
			}
		}
		if currentAssistant != nil {
			out = append(out, currentAssistant)
		}
		out = append(out, pendingResults...)
		return out
	default:
		return []any{map[string]any{"role": "user", "content": "..."}}
	}
}

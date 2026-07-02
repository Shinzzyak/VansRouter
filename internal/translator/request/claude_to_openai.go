package request

import (
	"strings"

	"github.com/9router/9router/internal/translator"
	"github.com/9router/9router/internal/translator/concerns"
	"github.com/9router/9router/internal/translator/formats"
	"github.com/9router/9router/internal/translator/schema"
)

// ponytail: duplicated []any / []map[string]any branching and type-assertion patterns should move to concerns/ helpers.

func init() {
	translator.Register(string(translator.FormatClaude), string(translator.FormatOpenAI), claudeToOpenAIRequest, nil)
}

func claudeToOpenAIRequest(model string, body map[string]any, stream bool, creds any) (map[string]any, error) {
	result := map[string]any{
		"model":    model,
		"messages": []map[string]any{},
		"stream":   stream,
	}

	if maxTokens, ok := body["max_tokens"].(int); ok && maxTokens > 0 {
		result["max_tokens"] = formats.AdjustMaxTokens(body)
	} else if body["max_tokens"] != nil {
		result["max_tokens"] = formats.AdjustMaxTokens(body)
	}

	if temp, ok := body["temperature"].(float64); ok {
		result["temperature"] = temp
	} else if temp, ok := body["temperature"].(int); ok {
		result["temperature"] = float64(temp)
	}

	var messages []map[string]any

	if system, ok := body["system"]; ok {
		if text := claudeSystemText(system); text != "" {
			messages = append(messages, map[string]any{
				"role":    schema.RoleSystem,
				"content": text,
			})
		}
	}

	if msgs, ok := body["messages"].([]any); ok {
		for _, m := range msgs {
			if msg, ok := m.(map[string]any); ok {
				converted := convertClaudeMessage(msg)
				if converted != nil {
					if arr, ok := converted.([]map[string]any); ok {
						messages = append(messages, arr...)
					} else {
						messages = append(messages, converted.(map[string]any))
					}
				}
			}
		}
	} else if msgs, ok := body["messages"].([]map[string]any); ok {
		for _, msg := range msgs {
			converted := convertClaudeMessage(msg)
			if converted != nil {
				if arr, ok := converted.([]map[string]any); ok {
					messages = append(messages, arr...)
				} else {
					messages = append(messages, converted.(map[string]any))
				}
			}
		}
	}

	messages = concerns.FixMissingToolResponses(messages)
	result["messages"] = messages

	if tools, ok := body["tools"].([]any); ok {
		result["tools"] = convertClaudeTools(tools)
	} else if tools, ok := body["tools"].([]map[string]any); ok {
		result["tools"] = convertClaudeToolsMap(tools)
	}

	if tc, ok := body["tool_choice"]; ok {
		result["tool_choice"] = convertClaudeToolChoice(tc)
	}

	if re, ok := body["reasoning_effort"].(string); ok {
		result["reasoning_effort"] = re
	}
	if thinking, ok := body["thinking"].(map[string]any); ok {
		if effort, ok := thinking["effort"].(string); ok {
			result["reasoning_effort"] = effort
		}
		result["reasoning"] = thinking
	}

	return result, nil
}

func claudeSystemText(system any) string {
	switch v := system.(type) {
	case string:
		return stripAnthropicBillingHeader(v)
	case []any:
		var parts []string
		for _, item := range v {
			if m, ok := item.(map[string]any); ok {
				if text, ok := m["text"].(string); ok {
					parts = append(parts, stripAnthropicBillingHeader(text))
				}
			}
		}
		return strings.Join(parts, "\n")
	case []map[string]any:
		var parts []string
		for _, m := range v {
			if text, ok := m["text"].(string); ok {
				parts = append(parts, stripAnthropicBillingHeader(text))
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

func stripAnthropicBillingHeader(text string) string {
	lines := strings.Split(text, "\n")
	var out []string
	for _, line := range lines {
		if strings.HasPrefix(strings.ToLower(line), "x-anthropic-billing-header:") {
			continue
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

func convertClaudeMessage(msg map[string]any) any {
	role, _ := msg["role"].(string)
	if role == schema.RoleSystem {
		text := systemReminderText(msg["content"])
		if text == "" {
			return nil
		}
		return map[string]any{
			"role":    schema.RoleUser,
			"content": text,
		}
	}

	newRole := schema.RoleAssistant
	if role == schema.RoleUser || role == schema.RoleTool {
		newRole = schema.RoleUser
	}

	content := msg["content"]
	if text, ok := content.(string); ok {
		return map[string]any{"role": newRole, "content": text}
	}

	if arr, ok := content.([]any); ok {
		if len(arr) == 0 {
			return map[string]any{"role": newRole, "content": ""}
		}
		return convertClaudeContentArray(newRole, arr)
	}
	if arr, ok := content.([]map[string]any); ok {
		if len(arr) == 0 {
			return map[string]any{"role": newRole, "content": ""}
		}
		return convertClaudeContentArrayMap(newRole, arr)
	}

	return nil
}

func convertClaudeContentArrayMap(role string, blocks []map[string]any) any {
	var parts []map[string]any
	var toolCalls []map[string]any
	var toolResults []map[string]any

	for _, block := range blocks {
		blockType, _ := block["type"].(string)
		switch blockType {
		case schema.ClaudeBlockTypeText:
			if text, ok := block["text"].(string); ok {
				parts = append(parts, map[string]any{"type": schema.OpenAIBlockTypeText, "text": text})
			}
		case schema.ClaudeBlockTypeImage:
			if source, ok := block["source"].(map[string]any); ok {
				if sourceType, _ := source["type"].(string); sourceType == "base64" {
					mime, _ := source["media_type"].(string)
					data, _ := source["data"].(string)
					parts = append(parts, map[string]any{
						"type": schema.OpenAIBlockTypeImageURL,
						"image_url": map[string]any{
							"url": concerns.EncodeDataUri(mime, data),
						},
					})
				} else if url, ok := source["url"].(string); ok {
					parts = append(parts, map[string]any{
						"type": schema.OpenAIBlockTypeImageURL,
						"image_url": map[string]any{
							"url": url,
						},
					})
				}
			}
		case schema.ClaudeBlockTypeToolUse:
			id, _ := block["id"].(string)
			name, _ := block["name"].(string)
			input := block["input"]
			if input == nil {
				input = map[string]any{}
			}
			toolCalls = append(toolCalls, map[string]any{
				"id":   id,
				"type": schema.OpenAIBlockTypeFunction,
				"function": map[string]any{
					"name":      name,
					"arguments": concerns.MarshalJSON(input),
				},
			})
		case schema.ClaudeBlockTypeToolResult:
			toolUseID, _ := block["tool_use_id"].(string)
			resultContent := claudeToolResultContent(block["content"])
			toolResults = append(toolResults, map[string]any{
				"role":          schema.RoleTool,
				"tool_call_id":  toolUseID,
				"content":       resultContent,
			})
		}
	}

	if len(toolResults) > 0 {
		if len(parts) > 0 {
			return append(toolResults, map[string]any{
				"role":    schema.RoleUser,
				"content": concerns.CollapseTextParts(parts),
			})
		}
		return toolResults
	}

	if len(toolCalls) > 0 {
		result := map[string]any{"role": schema.RoleAssistant}
		if len(parts) > 0 {
			result["content"] = concerns.CollapseTextParts(parts)
		}
		result["tool_calls"] = toolCalls
		return result
	}

	if len(parts) > 0 {
		return map[string]any{
			"role":    role,
			"content": concerns.CollapseTextParts(parts),
		}
	}

	return map[string]any{"role": role, "content": ""}
}

func convertClaudeContentArray(role string, blocks []any) any {
	arr := make([]map[string]any, 0, len(blocks))
	for _, b := range blocks {
		if m, ok := b.(map[string]any); ok {
			arr = append(arr, m)
		}
	}
	return convertClaudeContentArrayMap(role, arr)
}

func claudeToolResultContent(content any) string {
	switch v := content.(type) {
	case string:
		return v
	case []any:
		var texts []string
		for _, item := range v {
			if m, ok := item.(map[string]any); ok && m["type"] == schema.ClaudeBlockTypeText {
				if text, ok := m["text"].(string); ok {
					texts = append(texts, text)
				}
			}
		}
		if len(texts) > 0 {
			return strings.Join(texts, "\n")
		}
		return concerns.MarshalJSON(v)
	case []map[string]any:
		var texts []string
		for _, m := range v {
			if m["type"] == schema.ClaudeBlockTypeText {
				if text, ok := m["text"].(string); ok {
					texts = append(texts, text)
				}
			}
		}
		if len(texts) > 0 {
			return strings.Join(texts, "\n")
		}
		return concerns.MarshalJSON(v)
	case map[string]any:
		return concerns.MarshalJSON(v)
	}
	return ""
}

func systemReminderText(content any) string {
	var parts []string
	switch v := content.(type) {
	case string:
		parts = []string{v}
	case []any:
		for _, item := range v {
			if m, ok := item.(map[string]any); ok && m["type"] == schema.ClaudeBlockTypeText {
				if text, ok := m["text"].(string); ok {
					parts = append(parts, text)
				}
			}
		}
	case []map[string]any:
		for _, m := range v {
			if m["type"] == schema.ClaudeBlockTypeText {
				if text, ok := m["text"].(string); ok {
					parts = append(parts, text)
				}
			}
		}
	}
	text := strings.Join(parts, "\n")
	if strings.TrimSpace(text) == "" {
		return ""
	}
	return "<system-reminder>\n" + text + "\n</system-reminder>"
}

func convertClaudeTools(tools []any) []map[string]any {
	out := make([]map[string]any, 0, len(tools))
	for _, t := range tools {
		if m, ok := t.(map[string]any); ok {
			out = append(out, convertClaudeToolMap(m))
		}
	}
	return out
}

func convertClaudeToolsMap(tools []map[string]any) []map[string]any {
	out := make([]map[string]any, 0, len(tools))
	for _, m := range tools {
		out = append(out, convertClaudeToolMap(m))
	}
	return out
}

func convertClaudeToolMap(tool map[string]any) map[string]any {
	name, _ := tool["name"].(string)
	desc, _ := tool["description"].(string)
	params := tool["input_schema"]
	if params == nil {
		params = map[string]any{"type": "object", "properties": map[string]any{}}
	}
	return map[string]any{
		"type": schema.OpenAIBlockTypeFunction,
		"function": map[string]any{
			"name":        name,
			"description": desc,
			"parameters":  params,
		},
	}
}

func convertClaudeToolChoice(choice any) any {
	switch v := choice.(type) {
	case string:
		return v
	case map[string]any:
		t, _ := v["type"].(string)
		switch t {
		case "auto":
			return "auto"
		case "any":
			return "required"
		case "tool":
			name, _ := v["name"].(string)
			return map[string]any{
				"type":     schema.OpenAIBlockTypeFunction,
				"function": map[string]any{"name": name},
			}
		}
	}
	return "auto"
}

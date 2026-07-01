package request

import (
	"fmt"
	"strings"

	"github.com/9router/9router/backend/internal/translator"
	"github.com/9router/9router/backend/internal/translator/concerns"
	"github.com/9router/9router/backend/internal/translator/formats"
	"github.com/9router/9router/backend/internal/translator/schema"
)

func init() {
	translator.Register(string(translator.FormatOpenAI), string(translator.FormatClaude), openaiToClaudeRequest, nil)
}

func openaiToClaudeRequest(model string, body map[string]any, stream bool, creds any) (map[string]any, error) {
	toolNameMap := map[string]string{}
	result := map[string]any{
		"model":      model,
		"max_tokens": formats.AdjustMaxTokens(body),
		"stream":     stream,
	}

	if temp, ok := body["temperature"].(float64); ok {
		result["temperature"] = temp
	} else if temp, ok := body["temperature"].(int); ok {
		result["temperature"] = float64(temp)
	}

	var systemParts []string
	var messages []map[string]any
	var nonSystem []map[string]any

	if msgs, ok := body["messages"].([]any); ok {
		for _, m := range msgs {
			if msg, ok := m.(map[string]any); ok {
				if role, _ := msg["role"].(string); role == schema.RoleSystem {
					systemParts = append(systemParts, concerns.ExtractTextContent(msg["content"], "\n"))
				} else {
					nonSystem = append(nonSystem, msg)
				}
			}
		}
	} else if msgs, ok := body["messages"].([]map[string]any); ok {
		for _, msg := range msgs {
			if role, _ := msg["role"].(string); role == schema.RoleSystem {
				systemParts = append(systemParts, concerns.ExtractTextContent(msg["content"], "\n"))
			} else {
				nonSystem = append(nonSystem, msg)
			}
		}
	}

	var currentRole string
	var currentParts []map[string]any

	flush := func() {
		if currentRole != "" && len(currentParts) > 0 {
			messages = append(messages, map[string]any{
				"role":    currentRole,
				"content": currentParts,
			})
			currentParts = nil
		}
	}

	for _, msg := range nonSystem {
		newRole := schema.RoleAssistant
		if role, _ := msg["role"].(string); role == schema.RoleUser || role == schema.RoleTool {
			newRole = schema.RoleUser
		}
		blocks := getContentBlocksFromMessage(msg, toolNameMap)

		hasToolResult := false
		for _, b := range blocks {
			if t, _ := b["type"].(string); t == schema.ClaudeBlockTypeToolResult {
				hasToolResult = true
				break
			}
		}

		if hasToolResult {
			flush()
			var otherBlocks []map[string]any
			for _, b := range blocks {
				if t, _ := b["type"].(string); t == schema.ClaudeBlockTypeToolResult {
					messages = append(messages, map[string]any{
						"role":    schema.RoleUser,
						"content": []map[string]any{b},
					})
				} else {
					otherBlocks = append(otherBlocks, b)
				}
			}
			if len(otherBlocks) > 0 {
				currentRole = newRole
				currentParts = otherBlocks
			}
			continue
		}

		if currentRole != newRole {
			flush()
			currentRole = newRole
		}
		currentParts = append(currentParts, blocks...)

		hasToolUse := false
		for _, b := range blocks {
			if t, _ := b["type"].(string); t == schema.ClaudeBlockTypeToolUse {
				hasToolUse = true
				break
			}
		}
		if hasToolUse {
			flush()
		}
	}
	flush()
	result["messages"] = messages

	for i := len(messages) - 1; i >= 0; i-- {
		msg := messages[i]
		if role, _ := msg["role"].(string); role == schema.RoleAssistant {
			if content, ok := msg["content"].([]map[string]any); ok && len(content) > 0 {
				for j := len(content) - 1; j >= 0; j-- {
					block := content[j]
					blockType, _ := block["type"].(string)
					if blockType == schema.ClaudeBlockTypeText || blockType == schema.ClaudeBlockTypeToolUse ||
						blockType == schema.ClaudeBlockTypeToolResult || blockType == schema.ClaudeBlockTypeImage {
						block["cache_control"] = map[string]any{"type": "ephemeral"}
						break
					}
				}
				break
			}
		}
	}

	if rf, ok := body["response_format"].(map[string]any); ok {
		rfType, _ := rf["type"].(string)
		if rfType == "json_schema" {
			if js, ok := rf["json_schema"].(map[string]any); ok {
				if s, ok := js["schema"]; ok {
					schemaJSON := concerns.MarshalJSON(s)
					systemParts = append(systemParts,
						"You must respond with valid JSON that strictly follows this JSON schema:\n```json\n"+schemaJSON+"\n```\nRespond ONLY with the JSON object, no other text.")
				}
			}
		} else if rfType == "json_object" {
			systemParts = append(systemParts, "You must respond with valid JSON. Respond ONLY with a JSON object, no other text.")
		}
	}

	claudeCodePrompt := map[string]any{
		"type": schema.ClaudeBlockTypeText,
		"text": "You are Claude Code, a helpful coding assistant.",
	}

	if len(systemParts) > 0 {
		systemText := strings.Join(systemParts, "\n")
		result["system"] = []map[string]any{
			claudeCodePrompt,
			{
				"type":          schema.ClaudeBlockTypeText,
				"text":          systemText,
				"cache_control": map[string]any{"type": "ephemeral", "ttl": "1h"},
			},
		}
	} else {
		result["system"] = []map[string]any{claudeCodePrompt}
	}

	if tools, ok := body["tools"].([]any); ok && len(tools) > 0 {
		result["tools"] = convertOpenAITools(tools, toolNameMap)
	} else if tools, ok := body["tools"].([]map[string]any); ok && len(tools) > 0 {
		result["tools"] = convertOpenAIToolsMap(tools, toolNameMap)
	}

	if tc, ok := body["tool_choice"]; ok {
		result["tool_choice"] = convertOpenAIToolChoice(tc)
	}

	if len(toolNameMap) > 0 {
		result["_toolNameMap"] = toolNameMap
	}

	return result, nil
}

func convertOpenAITools(tools []any, toolNameMap map[string]string) []map[string]any {
	out := make([]map[string]any, 0, len(tools))
	for _, t := range tools {
		if m, ok := t.(map[string]any); ok {
			out = append(out, convertOpenAIToolMap(m, toolNameMap))
		}
	}
	return out
}

func convertOpenAIToolsMap(tools []map[string]any, toolNameMap map[string]string) []map[string]any {
	out := make([]map[string]any, 0, len(tools))
	for _, m := range tools {
		out = append(out, convertOpenAIToolMap(m, toolNameMap))
	}
	return out
}

func convertOpenAIToolMap(tool map[string]any, toolNameMap map[string]string) map[string]any {
	toolType, _ := tool["type"].(string)
	if toolType != "" && toolType != schema.OpenAIBlockTypeFunction {
		return tool
	}

	var toolData map[string]any
	if fn, ok := tool["function"].(map[string]any); ok {
		toolData = fn
	} else {
		toolData = tool
	}

	originalName, _ := toolData["name"].(string)
	toolName := originalName
	toolNameMap[toolName] = originalName

	params := toolData["parameters"]
	if params == nil {
		params = toolData["input_schema"]
	}
	if params == nil {
		params = map[string]any{"type": "object", "properties": map[string]any{}, "required": []string{}}
	}

	return map[string]any{
		"name":        toolName,
		"description": stringOr(toolData["description"], ""),
		"input_schema": params,
	}
}

func convertOpenAIToolChoice(choice any) map[string]any {
	switch v := choice.(type) {
	case string:
		if v == "required" {
			return map[string]any{"type": "any"}
		}
		return map[string]any{"type": "auto"}
	case map[string]any:
		if name, ok := v["function"].(map[string]any)["name"].(string); ok && name != "" {
			return map[string]any{"type": "tool", "name": name}
		}
		if t, ok := v["type"].(string); ok {
			if t == "auto" || t == "any" || t == "tool" || t == "none" {
				return v
			}
		}
	}
	return map[string]any{"type": "auto"}
}

func getContentBlocksFromMessage(msg map[string]any, toolNameMap map[string]string) []map[string]any {
	var blocks []map[string]any
	role, _ := msg["role"].(string)

	switch role {
	case schema.RoleTool:
		blocks = append(blocks, map[string]any{
			"type":         schema.ClaudeBlockTypeToolResult,
			"tool_use_id":  stringOr(msg["tool_call_id"], ""),
			"content":      msg["content"],
		})

	case schema.RoleUser:
		content := msg["content"]
		if text, ok := content.(string); ok {
			if text != "" {
				blocks = append(blocks, map[string]any{"type": schema.ClaudeBlockTypeText, "text": text})
			}
		} else if arr, ok := content.([]any); ok {
			for _, item := range arr {
				if m, ok := item.(map[string]any); ok {
					blocks = append(blocks, convertOpenAIContentPartToClaude(m, toolNameMap)...)
				}
			}
		} else if arr, ok := content.([]map[string]any); ok {
			for _, m := range arr {
				blocks = append(blocks, convertOpenAIContentPartToClaude(m, toolNameMap)...)
			}
		}

	case schema.RoleAssistant:
		if reasoning, ok := msg["reasoning_content"].(string); ok && reasoning != "" {
			blocks = append(blocks, map[string]any{"type": schema.ClaudeBlockTypeThinking, "thinking": reasoning})
		}

		content := msg["content"]
		if text, ok := content.(string); ok {
			if text != "" {
				blocks = append(blocks, map[string]any{"type": schema.ClaudeBlockTypeText, "text": text})
			}
		} else if arr, ok := content.([]any); ok {
			for _, item := range arr {
				if m, ok := item.(map[string]any); ok {
					blocks = append(blocks, convertOpenAIAssistantPartToClaude(m, toolNameMap)...)
				}
			}
		} else if arr, ok := content.([]map[string]any); ok {
			for _, m := range arr {
				blocks = append(blocks, convertOpenAIAssistantPartToClaude(m, toolNameMap)...)
			}
		}

		if tcs, ok := msg["tool_calls"].([]any); ok {
			for _, tc := range tcs {
				if m, ok := tc.(map[string]any); ok {
					blocks = append(blocks, convertOpenAIToolCallToClaude(m, toolNameMap))
				}
			}
		} else if tcs, ok := msg["tool_calls"].([]map[string]any); ok {
			for _, m := range tcs {
				blocks = append(blocks, convertOpenAIToolCallToClaude(m, toolNameMap))
			}
		}
	}

	return blocks
}

func convertOpenAIContentPartToClaude(part map[string]any, toolNameMap map[string]string) []map[string]any {
	partType, _ := part["type"].(string)
	switch partType {
	case schema.OpenAIBlockTypeText:
		if text, ok := part["text"].(string); ok && text != "" {
			return []map[string]any{{"type": schema.ClaudeBlockTypeText, "text": text}}
		}
	case schema.OpenAIBlockTypeImageURL:
		if iu, ok := part["image_url"].(map[string]any); ok {
			url := stringOr(iu["url"], "")
			if parsed := concerns.ParseDataUri(url); parsed != nil {
				return []map[string]any{{
					"type": schema.ClaudeBlockTypeImage,
					"source": map[string]any{
						"type":       "base64",
						"media_type": parsed.MimeType,
						"data":       parsed.Base64,
					},
				}}
			}
			if strings.HasPrefix(url, "http://") || strings.HasPrefix(url, "https://") {
				return []map[string]any{{
					"type":   schema.ClaudeBlockTypeImage,
					"source": map[string]any{"type": "url", "url": url},
				}}
			}
		}
	case schema.ClaudeBlockTypeToolResult:
		return []map[string]any{{
			"type":         schema.ClaudeBlockTypeToolResult,
			"tool_use_id":  stringOr(part["tool_use_id"], ""),
			"content":      part["content"],
			"is_error":     part["is_error"],
		}}
	}
	return nil
}

func convertOpenAIAssistantPartToClaude(part map[string]any, toolNameMap map[string]string) []map[string]any {
	partType, _ := part["type"].(string)
	switch partType {
	case schema.OpenAIBlockTypeText:
		if text, ok := part["text"].(string); ok && text != "" {
			return []map[string]any{{"type": schema.ClaudeBlockTypeText, "text": text}}
		}
	case schema.ClaudeBlockTypeThinking:
		thinking := map[string]any{"type": schema.ClaudeBlockTypeThinking}
		if t, ok := part["thinking"].(string); ok {
			thinking["thinking"] = t
		}
		return []map[string]any{thinking}
	}
	return nil
}

func convertOpenAIToolCallToClaude(tc map[string]any, toolNameMap map[string]string) map[string]any {
	id, _ := tc["id"].(string)
	fn := map[string]any{}
	if f, ok := tc["function"].(map[string]any); ok {
		fn = f
	}
	name := stringOr(fn["name"], "")
	originalName := name
	if originalName != "" {
		toolNameMap[name] = originalName
	}
	args := stringOr(fn["arguments"], "{}")
	input := concerns.SafeParseJSON(args, args)
	return map[string]any{
		"type":  schema.ClaudeBlockTypeToolUse,
		"id":    id,
		"name":  name,
		"input": input,
	}
}

func stringOr(v any, fallback string) string {
	if s, ok := v.(string); ok {
		return s
	}
	return fallback
}

var _ = fmt.Sprintf

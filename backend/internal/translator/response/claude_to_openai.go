package response

import (
	"strconv"
	"strings"
	"time"

	"github.com/9router/9router/backend/internal/translator"
	"github.com/9router/9router/backend/internal/translator/concerns"
	"github.com/9router/9router/backend/internal/translator/schema"
)

func init() {
	translator.Register(string(translator.FormatClaude), string(translator.FormatOpenAI), nil, claudeToOpenAIResponse)
}

func claudeToOpenAIResponse(chunk map[string]any, state *translator.State) ([]map[string]any, error) {
	if chunk == nil {
		return nil, nil
	}
	event, _ := chunk["type"].(string)
	wrapThink := strings.Contains(strings.ToLower(state.Model), "claude")

	var results []map[string]any
	createChunk := func(delta map[string]any, finishReason string) map[string]any {
		return concerns.BuildChunk(
			map[string]any{
				"id":      "chatcmpl-" + state.MessageID,
				"created": int(time.Now().Unix()),
				"model":   state.Model,
			},
			delta,
			finishReason,
		)
	}

	switch event {
	case "message_start":
		if msg, ok := chunk["message"].(map[string]any); ok {
			if id, ok := msg["id"].(string); ok && id != "" {
				state.MessageID = id
			} else {
				state.MessageID = "msg_" + strconv.FormatInt(time.Now().UnixMilli(), 10)
			}
			state.Model, _ = msg["model"].(string)
		}
		state.ContentBlockIndex = -1
		results = append(results, createChunk(map[string]any{"role": schema.RoleAssistant}, ""))

	case "content_block_start":
		block := map[string]any{}
		if b, ok := chunk["content_block"].(map[string]any); ok {
			block = b
		}
		blockType, _ := block["type"].(string)

		if blockType == "server_tool_use" {
			state.ToolCalls["server_tool_block"] = chunk["index"]
			break
		}

		switch blockType {
		case schema.ClaudeBlockTypeText:
			state.TextBlockStarted = true
		case schema.ClaudeBlockTypeThinking:
			state.InThinkingBlock = true
			if idx, ok := chunk["index"].(int); ok {
				state.ContentBlockIndex = idx
			}
			if wrapThink {
				results = append(results, createChunk(map[string]any{"content": "<thinking>"}, ""))
			}
		case schema.ClaudeBlockTypeToolUse:
			state.ContentBlockIndex++
			id, _ := block["id"].(string)
			name := ""
			if n, ok := block["name"].(string); ok {
				name = n
			}
			if state.ToolNameMap != nil {
				if orig, ok := state.ToolNameMap[name]; ok {
					name = orig
				}
			}
			toolCall := map[string]any{
				"index": state.ContentBlockIndex,
				"id":    id,
				"type":  schema.OpenAIBlockTypeFunction,
				"function": map[string]any{
					"name":      name,
					"arguments": "",
				},
			}
			state.ToolCalls[strconv.Itoa(state.ContentBlockIndex)] = toolCall
			results = append(results, createChunk(map[string]any{"tool_calls": []map[string]any{toolCall}}, ""))
		}

	case "content_block_delta":
		if idx, ok := chunk["index"].(int); ok {
			if serverIdx, ok := state.ToolCalls["server_tool_block"].(int); ok && idx == serverIdx {
				break
			}
		}
		if delta, ok := chunk["delta"].(map[string]any); ok {
			deltaType, _ := delta["type"].(string)
			switch deltaType {
			case "text_delta":
				if text, ok := delta["text"].(string); ok {
					results = append(results, createChunk(map[string]any{"content": text}, ""))
				}
			case "thinking_delta":
				if thinking, ok := delta["thinking"].(string); ok {
					results = append(results, createChunk(concerns.ReasoningDelta(thinking), ""))
				}
			case "input_json_delta":
				if partial, ok := delta["partial_json"].(string); ok {
					key := strconv.Itoa(state.ContentBlockIndex)
					if toolCall, ok := state.ToolCalls[key].(map[string]any); ok {
						fn := toolCall["function"].(map[string]any)
						fn["arguments"] = fn["arguments"].(string) + partial
						results = append(results, createChunk(map[string]any{
							"tool_calls": []map[string]any{{
								"index": toolCall["index"],
								"id":    toolCall["id"],
								"function": map[string]any{
									"arguments": partial,
								},
							}},
						}, ""))
					}
				}
			}
		}

	case "content_block_stop":
		if idx, ok := chunk["index"].(int); ok {
			if serverIdx, ok := state.ToolCalls["server_tool_block"].(int); ok && idx == serverIdx {
				delete(state.ToolCalls, "server_tool_block")
				break
			}
			if state.InThinkingBlock && idx == state.ContentBlockIndex {
				if wrapThink {
					results = append(results, createChunk(map[string]any{"content": "</thinking>"}, ""))
				}
				state.InThinkingBlock = false
			}
		}
		state.TextBlockStarted = false
		state.ThinkingBlockStarted = false

	case "message_delta":
		if usage, ok := chunk["usage"].(map[string]any); ok {
			state.Usage = concerns.ToOpenAIUsage(usage, "claude")
		}
		if delta, ok := chunk["delta"].(map[string]any); ok {
			if reason, ok := delta["stop_reason"].(string); ok {
				state.FinishReason = concerns.ToOpenAIFinish(reason, "claude")
				final := createChunk(map[string]any{}, state.FinishReason)
				if state.Usage != nil {
					final["usage"] = state.Usage
				}
				results = append(results, final)
				state.FinishReasonSent = true
			}
		}

	case "message_stop":
		if !state.FinishReasonSent {
			finishReason := state.FinishReason
			if finishReason == "" {
				if len(state.ToolCalls) > 0 {
					finishReason = schema.OpenAIFinishReason["tool_use"]
				} else {
					finishReason = schema.OpenAIFinishReason["end_turn"]
				}
			}
			final := createChunk(map[string]any{}, finishReason)
			if state.Usage != nil {
				final["usage"] = map[string]any{
					"prompt_tokens":     state.Usage["input_tokens"],
					"completion_tokens": state.Usage["output_tokens"],
					"total_tokens":      state.Usage["input_tokens"].(int) + state.Usage["output_tokens"].(int),
				}
			}
			results = append(results, final)
			state.FinishReasonSent = true
		}
	}

	return results, nil
}

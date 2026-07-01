package response

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/9router/9router/backend/internal/translator"
	"github.com/9router/9router/backend/internal/translator/concerns"
	"github.com/9router/9router/backend/internal/translator/schema"
)

func init() {
	translator.Register(string(translator.FormatOpenAI), string(translator.FormatClaude), nil, openaiToClaudeResponse)
}

var claudeOAuthToolPrefix = "proxy_"

func openaiToClaudeResponse(chunk map[string]any, state *translator.State) ([]map[string]any, error) {
	if chunk == nil {
		return nil, nil
	}
	choices := []any{}
	if c, ok := chunk["choices"].([]any); ok {
		choices = c
	} else if c, ok := chunk["choices"].([]map[string]any); ok {
		for _, m := range c {
			choices = append(choices, m)
		}
	}
	if len(choices) == 0 {
		return nil, nil
	}
	choice := choices[0].(map[string]any)
	delta := map[string]any{}
	if d, ok := choice["delta"].(map[string]any); ok {
		delta = d
	}

	var results []map[string]any
	push := func(c map[string]any) {
		results = append(results, c)
	}

	if usage, ok := chunk["usage"].(map[string]any); ok {
		state.Usage = map[string]any{}
		promptTokens := concerns.IntNumber(usage["prompt_tokens"])
		completionTokens := concerns.IntNumber(usage["completion_tokens"])
		cachedTokens := 0
		cacheCreationTokens := 0
		if ptd, ok := usage["prompt_tokens_details"].(map[string]any); ok {
			cachedTokens = concerns.IntNumber(ptd["cached_tokens"])
			cacheCreationTokens = concerns.IntNumber(ptd["cache_creation_tokens"])
		}
		state.Usage["input_tokens"] = promptTokens - cachedTokens - cacheCreationTokens
		state.Usage["output_tokens"] = completionTokens
		if cachedTokens > 0 {
			state.Usage["cache_read_input_tokens"] = cachedTokens
		}
		if cacheCreationTokens > 0 {
			state.Usage["cache_creation_input_tokens"] = cacheCreationTokens
		}
	}

	if state.MessageID == "" {
		state.MessageStartSent = true
		state.MessageID = idFromChunk(chunk)
		state.Model, _ = chunk["model"].(string)
		if state.Model == "" {
			state.Model = schema.ModelFallback["openai"]
		}
		state.NextBlockIndex = 0
		push(messageStart(state.MessageID, state.Model))
	}

	if reasoning := concerns.ExtractReasoningText(delta); reasoning != "" {
		stopTextBlock(state, push)
		if !state.ThinkingBlockStarted {
			state.ThinkingBlockIndex = state.NextBlockIndex
			state.NextBlockIndex++
			state.ThinkingBlockStarted = true
			push(contentBlockStart(state.ThinkingBlockIndex, map[string]any{
				"type":     schema.ClaudeBlockTypeThinking,
				"thinking": "",
			}))
		}
		push(contentBlockDelta(state.ThinkingBlockIndex, map[string]any{
			"type":          "thinking_delta",
			"thinking":      reasoning,
		}))
	}

	if content, ok := delta["content"].(string); ok && content != "" {
		stopThinkingBlock(state, push)
		if !state.TextBlockStarted {
			state.TextBlockIndex = state.NextBlockIndex
			state.NextBlockIndex++
			state.TextBlockStarted = true
			state.TextBlockClosed = false
			push(contentBlockStart(state.TextBlockIndex, map[string]any{
				"type": schema.ClaudeBlockTypeText,
				"text": "",
			}))
		}
		push(contentBlockDelta(state.TextBlockIndex, map[string]any{
			"type": "text_delta",
			"text": content,
		}))
	}

	if tcs, ok := delta["tool_calls"].([]any); ok {
		for _, tc := range tcs {
			if m, ok := tc.(map[string]any); ok {
				processToolCallDelta(m, state, push)
			}
		}
	} else if tcs, ok := delta["tool_calls"].([]map[string]any); ok {
		for _, m := range tcs {
			processToolCallDelta(m, state, push)
		}
	}

	if finishReason, ok := choice["finish_reason"].(string); ok && finishReason != "" {
		stopThinkingBlock(state, push)
		stopTextBlock(state, push)

		for idx, toolInfo := range state.ToolCalls {
			if idx == "server_tool_block" {
				continue
			}
			info := toolInfo.(map[string]any)
			blockIndex := concerns.IntNumber(info["blockIndex"])
			if buffered, ok := state.ToolArgBuffers[idx].(string); ok && buffered != "" {
				sanitized := sanitizeToolArgs(info["name"].(string), buffered)
				push(contentBlockDelta(blockIndex, map[string]any{
					"type":         "input_json_delta",
					"partial_json": sanitized,
				}))
			}
			push(contentBlockStop(blockIndex))
		}

		state.FinishReason = finishReason
		finalUsage := map[string]any{
			"input_tokens":  0,
			"output_tokens": 0,
		}
		if state.Usage != nil {
			finalUsage["input_tokens"] = state.Usage["input_tokens"]
			finalUsage["output_tokens"] = state.Usage["output_tokens"]
		}
		push(messageDelta(concerns.FromOpenAIFinish(finishReason, "claude"), finalUsage))
		push(messageStop())
	}

	return results, nil
}

func processToolCallDelta(tc map[string]any, state *translator.State, push func(map[string]any)) {
	idx := concerns.IntNumber(tc["index"])
	key := strconv.Itoa(idx)

	if id, ok := tc["id"].(string); ok && id != "" {
		stopThinkingBlock(state, push)
		stopTextBlock(state, push)

		name := ""
		if fn, ok := tc["function"].(map[string]any); ok {
			name = stringOr(fn["name"], "")
		}
		if name != "" {
			if strings.HasPrefix(name, claudeOAuthToolPrefix) {
				name = strings.TrimPrefix(name, claudeOAuthToolPrefix)
			}
		}

		blockIndex := state.NextBlockIndex
		state.NextBlockIndex++
		state.ToolCalls[key] = map[string]any{
			"id":         id,
			"name":       name,
			"blockIndex": blockIndex,
		}

		push(contentBlockStart(blockIndex, map[string]any{
			"type": schema.ClaudeBlockTypeToolUse,
			"id":   id,
			"name": name,
			"input": map[string]any{},
		}))
	}

	if fn, ok := tc["function"].(map[string]any); ok {
		if args, ok := fn["arguments"].(string); ok && args != "" {
			if info, ok := state.ToolCalls[key].(map[string]any); ok {
				if state.ToolArgBuffers == nil {
					state.ToolArgBuffers = map[string]any{}
				}
				state.ToolArgBuffers[key] = stringOr(state.ToolArgBuffers[key], "") + args
				_ = info
			}
		}
	}
}

func messageStart(id, model string) map[string]any {
	return map[string]any{
		"type": "message_start",
		"message": map[string]any{
			"id":      id,
			"type":    "message",
			"role":    schema.RoleAssistant,
			"model":   model,
			"content": []map[string]any{},
			"usage": map[string]any{
				"input_tokens":  0,
				"output_tokens": 0,
			},
		},
	}
}

func contentBlockStart(index int, block map[string]any) map[string]any {
	return map[string]any{"type": "content_block_start", "index": index, "content_block": block}
}

func contentBlockDelta(index int, delta map[string]any) map[string]any {
	return map[string]any{"type": "content_block_delta", "index": index, "delta": delta}
}

func contentBlockStop(index int) map[string]any {
	return map[string]any{"type": "content_block_stop", "index": index}
}

func messageDelta(stopReason string, usage map[string]any) map[string]any {
	return map[string]any{
		"type":  "message_delta",
		"delta": map[string]any{"stop_reason": stopReason},
		"usage": usage,
	}
}

func messageStop() map[string]any {
	return map[string]any{"type": "message_stop"}
}

func stopThinkingBlock(state *translator.State, push func(map[string]any)) {
	if !state.ThinkingBlockStarted {
		return
	}
	push(contentBlockStop(state.ThinkingBlockIndex))
	state.ThinkingBlockStarted = false
}

func stopTextBlock(state *translator.State, push func(map[string]any)) {
	if !state.TextBlockStarted || state.TextBlockClosed {
		return
	}
	state.TextBlockClosed = true
	push(contentBlockStop(state.TextBlockIndex))
	state.TextBlockStarted = false
}

func idFromChunk(chunk map[string]any) string {
	id, _ := chunk["id"].(string)
	id = strings.TrimPrefix(id, "chatcmpl-")
	if len(id) >= 8 {
		return id
	}
	if ef, ok := chunk["extend_fields"].(map[string]any); ok {
		if v, ok := ef["requestId"].(string); ok && v != "" {
			return v
		}
		if v, ok := ef["traceId"].(string); ok && v != "" {
			return v
		}
	}
	return "msg_" + strconv.FormatInt(time.Now().UnixMilli(), 10)
}

func sanitizeToolArgs(toolName, argsJSON string) string {
	var args map[string]any
	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
		return argsJSON
	}
	name := toolName
	if strings.HasPrefix(name, claudeOAuthToolPrefix) {
		name = strings.TrimPrefix(name, claudeOAuthToolPrefix)
	}
	if name == "Read" {
		sanitizeReadArgs(args)
	}
	b, _ := json.Marshal(args)
	return string(b)
}

func sanitizeReadArgs(args map[string]any) {
	if limit, ok := args["limit"].(string); ok {
		if matched, _ := regexp.MatchString(`^\d+$`, limit); matched {
			args["limit"] = parseInt(limit)
		}
	}
	if offset, ok := args["offset"].(string); ok {
		if matched, _ := regexp.MatchString(`^-?\d+$`, offset); matched {
			args["offset"] = parseInt(offset)
		}
	}
	if l, ok := args["limit"].(int); ok {
		if l > 2000 {
			args["limit"] = 2000
		}
		if l < 1 {
			delete(args, "limit")
		}
	}
	if o, ok := args["offset"].(int); ok && o < 0 {
		args["offset"] = 0
	}
	if pages, ok := args["pages"].(string); ok {
		if filePath, ok := args["file_path"].(string); ok {
			if !isValidPdfPagesArg(filePath, pages) {
				delete(args, "pages")
			}
		}
	}
}

// ponytail: regexp.MustCompile inside a hot function compiles on every call; hoist to a package-level var.
func isValidPdfPagesArg(filePath, pages string) bool {
	return strings.HasSuffix(strings.ToLower(filePath), ".pdf") &&
		regexp.MustCompile(`^\d+(?:-\d+)?$`).MatchString(pages)
}

func parseInt(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

func stringOr(v any, fallback string) string {
	if s, ok := v.(string); ok {
		return s
	}
	return fallback
}

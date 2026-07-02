package translator_test

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/9router/9router/internal/translator"

	// Trigger translator registrations.
	_ "github.com/9router/9router/internal/translator/request"
	_ "github.com/9router/9router/internal/translator/response"
)

func TestClaudeToOpenAIRequest(t *testing.T) {
	body := map[string]any{
		"model":      "claude-sonnet-4-20250514",
		"max_tokens": 1024,
		"system":     "You are helpful.",
		"messages": []map[string]any{
			{
				"role":    "user",
				"content": []map[string]any{
					{"type": "text", "text": "Hello"},
				},
			},
		},
	}

	out, err := translator.TranslateRequest(translator.FormatClaude, translator.FormatOpenAI, "claude-sonnet-4-20250514", body, true, nil)
	require.NoError(t, err)

	assert.Equal(t, "claude-sonnet-4-20250514", out["model"])
	assert.True(t, out["stream"].(bool))
	assert.NotNil(t, out["messages"])

	msgs := out["messages"].([]map[string]any)
	require.Len(t, msgs, 2)
	assert.Equal(t, "system", msgs[0]["role"])
	assert.Equal(t, "You are helpful.", msgs[0]["content"])
	assert.Equal(t, "user", msgs[1]["role"])
}

func TestOpenAIToClaudeRequest(t *testing.T) {
	body := map[string]any{
		"model":    "gpt-4o",
		"messages": []map[string]any{
			{"role": "system", "content": "You are helpful."},
			{"role": "user", "content": "Hello"},
		},
		"stream": true,
	}

	out, err := translator.TranslateRequest(translator.FormatOpenAI, translator.FormatClaude, "claude-sonnet-4-20250514", body, true, nil)
	require.NoError(t, err)

	assert.Equal(t, "claude-sonnet-4-20250514", out["model"])
	assert.True(t, out["stream"].(bool))
	assert.NotNil(t, out["system"])
	assert.NotNil(t, out["messages"])

	msgs := out["messages"].([]map[string]any)
	require.Len(t, msgs, 1)
	assert.Equal(t, "user", msgs[0]["role"])
}

func TestClaudeToOpenAIResponse(t *testing.T) {
	state := translator.InitState(translator.FormatOpenAI)

	start := map[string]any{
		"type": "message_start",
		"message": map[string]any{
			"id":    "msg_01",
			"type":  "message",
			"role":  "assistant",
			"model": "claude-sonnet-4-20250514",
			"usage": map[string]any{"input_tokens": 10, "output_tokens": 0},
		},
	}

	chunks, err := translator.TranslateResponse(translator.FormatClaude, translator.FormatOpenAI, start, state)
	require.NoError(t, err)
	require.Len(t, chunks, 1)
	assert.Equal(t, "chat.completion.chunk", chunks[0]["object"])
	choices := chunks[0]["choices"].([]map[string]any)
	assert.Equal(t, "assistant", choices[0]["delta"].(map[string]any)["role"])

	delta := map[string]any{
		"type":  "content_block_delta",
		"index": 0,
		"delta": map[string]any{"type": "text_delta", "text": "Hi"},
	}
	chunks, err = translator.TranslateResponse(translator.FormatClaude, translator.FormatOpenAI, delta, state)
	require.NoError(t, err)
	require.Len(t, chunks, 1)
	choices = chunks[0]["choices"].([]map[string]any)
	assert.Equal(t, "Hi", choices[0]["delta"].(map[string]any)["content"])
}

func TestOpenAIToClaudeResponse(t *testing.T) {
	state := translator.InitState(translator.FormatClaude)

	chunk := map[string]any{
		"id":      "chatcmpl-123",
		"object":  "chat.completion.chunk",
		"created": 1234567890,
		"model":   "gpt-4o",
		"choices": []map[string]any{
			{
				"index": 0,
				"delta": map[string]any{"role": "assistant", "content": "Hello"},
			},
		},
	}

	chunks, err := translator.TranslateResponse(translator.FormatOpenAI, translator.FormatClaude, chunk, state)
	require.NoError(t, err)
	require.True(t, len(chunks) >= 2)
	assert.Equal(t, "message_start", chunks[0]["type"])
	assert.Equal(t, "content_block_start", chunks[1]["type"])
}

func TestRoundTripClaudeOpenAIClaude(t *testing.T) {
	claudeReq := map[string]any{
		"model":      "claude-sonnet-4-20250514",
		"max_tokens": 1024,
		"system":     "You are helpful.",
		"messages": []map[string]any{
			{
				"role":    "user",
				"content": "Say hi",
			},
		},
	}

	openaiReq, err := translator.TranslateRequest(translator.FormatClaude, translator.FormatOpenAI, "claude-sonnet-4-20250514", claudeReq, true, nil)
	require.NoError(t, err)
	assert.Equal(t, "claude-sonnet-4-20250514", openaiReq["model"])

	back, err := translator.TranslateRequest(translator.FormatOpenAI, translator.FormatClaude, "claude-sonnet-4-20250514", openaiReq, true, nil)
	require.NoError(t, err)
	assert.Equal(t, "claude-sonnet-4-20250514", back["model"])
	assert.NotNil(t, back["system"])
}

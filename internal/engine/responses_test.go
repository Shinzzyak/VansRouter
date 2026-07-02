package engine

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestResponses_ConvertStringInput(t *testing.T) {
	body := map[string]any{"input": "hello"}
	out, err := ResponsesToChatCompletions(body)
	require.NoError(t, err)

	msgs, ok := out["messages"].([]any)
	require.True(t, ok)
	assert.Len(t, msgs, 1)
	m := msgs[0].(map[string]any)
	assert.Equal(t, "user", m["role"])
	assert.Equal(t, "hello", m["content"])
}

func TestResponses_ConvertInstructions(t *testing.T) {
	body := map[string]any{"input": "hello", "instructions": "be kind"}
	out, err := ResponsesToChatCompletions(body)
	require.NoError(t, err)

	msgs, ok := out["messages"].([]any)
	require.True(t, ok)
	assert.Len(t, msgs, 2)
	assert.Equal(t, "system", msgs[0].(map[string]any)["role"])
	assert.Equal(t, "user", msgs[1].(map[string]any)["role"])
}

func TestResponses_ConvertFunctionCalls(t *testing.T) {
	body := map[string]any{
		"input": []any{
			map[string]any{"type": "function_call", "name": "get_weather", "call_id": "call_1", "arguments": `{"city":"NYC"}`},
			map[string]any{"type": "function_call_output", "call_id": "call_1", "output": "sunny"},
		},
	}
	out, err := ResponsesToChatCompletions(body)
	require.NoError(t, err)

	msgs, ok := out["messages"].([]any)
	require.True(t, ok)
	assert.Len(t, msgs, 2)
	assistant := msgs[0].(map[string]any)
	assert.Equal(t, "assistant", assistant["role"])
	toolCalls, ok := assistant["tool_calls"].([]any)
	require.True(t, ok)
	assert.Len(t, toolCalls, 1)
	fn := toolCalls[0].(map[string]any)["function"].(map[string]any)
	assert.Equal(t, "get_weather", fn["name"])
}

func TestResponses_NoInputReturnsBody(t *testing.T) {
	body := map[string]any{"model": "gpt-4o", "messages": []any{map[string]any{"role": "user", "content": "hi"}}}
	out, err := ResponsesToChatCompletions(body)
	require.NoError(t, err)
	assert.Equal(t, body, out)
}

package usage

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNormalize_OpenAI(t *testing.T) {
	u := Normalize(map[string]any{
		"prompt_tokens":     10,
		"completion_tokens": 5,
		"total_tokens":      15,
	})
	require.NotNil(t, u)
	assert.Equal(t, 10, u.PromptTokens)
	assert.Equal(t, 5, u.CompletionTokens)
	assert.Equal(t, 15, u.TotalTokens)
}

func TestNormalize_Claude(t *testing.T) {
	u := Normalize(map[string]any{
		"input_tokens":  7,
		"output_tokens": 3,
	})
	require.NotNil(t, u)
	assert.Equal(t, 7, u.PromptTokens)
	assert.Equal(t, 3, u.CompletionTokens)
}

func TestNormalize_Empty(t *testing.T) {
	assert.Nil(t, Normalize(map[string]any{}))
	assert.Nil(t, Normalize(nil))
}

func TestExtract_OpenAI(t *testing.T) {
	u := Extract(map[string]any{
		"usage": map[string]any{
			"prompt_tokens":     4,
			"completion_tokens": 2,
		},
	})
	require.NotNil(t, u)
	assert.Equal(t, 4, u.PromptTokens)
	assert.Equal(t, 2, u.CompletionTokens)
}

func TestExtract_ClaudeMessageDelta(t *testing.T) {
	u := Extract(map[string]any{
		"type": "message_delta",
		"usage": map[string]any{
			"input_tokens":  9,
			"output_tokens": 1,
		},
	})
	require.NotNil(t, u)
	assert.Equal(t, 9, u.PromptTokens)
	assert.Equal(t, 1, u.CompletionTokens)
}

func TestExtract_Gemini(t *testing.T) {
	u := Extract(map[string]any{
		"usageMetadata": map[string]any{
			"promptTokenCount":     6,
			"candidatesTokenCount": 4,
			"totalTokenCount":      10,
		},
	})
	require.NotNil(t, u)
	assert.Equal(t, 6, u.PromptTokens)
	assert.Equal(t, 4, u.CompletionTokens)
	assert.Equal(t, 10, u.TotalTokens)
}

func TestExtract_Ollama(t *testing.T) {
	u := Extract(map[string]any{
		"done":               true,
		"prompt_eval_count":  12,
		"eval_count":         8,
	})
	require.NotNil(t, u)
	assert.Equal(t, 12, u.PromptTokens)
	assert.Equal(t, 8, u.CompletionTokens)
}

func TestEstimateInputTokens(t *testing.T) {
	body := map[string]any{"model": "gpt-4", "messages": []any{map[string]any{"role": "user", "content": "hi"}}}
	got := EstimateInputTokens(body)
	// JSON length ~63 chars / 4 = 16 tokens
	assert.Equal(t, 16, got)
}

func TestEstimateOutputTokens(t *testing.T) {
	assert.Equal(t, 0, EstimateOutputTokens(0))
	assert.Equal(t, 1, EstimateOutputTokens(1))
	assert.Equal(t, 2, EstimateOutputTokens(8))
}

func TestAddBuffer(t *testing.T) {
	u := AddBuffer(&Usage{PromptTokens: 10, CompletionTokens: 5, TotalTokens: 15})
	assert.Equal(t, 2010, u.PromptTokens)
	assert.Equal(t, 2005, u.CompletionTokens)
	// When total_tokens already exists, JS adds the buffer once.
	assert.Equal(t, 2015, u.TotalTokens)
}

func TestEstimate(t *testing.T) {
	u := Estimate(map[string]any{"messages": []any{"hi"}}, 8)
	assert.True(t, u.Estimated)
	assert.Equal(t, 2002, u.CompletionTokens)
}

func TestHasValidUsage(t *testing.T) {
	assert.False(t, HasValidUsage(nil))
	assert.False(t, HasValidUsage(&Usage{}))
	assert.True(t, HasValidUsage(&Usage{PromptTokens: 1}))
}

func TestMemoryStore_SaveUsage(t *testing.T) {
	ctx := context.Background()
	s := NewMemoryStore()
	e := Entry{
		Timestamp:        time.Now().UTC(),
		Provider:         "openai",
		Model:            "gpt-4",
		PromptTokens:     10,
		CompletionTokens: 5,
	}
	require.NoError(t, s.SaveUsage(ctx, e))
	history, err := s.GetUsageHistory(ctx, nil)
	require.NoError(t, err)
	require.Len(t, history, 1)
	assert.Equal(t, "ok", history[0].Status)
}

func TestMemoryStore_DedupeUsage(t *testing.T) {
	ctx := context.Background()
	s := NewMemoryStore()
	ts := time.Now().UTC()
	e := Entry{Timestamp: ts, Provider: "openai", Model: "gpt-4", PromptTokens: 10, CompletionTokens: 5}
	require.NoError(t, s.SaveUsage(ctx, e))
	require.NoError(t, s.SaveUsage(ctx, e))
	history, err := s.GetUsageHistory(ctx, nil)
	require.NoError(t, err)
	assert.Len(t, history, 1)
}

func TestMemoryStore_FilterUsage(t *testing.T) {
	ctx := context.Background()
	s := NewMemoryStore()
	s.SaveUsage(ctx, Entry{Provider: "openai", Model: "gpt-4", PromptTokens: 1})
	s.SaveUsage(ctx, Entry{Provider: "claude", Model: "claude-3", PromptTokens: 1})
	out, err := s.GetUsageHistory(ctx, map[string]any{"provider": "openai"})
	require.NoError(t, err)
	assert.Len(t, out, 1)
	assert.Equal(t, "gpt-4", out[0].Model)
}

func TestMemoryStore_RequestDetail(t *testing.T) {
	ctx := context.Background()
	s := NewMemoryStore()
	d := Detail{Provider: "openai", Model: "gpt-4", Status: "ok"}
	require.NoError(t, s.SaveRequestDetail(ctx, d))

	details, total, err := s.GetRequestDetails(ctx, nil)
	require.NoError(t, err)
	assert.Equal(t, 1, total)
	require.Len(t, details, 1)
	assert.Equal(t, "openai", details[0].Provider)

	found, err := s.GetRequestDetailByID(ctx, details[0].ID)
	require.NoError(t, err)
	require.NotNil(t, found)
	assert.Equal(t, "gpt-4", found.Model)
}

func TestMemoryStore_FilterRequestDetails(t *testing.T) {
	ctx := context.Background()
	s := NewMemoryStore()
	s.SaveRequestDetail(ctx, Detail{Provider: "openai", Model: "gpt-4", Status: "ok"})
	s.SaveRequestDetail(ctx, Detail{Provider: "claude", Model: "claude-3", Status: "ok"})
	out, total, err := s.GetRequestDetails(ctx, map[string]any{"provider": "claude"})
	require.NoError(t, err)
	assert.Equal(t, 1, total)
	require.Len(t, out, 1)
	assert.Equal(t, "claude-3", out[0].Model)
}

func TestService_NilStore(t *testing.T) {
	svc := &Service{}
	require.NoError(t, svc.RecordUsage(context.Background(), Entry{}))
	require.NoError(t, svc.RecordRequestDetail(context.Background(), Detail{}))
}

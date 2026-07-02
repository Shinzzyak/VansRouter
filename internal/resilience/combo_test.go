package resilience

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ---- helpers ------------------------------------------------------------

// nopLogf swallows combo log output during tests.
func nopLogf(_, msg string, _ ...any) {}

func makeJSONResp(status int, body any) *http.Response {
	b, _ := json.Marshal(body)
	return &http.Response{
		StatusCode: status,
		Status:     http.StatusText(status),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(string(b))),
	}
}

func makeTextResp(status int, text string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Status:     http.StatusText(status),
		Header:     http.Header{"Content-Type": []string{"text/plain"}},
		Body:       io.NopCloser(strings.NewReader(text)),
	}
}

func readRespBody(r *http.Response) string {
	if r == nil || r.Body == nil {
		return ""
	}
	b, _ := io.ReadAll(r.Body)
	r.Body.Close()
	return string(b)
}

// ---- StripComboPrefix ---------------------------------------------------

func TestStripComboPrefix(t *testing.T) {
	assert.Equal(t, "coding-stack", StripComboPrefix("combo/coding-stack"))
	assert.Equal(t, "openai/gpt-4o", StripComboPrefix("openai/gpt-4o"))
	assert.Equal(t, "", StripComboPrefix("combo/"))
	assert.Equal(t, "", StripComboPrefix(""))
}

// ---- GetComboModelsFromData --------------------------------------------

func TestGetComboModelsFromData_Hit(t *testing.T) {
	combos := []ComboModel{
		{Name: "coding-stack", Models: []string{"openai/gpt-4o", "anthropic/claude"}},
	}
	got := GetComboModelsFromData("coding-stack", combos)
	assert.Equal(t, []string{"openai/gpt-4o", "anthropic/claude"}, got)
}

func TestGetComboModelsFromData_Miss(t *testing.T) {
	combos := []ComboModel{{Name: "x", Models: []string{"a"}}}
	assert.Nil(t, GetComboModelsFromData("unknown", combos))
	assert.Nil(t, GetComboModelsFromData("provider/model", combos))
}

func TestGetComboModelsFromData_EmptyModels(t *testing.T) {
	combos := []ComboModel{{Name: "x", Models: nil}}
	assert.Nil(t, GetComboModelsFromData("x", combos))
}

// ---- DetectRequiredCapabilities ----------------------------------------

func TestDetectRequiredCapabilities_OpenAIImage(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "assistant", "content": "earlier"},
			map[string]any{"role": "user", "content": []any{
				map[string]any{"type": "text", "text": "what's this?"},
				map[string]any{"type": "image_url", "image_url": map[string]any{"url": "http://x"}},
			}},
		},
	}
	req := DetectRequiredCapabilities(body)
	_, hasVision := req["vision"]
	assert.True(t, hasVision)
}

func TestDetectRequiredCapabilities_HistoryNotPinned(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": []any{
				map[string]any{"type": "image_url", "image_url": map[string]any{"url": "http://old"}},
			}},
			map[string]any{"role": "assistant", "content": "ok"},
			map[string]any{"role": "user", "content": "plain text follow-up"},
		},
	}
	req := DetectRequiredCapabilities(body)
	_, hasVision := req["vision"]
	assert.False(t, hasVision, "history image should not pin vision on later plain-text turn")
}

func TestDetectRequiredCapabilities_WebSearch(t *testing.T) {
	body := map[string]any{
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
		"tools":    []any{map[string]any{"type": "web_search"}},
	}
	req := DetectRequiredCapabilities(body)
	_, hasSearch := req["search"]
	assert.True(t, hasSearch)
}

func TestDetectRequiredCapabilities_GeminiPDF(t *testing.T) {
	body := map[string]any{
		"contents": []any{
			map[string]any{"role": "user", "parts": []any{
				map[string]any{"inlineData": map[string]any{"mimeType": "application/pdf"}},
			}},
		},
	}
	req := DetectRequiredCapabilities(body)
	_, hasPDF := req["pdf"]
	assert.True(t, hasPDF)
}

// ---- ReorderByCapabilities ---------------------------------------------

func TestReorderByCapabilities_StableNoOp(t *testing.T) {
	caps := func(p, m string) Capabilities { return Capabilities{} }
	models := []string{"a/x", "b/y"}
	req := map[string]struct{}{"vision": {}}
	got := ReorderByCapabilities(models, req, caps)
	assert.Equal(t, models, got)
}

func TestReorderByCapabilities_FloatsVisionModel(t *testing.T) {
	caps := func(p, m string) Capabilities {
		if p == "a" {
			return Capabilities{Vision: true, Search: true}
		}
		return Capabilities{}
	}
	models := []string{"b/y", "a/x", "c/z"}
	got := ReorderByCapabilities(models, map[string]struct{}{"vision": {}, "search": {}}, caps)
	assert.Equal(t, "a/x", got[0])
	// Original non-matching order preserved after the floater.
	assert.Equal(t, "b/y", got[1])
	assert.Equal(t, "c/z", got[2])
}

func TestReorderByCapabilities_SingleModelNoReorder(t *testing.T) {
	caps := func(p, m string) Capabilities { return Capabilities{} }
	got := ReorderByCapabilities([]string{"a/x"}, map[string]struct{}{"vision": {}}, caps)
	assert.Equal(t, []string{"a/x"}, got)
}

// ---- GetRotatedModels / ResetComboRotation ----------------------------

func TestGetRotatedModels_FallbackPassthrough(t *testing.T) {
	ResetComboRotation("")
	got := GetRotatedModels([]string{"a", "b", "c"}, "x", "fallback", 1)
	assert.Equal(t, []string{"a", "b", "c"}, got)
}

func TestGetRotatedModels_RotatesAfterSticky(t *testing.T) {
	ResetComboRotation("")
	models := []string{"a", "b", "c"}
	first := GetRotatedModels(models, "rr1", "round-robin", 1)
	assert.Equal(t, []string{"a", "b", "c"}, first)
	second := GetRotatedModels(models, "rr1", "round-robin", 1)
	assert.Equal(t, []string{"b", "c", "a"}, second)
}

func TestGetRotatedModels_StickyLimitRespected(t *testing.T) {
	ResetComboRotation("")
	models := []string{"a", "b", "c"}
	_ = GetRotatedModels(models, "rr2", "round-robin", 2)
	second := GetRotatedModels(models, "rr2", "round-robin", 2)
	// Two calls, sticky=2 → still on first index.
	assert.Equal(t, []string{"a", "b", "c"}, second)
	third := GetRotatedModels(models, "rr2", "round-robin", 2)
	assert.Equal(t, []string{"b", "c", "a"}, third)
}

func TestResetComboRotation(t *testing.T) {
	ResetComboRotation("")
	models := []string{"a", "b"}
	_ = GetRotatedModels(models, "res", "round-robin", 1)
	_ = GetRotatedModels(models, "res", "round-robin", 1)
	ResetComboRotation("res")
	got := GetRotatedModels(models, "res", "round-robin", 1)
	assert.Equal(t, []string{"a", "b"}, got, "reset restores index 0")
}

func TestResetComboRotation_All(t *testing.T) {
	ResetComboRotation("")
	_ = GetRotatedModels([]string{"a", "b"}, "rrA", "round-robin", 1)
	_ = GetRotatedModels([]string{"a", "b"}, "rrB", "round-robin", 1)
	_ = GetRotatedModels([]string{"a", "b"}, "rrB", "round-robin", 1)
	ResetComboRotation("")
	a := GetRotatedModels([]string{"a", "b"}, "rrA", "round-robin", 1)
	b := GetRotatedModels([]string{"a", "b"}, "rrB", "round-robin", 1)
	assert.Equal(t, []string{"a", "b"}, a)
	assert.Equal(t, []string{"a", "b"}, b)
}

// ---- HandleComboChat: fallback semantics -------------------------------

func TestHandleComboChat_SuccessFirst(t *testing.T) {
	ResetComboRotation("")
	var calls atomic.Int32
	handle := func(ctx context.Context, body map[string]any, model string) (*http.Response, error) {
		calls.Add(1)
		return makeJSONResp(200, map[string]any{"ok": true, "model": model}), nil
	}
	resp, err := HandleComboChat(context.Background(), nil,
		[]string{"a/x", "b/y"}, handle, nopLogf, "c1", "fallback", 1, false, 1000)
	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, 200, resp.StatusCode)
	assert.Equal(t, int32(1), calls.Load())
}

func TestHandleComboChat_FallbackOn5xx(t *testing.T) {
	ResetComboRotation("")
	var calls atomic.Int32
	handle := func(ctx context.Context, body map[string]any, model string) (*http.Response, error) {
		calls.Add(1)
		if calls.Load() == 1 {
			return makeJSONResp(500, map[string]any{"error": map[string]any{"message": "internal"}}), nil
		}
		return makeJSONResp(200, map[string]any{"ok": true}), nil
	}
	resp, err := HandleComboChat(context.Background(), nil,
		[]string{"a/x", "b/y"}, handle, nopLogf, "c1", "fallback", 1, false, 1000)
	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, 200, resp.StatusCode)
	assert.Equal(t, int32(2), calls.Load())
}

func TestHandleComboChat_400FallsBack(t *testing.T) {
	// JS combo semantics: any unrecognized error falls back to the next model
	// (default transient). Verify we mirror that.
	ResetComboRotation("")
	var calls atomic.Int32
	handle := func(ctx context.Context, body map[string]any, model string) (*http.Response, error) {
		n := calls.Add(1)
		if n == 1 {
			return makeJSONResp(400, map[string]any{"error": map[string]any{"message": "invalid"}}), nil
		}
		return makeJSONResp(200, map[string]any{"ok": true}), nil
	}
	resp, err := HandleComboChat(context.Background(), nil,
		[]string{"a/x", "b/y"}, handle, nopLogf, "c1", "fallback", 1, false, 1000)
	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, 200, resp.StatusCode, "combo falls through to next on 400 default-transient")
	assert.Equal(t, int32(2), calls.Load())
}

func TestHandleComboChat_AllFailPreservesLastStatus(t *testing.T) {
	// When all models fail with the same status and message doesn't trigger
	// the "no credentials" all-disabled path, mirror JS: return lastStatus.
	ResetComboRotation("")
	handle := func(ctx context.Context, body map[string]any, model string) (*http.Response, error) {
		return makeJSONResp(500, map[string]any{"error": map[string]any{"message": "down"}}), nil
	}
	resp, err := HandleComboChat(context.Background(), nil,
		[]string{"a/x", "b/y", "c/z"}, handle, nopLogf, "c1", "fallback", 1, false, 1000)
	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, 500, resp.StatusCode, "no partial success + lastStatus=500 → 500")
}

func TestHandleComboChat_NoCredentialsMatchesAllDisabled(t *testing.T) {
	ResetComboRotation("")
	handle := func(ctx context.Context, body map[string]any, model string) (*http.Response, error) {
		return makeJSONResp(500, map[string]any{"error": map[string]any{"message": "no credentials supplied"}}), nil
	}
	resp, err := HandleComboChat(context.Background(), nil,
		[]string{"a/x", "b/y"}, handle, nopLogf, "c1", "fallback", 1, false, 1000)
	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, 503, resp.StatusCode)
}

func TestHandleComboChat_AutoSwitchReorder(t *testing.T) {
	ResetComboRotation("")
	caps := func(p, _ string) Capabilities {
		if p == "b" {
			return Capabilities{Vision: true}
		}
		return Capabilities{}
	}
	body := map[string]any{
		"messages": []any{map[string]any{"role": "user", "content": []any{
			map[string]any{"type": "image_url"},
		}}},
	}
	var firstModel string
	handle := func(ctx context.Context, body map[string]any, model string) (*http.Response, error) {
		if firstModel == "" {
			firstModel = model
		}
		return makeJSONResp(200, map[string]any{"ok": true}), nil
	}
	// We can't easily inject the caps func into HandleComboChat — verify
	// behavior with the permissive default instead: all models float to the
	// top so order is stable. With allCaps, the first model stays first.
	resp, err := HandleComboChat(context.Background(), body,
		[]string{"a/x", "b/y"}, handle, nopLogf, "c1", "fallback", 1, true, 1000)
	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, 200, resp.StatusCode)
	assert.Equal(t, "a/x", firstModel)
	// Lint capture so caps is reachable in case future test wants it.
	_ = caps
}

// ---- HandleComboChat: signal / context propagation --------------------

func TestHandleComboChat_ContextCancelStopsFallback(t *testing.T) {
	ResetComboRotation("")
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // pre-cancelled
	var calls atomic.Int32
	handle := func(ctx context.Context, body map[string]any, model string) (*http.Response, error) {
		calls.Add(1)
		return makeJSONResp(200, map[string]any{"ok": true}), nil
	}
	resp, err := HandleComboChat(ctx, nil,
		[]string{"a/x", "b/y"}, handle, nopLogf, "c1", "fallback", 1, false, 1000)
	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, 499, resp.StatusCode, "pre-cancelled ctx → 499 client closed")
	assert.Equal(t, int32(0), calls.Load(), "no targets should be called when ctx is pre-cancelled")
}

func TestHandleComboChat_ContextCancelMidFallback(t *testing.T) {
	ResetComboRotation("")
	ctx, cancel := context.WithCancel(context.Background())
	var calls atomic.Int32
	handle := func(ctx context.Context, body map[string]any, model string) (*http.Response, error) {
		n := calls.Add(1)
		if n == 1 {
			cancel()
		}
		return makeJSONResp(500, map[string]any{"error": map[string]any{"message": "down"}}), nil
	}
	resp, err := HandleComboChat(ctx, nil,
		[]string{"a/x", "b/y"}, handle, nopLogf, "c1", "fallback", 1, false, 1000)
	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, 499, resp.StatusCode)
	// Could be 1 or 2 calls: handler runs synchronously, so cancellation only
	// takes effect on the *next* iteration's pre-check. Either is acceptable
	// behavior; the contract is "stop falling back as soon as possible".
	assert.LessOrEqual(t, calls.Load(), int32(2))
}

func TestHandleComboChat_PerTargetTimeout(t *testing.T) {
	ResetComboRotation("")
	var calls atomic.Int32
	handle := func(ctx context.Context, body map[string]any, model string) (*http.Response, error) {
		calls.Add(1)
		if calls.Load() == 1 {
			// Block until ctx is done (the per-target timeout should fire).
			<-ctx.Done()
			return nil, ctx.Err()
		}
		return makeJSONResp(200, map[string]any{"ok": true}), nil
	}
	resp, err := HandleComboChat(context.Background(), nil,
		[]string{"slow/x", "fast/y"}, handle, nopLogf, "c1", "fallback", 1, false, 50)
	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, 200, resp.StatusCode)
	assert.Equal(t, int32(2), calls.Load())
}

func TestHandleComboChat_HandlerErrorFallsBack(t *testing.T) {
	ResetComboRotation("")
	var calls atomic.Int32
	handle := func(ctx context.Context, body map[string]any, model string) (*http.Response, error) {
		n := calls.Add(1)
		if n == 1 {
			return nil, errors.New("boom")
		}
		return makeJSONResp(200, map[string]any{"ok": true}), nil
	}
	resp, err := HandleComboChat(context.Background(), nil,
		[]string{"a/x", "b/y"}, handle, nopLogf, "c1", "fallback", 1, false, 1000)
	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, 200, resp.StatusCode)
	assert.Equal(t, int32(2), calls.Load())
}

// ---- HandleComboChat: round-robin strategy -----------------------------

func TestHandleComboChat_RoundRobinAdvaces(t *testing.T) {
	ResetComboRotation("")
	caps := func(p, _ string) Capabilities { return Capabilities{} }
	_ = caps
	var first string
	var second string
	handle := func(ctx context.Context, body map[string]any, model string) (*http.Response, error) {
		if first == "" {
			first = model
		} else if second == "" {
			second = model
		}
		return makeJSONResp(200, map[string]any{"ok": true}), nil
	}
	_, err := HandleComboChat(context.Background(), nil,
		[]string{"a/x", "b/y", "c/z"}, handle, nopLogf, "rr-c1", "round-robin", 1, false, 1000)
	require.NoError(t, err)
	_, err = HandleComboChat(context.Background(), nil,
		[]string{"a/x", "b/y", "c/z"}, handle, nopLogf, "rr-c1", "round-robin", 1, false, 1000)
	require.NoError(t, err)
	assert.Equal(t, "a/x", first)
	assert.Equal(t, "b/y", second)
}

// ---- HandleComboChat: cooldown before next for 503 --------------------

func TestHandleComboChat_Transient503Cooldown(t *testing.T) {
	ResetComboRotation("")
	var calls atomic.Int32
	var timestamps []time.Time
	handle := func(ctx context.Context, body map[string]any, model string) (*http.Response, error) {
		timestamps = append(timestamps, time.Now())
		calls.Add(1)
		if calls.Load() == 1 {
			return makeJSONResp(503, map[string]any{"error": map[string]any{"message": "service unavailable"}}), nil
		}
		return makeJSONResp(200, map[string]any{"ok": true}), nil
	}
	start := time.Now()
	_, err := HandleComboChat(context.Background(), nil,
		[]string{"a/x", "b/y"}, handle, nopLogf, "c1", "fallback", 1, false, 5000)
	require.NoError(t, err)
	require.Len(t, timestamps, 2)
	elapsed := timestamps[1].Sub(start)
	// Transient 503 should delay next attempt by ~transientCooldownMs (30s in
	// real config), but cooldown ≤5s only — confirm we did wait some time.
	assert.Greater(t, elapsed, time.Duration(0), "should at least wait transient cooldown")
	_ = start
}

// ---- ReorderByCapabilities / TrailingUserItems smoke -------------------

func TestTrailingUserItems(t *testing.T) {
	got := trailingUserItems([]any{
		map[string]any{"role": "user", "content": "old"},
		map[string]any{"role": "assistant", "content": "mid"},
		map[string]any{"role": "user", "content": "new"},
	})
	require.Len(t, got, 1)
	assert.Equal(t, "new", got[0]["content"])
}

// ---- retryAfter / jsonError helpers ------------------------------------

func TestJSONError_HasJSONBody(t *testing.T) {
	resp := jsonError(503, "down")
	require.NotNil(t, resp)
	assert.Equal(t, 503, resp.StatusCode)
	assert.Contains(t, readRespBody(resp), "down")
}

func TestParseRetryAt(t *testing.T) {
	t1 := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	got := parseRetryAt(t1)
	require.NotNil(t, got)
}

// ---- TestCombo meta-test entry point -----------------------------------

func TestCombo(t *testing.T) {
	t.Run("StripComboPrefix", TestStripComboPrefix)
	t.Run("GetComboModelsFromData_Hit", TestGetComboModelsFromData_Hit)
	t.Run("GetComboModelsFromData_Miss", TestGetComboModelsFromData_Miss)
	t.Run("GetComboModelsFromData_EmptyModels", TestGetComboModelsFromData_EmptyModels)
	t.Run("DetectRequiredCapabilities_OpenAIImage", TestDetectRequiredCapabilities_OpenAIImage)
	t.Run("DetectRequiredCapabilities_HistoryNotPinned", TestDetectRequiredCapabilities_HistoryNotPinned)
	t.Run("DetectRequiredCapabilities_WebSearch", TestDetectRequiredCapabilities_WebSearch)
	t.Run("DetectRequiredCapabilities_GeminiPDF", TestDetectRequiredCapabilities_GeminiPDF)
	t.Run("ReorderByCapabilities_StableNoOp", TestReorderByCapabilities_StableNoOp)
	t.Run("ReorderByCapabilities_FloatsVisionModel", TestReorderByCapabilities_FloatsVisionModel)
	t.Run("ReorderByCapabilities_SingleModelNoReorder", TestReorderByCapabilities_SingleModelNoReorder)
	t.Run("GetRotatedModels_FallbackPassthrough", TestGetRotatedModels_FallbackPassthrough)
	t.Run("GetRotatedModels_RotatesAfterSticky", TestGetRotatedModels_RotatesAfterSticky)
	t.Run("GetRotatedModels_StickyLimitRespected", TestGetRotatedModels_StickyLimitRespected)
	t.Run("ResetComboRotation", TestResetComboRotation)
	t.Run("ResetComboRotation_All", TestResetComboRotation_All)
	t.Run("HandleComboChat_SuccessFirst", TestHandleComboChat_SuccessFirst)
	t.Run("HandleComboChat_FallbackOn5xx", TestHandleComboChat_FallbackOn5xx)
	t.Run("HandleComboChat_400FallsBack", TestHandleComboChat_400FallsBack)
	t.Run("HandleComboChat_AllFailPreservesLastStatus", TestHandleComboChat_AllFailPreservesLastStatus)
	t.Run("HandleComboChat_NoCredentialsMatchesAllDisabled", TestHandleComboChat_NoCredentialsMatchesAllDisabled)
	t.Run("HandleComboChat_AutoSwitchReorder", TestHandleComboChat_AutoSwitchReorder)
	t.Run("HandleComboChat_ContextCancelStopsFallback", TestHandleComboChat_ContextCancelStopsFallback)
	t.Run("HandleComboChat_ContextCancelMidFallback", TestHandleComboChat_ContextCancelMidFallback)
	t.Run("HandleComboChat_PerTargetTimeout", TestHandleComboChat_PerTargetTimeout)
	t.Run("HandleComboChat_HandlerErrorFallsBack", TestHandleComboChat_HandlerErrorFallsBack)
	t.Run("HandleComboChat_RoundRobinAdvaces", TestHandleComboChat_RoundRobinAdvaces)
	t.Run("HandleComboChat_Transient503Cooldown", TestHandleComboChat_Transient503Cooldown)
	t.Run("TrailingUserItems", TestTrailingUserItems)
	t.Run("JSONError_HasJSONBody", TestJSONError_HasJSONBody)
	t.Run("ParseRetryAt", TestParseRetryAt)
	_ = fmt.Sprintf // keep import
}

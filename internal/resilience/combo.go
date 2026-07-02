package resilience

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Default per-target timeout. Mirrors DEFAULT_COMBO_TARGET_TIMEOUT_MS in JS.
const DefaultComboTargetTimeoutMs = 55_000

// StripComboPrefix removes "combo/" from the start of a model string.
func StripComboPrefix(modelStr string) string {
	return strings.TrimPrefix(modelStr, "combo/")
}

// ComboModel represents a model entry in the combos table (subset of fields).
type ComboModel struct {
	Name    string   `json:"name"`
	Models  []string `json:"models"`
	Sticky  int      `json:"sticky,omitempty"`
}

// GetComboModelsFromData resolves a combo name to its model list. Returns nil
// when the input already contains a "/" (provider/model form) or no combo matches.
func GetComboModelsFromData(modelStr string, combos []ComboModel) []string {
	if strings.Contains(modelStr, "/") {
		return nil
	}
	for _, c := range combos {
		if c.Name == modelStr && len(c.Models) > 0 {
			return c.Models
		}
	}
	return nil
}

// Capabilities returns the input/output capabilities for a model. Treated as
// all-capable by default; pluggable so the combo layer doesn't depend on the
// providers registry directly. Plugin signature mirrors the JS getCapabilities
// lookup (provider, model) -> caps.
type CapabilitiesFunc func(provider, model string) Capabilities

// Capabilities is a minimal subset of the JS capability map. Hard caps (vision,
// pdf, audio/video input) are required or the request data must be dropped;
// search is soft (degrades a feature). We expose only what combo needs.
type Capabilities struct {
	Vision    bool
	PDF       bool
	AudioIn   bool
	VideoIn   bool
	Search    bool
}

// Hard caps that must be present or input data gets stripped.
var HardCaps = []string{"vision", "pdf", "audio", "video"}

// DetectRequiredCapabilities scans the trailing user turn for image/pdf parts
// and the tools array for web_search. Modalities are only checked on the
// current user turn (history is irrelevant and would over-constrain combos).
func DetectRequiredCapabilities(body map[string]any) map[string]struct{} {
	required := map[string]struct{}{}
	if body == nil {
		return required
	}

	addCap := func(c string) { required[c] = struct{}{} }
	scanBlock := func(b map[string]any) {
		if b == nil {
			return
		}
		switch b["type"] {
		case "image_url", "image", "input_image":
			addCap("vision")
		case "file", "document", "input_file":
			addCap("pdf")
		}
		if mime, _ := b["inlineData"].(map[string]any); mime != nil {
			if s, _ := mime["mimeType"].(string); strings.HasPrefix(s, "image/") {
				addCap("vision")
			}
			if s, _ := mime["mimeType"].(string); s == "application/pdf" {
				addCap("pdf")
			}
		}
	}
	scanContent := func(c any) {
		if arr, ok := c.([]any); ok {
			for _, x := range arr {
				if m, ok := x.(map[string]any); ok {
					scanBlock(m)
				}
			}
		}
	}
	for _, m := range trailingUserItems(body["messages"]) {
		scanContent(m["content"])
	}
	for _, it := range trailingUserItems(body["input"]) {
		scanContent(it["content"])
	}
	if contents, ok := body["contents"].([]any); ok {
		for _, m := range trailingUserItems(contents) {
			if parts, ok := m["parts"].([]any); ok {
				for _, p := range parts {
					if pm, ok := p.(map[string]any); ok {
						scanBlock(pm)
					}
				}
			}
		}
	}
	if tools, ok := body["tools"].([]any); ok {
		for _, t := range tools {
			if tm, ok := t.(map[string]any); ok && tm["type"] == "web_search" {
				addCap("search")
				break
			}
		}
	}
	return required
}

// trailingUserItems returns the items after the last assistant/model message.
func trailingUserItems(raw any) []map[string]any {
	arr, ok := raw.([]any)
	if !ok {
		return nil
	}
	for i := len(arr) - 1; i >= 0; i-- {
		m, ok := arr[i].(map[string]any)
		if !ok {
			continue
		}
		role, _ := m["role"].(string)
		if role == "assistant" || role == "model" {
			return anySliceToMaps(arr[i+1:])
		}
	}
	return anySliceToMaps(arr)
}

func anySliceToMaps(arr []any) []map[string]any {
	out := make([]map[string]any, 0, len(arr))
	for _, x := range arr {
		if m, ok := x.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

// ReorderByCapabilities reorders models so the ones satisfying all required
// caps come first. Stable; never drops a model (fallback intact).
// Tier 0: all hard + all soft. Tier 1: all hard only. Tier 2: rest.
func ReorderByCapabilities(models []string, required map[string]struct{}, caps CapabilitiesFunc) []string {
	if len(required) == 0 || len(models) <= 1 {
		return models
	}
	hard := []string{}
	soft := []string{}
	for c := range required {
		if isHardCap(c) {
			hard = append(hard, c)
		} else {
			soft = append(soft, c)
		}
	}
	type tiered struct {
		m string
		i int
		t int
	}
	items := make([]tiered, len(models))
	allTier2 := true
	for i, m := range models {
		provider, model := splitModel(m)
		c := caps(provider, model)
		t := 2
		if capsAll(c, hard) {
			if capsAll(c, soft) {
				t = 0
			} else {
				t = 1
			}
		}
		if t != 2 {
			allTier2 = false
		}
		items[i] = tiered{m, i, t}
	}
	if allTier2 {
		return models
	}
	sortStable(items, func(a, b tiered) bool {
		if a.t != b.t {
			return a.t < b.t
		}
		return a.i < b.i
	})
	out := make([]string, len(models))
	for i, x := range items {
		out[i] = x.m
	}
	return out
}

func isHardCap(c string) bool {
	for _, h := range HardCaps {
		if c == h {
			return true
		}
	}
	return false
}

func capsAll(c Capabilities, names []string) bool {
	for _, n := range names {
		switch n {
		case "vision":
			if !c.Vision {
				return false
			}
		case "pdf":
			if !c.PDF {
				return false
			}
		case "audio":
			if !c.AudioIn {
				return false
			}
		case "video":
			if !c.VideoIn {
				return false
			}
		case "search":
			if !c.Search {
				return false
			}
		}
	}
	return true
}

func splitModel(m string) (provider, model string) {
	if i := strings.Index(m, "/"); i > 0 {
		return m[:i], m[i+1:]
	}
	return "", m
}

// sortStable is a tiny stable sort helper (avoid pulling sort.SliceStable to
// keep the function inline & reduce import noise).
func sortStable[T any](s []T, less func(a, b T) bool) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && less(s[j], s[j-1]); j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

// Combo rotation state (round-robin).
var (
	comboRotationMu   sync.Mutex
	comboRotationState = map[string]rotationState{}
)

type rotationState struct {
	Index           int
	ConsecutiveUses int
}

// GetRotatedModels rotates the model list according to the strategy. For
// fallback it returns models unchanged. For round-robin it advances the
// rotation index every stickyLimit requests.
func GetRotatedModels(models []string, comboName, strategy string, stickyLimit int) []string {
	if len(models) <= 1 || strategy != "round-robin" {
		return models
	}
	if stickyLimit <= 0 {
		stickyLimit = 1
	}
	key := comboName
	if key == "" {
		key = "__default__"
	}
	comboRotationMu.Lock()
	state, ok := comboRotationState[key]
	if !ok {
		state = rotationState{}
	}
	cur := state.Index % len(models)
	nextUses := state.ConsecutiveUses + 1
	if nextUses >= stickyLimit {
		comboRotationState[key] = rotationState{
			Index:           (cur + 1) % len(models),
			ConsecutiveUses: 0,
		}
	} else {
		comboRotationState[key] = rotationState{
			Index:           cur,
			ConsecutiveUses: nextUses,
		}
	}
	comboRotationMu.Unlock()
	out := make([]string, len(models))
	for i := 0; i < len(models); i++ {
		out[i] = models[(cur+i)%len(models)]
	}
	return out
}

// ResetComboRotation clears rotation state. Pass a name to reset one combo,
// empty string to clear all.
func ResetComboRotation(comboName string) {
	comboRotationMu.Lock()
	if comboName == "" {
		comboRotationState = map[string]rotationState{}
	} else {
		delete(comboRotationState, comboName)
	}
	comboRotationMu.Unlock()
}

// HandleSingleModelFn is the per-target handler signature. Receives a
// derived context (signal + per-target timeout) so cancellation flows through.
type HandleSingleModelFn func(ctx context.Context, body map[string]any, model string) (*http.Response, error)

// HandleComboChat runs the fallback or round-robin strategy across models.
// Signal propagation: the caller's ctx is combined with a per-target
// context.WithTimeout. If the caller's ctx is cancelled, every remaining
// target's ctx is cancelled too (early return with 499 Client Closed Request).
func HandleComboChat(
	ctx context.Context,
	body map[string]any,
	models []string,
	handle HandleSingleModelFn,
	logf func(level, msg string, fields ...any),
	comboName, comboStrategy string,
	comboStickyLimit int,
	autoSwitch bool,
	timeoutMs int,
) (*http.Response, error) {
	rotated := GetRotatedModels(models, comboName, comboStrategy, comboStickyLimit)
	if autoSwitch {
		required := DetectRequiredCapabilities(body)
		if len(required) > 0 {
			reordered := ReorderByCapabilities(rotated, required, allCaps)
			if len(reordered) > 0 && reordered[0] != rotated[0] {
				keys := make([]string, 0, len(required))
				for k := range required {
					keys = append(keys, k)
				}
				logf("info", fmt.Sprintf("auto-switch for [%s] → %s", strings.Join(keys, ","), reordered[0]))
			}
			rotated = reordered
		}
	}

	var lastErr error
	var earliestRetryAfter string
	var lastStatus int

	for i, modelStr := range rotated {
		if err := ctx.Err(); err != nil {
			logf("info", "External ctx cancelled — stopping combo fallback")
			return jsonError(499, "Client disconnected"), nil
		}
		logf("info", fmt.Sprintf("Trying model %d/%d: %s", i+1, len(rotated), modelStr))

		result, err := runSingleTarget(ctx, body, modelStr, handle, timeoutMs)
		if err != nil {
			// Context cancellation propagates up — no point falling back further.
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				if errors.Is(err, context.Canceled) {
					return jsonError(499, "Client disconnected"), nil
				}
				// Per-target timeout: treat as transient 524 and try next.
				logf("warn", fmt.Sprintf("Model %s timed out, falling back", modelStr))
				lastErr = err
				lastStatus = 524
				continue
			}
			lastErr = err
			if lastStatus == 0 {
				lastStatus = 500
			}
			logf("warn", fmt.Sprintf("Model %s threw error, trying next: %v", modelStr, err))
			continue
		}
		if result.StatusCode >= 200 && result.StatusCode < 300 {
			logf("info", fmt.Sprintf("Model %s succeeded", modelStr))
			return result, nil
		}

		// Error path.
		errText := result.Status
		var retryAfter *string
		clone := result.Body
		_ = clone
		bodyBytes, _ := io.ReadAll(result.Body)
		result.Body.Close()
		var parsed struct {
			Error struct {
				Message any `json:"message"`
			} `json:"error"`
			Message   any    `json:"message"`
			RetryAftr any    `json:"retryAfter"`
		}
		if len(bodyBytes) > 0 {
			if err := json.Unmarshal(bodyBytes, &parsed); err == nil {
				if s, ok := parsed.Error.Message.(string); ok && s != "" {
					errText = s
				} else if s, ok := parsed.Message.(string); ok && s != "" {
					errText = s
				}
				if s, ok := parsed.RetryAftr.(string); ok {
					retryAfter = &s
				}
			}
		}
		if !isString(errText) {
			b, _ := json.Marshal(errText)
			errText = string(b)
		}

		if retryAfter != nil && (*retryAfter != "") {
			if earliestRetryAfter == "" || *retryAfter < earliestRetryAfter {
				earliestRetryAfter = *retryAfter
			}
		}

		dec := CheckFallbackError(result.StatusCode, errText, /*backoffLevel*/ 0)
		if !dec.ShouldFallback {
			logf("warn", fmt.Sprintf("Model %s failed (no fallback) status=%d", modelStr, result.StatusCode))
			// Re-wrap body for caller.
			result.Body = io.NopCloser(strings.NewReader(string(bodyBytes)))
			return result, nil
		}

		// Brief cooldown before moving on for transient 502/503/504 so a flapping
		// provider gets a chance to recover instead of being skipped.
		if dec.CooldownMs > 0 && dec.CooldownMs <= 5000 &&
			(result.StatusCode == 502 || result.StatusCode == 503 || result.StatusCode == 504) {
			logf("info", fmt.Sprintf("Model %s transient %d, waiting %dms before next", modelStr, result.StatusCode, dec.CooldownMs))
			select {
			case <-time.After(time.Duration(dec.CooldownMs) * time.Millisecond):
			case <-ctx.Done():
				return jsonError(499, "Client disconnected"), nil
			}
		}
		lastErr = errors.New(errText)
		if lastStatus == 0 {
			lastStatus = result.StatusCode
		}
		logf("warn", fmt.Sprintf("Model %s failed, trying next (status=%d)", modelStr, result.StatusCode))
	}

	msg := "All combo models unavailable"
	if lastErr != nil {
		msg = lastErr.Error()
	}
	allDisabled := strings.Contains(strings.ToLower(msg), "no credentials")
	status := lastStatus
	if allDisabled || status == 0 {
		status = 503
	}
	if earliestRetryAfter != "" {
		retryHuman := FormatRetryAfter(parseRetryAt(earliestRetryAfter))
		logf("warn", fmt.Sprintf("All models failed | %s (%s)", msg, retryHuman))
		return jsonError(status, msg), nil
	}
	logf("warn", fmt.Sprintf("All models failed | %s", msg))
	return jsonError(status, msg), nil
}

// runSingleTarget invokes handle with a derived ctx that combines the parent's
// cancellation with a per-target timeout. Returns the response (body closed)
// or the cancellation/timeout error directly.
func runSingleTarget(
	parent context.Context,
	body map[string]any,
	modelStr string,
	handle HandleSingleModelFn,
	timeoutMs int,
) (*http.Response, error) {
	ctx := parent
	if timeoutMs > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(parent, time.Duration(timeoutMs)*time.Millisecond)
		defer cancel()
	}
	resp, err := handle(ctx, body, modelStr)
	if err != nil {
		return nil, err
	}
	return resp, nil
}

func isString(v any) bool {
	_, ok := v.(string)
	return ok
}

func parseRetryAt(s string) *time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return nil
	}
	return &t
}

func jsonError(status int, msg string) *http.Response {
	body := map[string]any{"error": map[string]any{"message": msg}}
	b, _ := json.Marshal(body)
	return &http.Response{
		StatusCode: status,
		Status:     http.StatusText(status),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(string(b))),
	}
}

// allCaps is the permissive default capability lookup. Real capability data
// will plug in via CapabilitiesFunc when the providers pkg exposes it; combo
// tests stub their own function.
func allCaps(_, _ string) Capabilities {
	return Capabilities{Vision: true, PDF: true, AudioIn: true, VideoIn: true, Search: true}
}

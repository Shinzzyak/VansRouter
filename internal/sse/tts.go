package sse

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
)

// TtsExecutor runs a text-to-speech request against a provider.
type TtsExecutor interface {
	Synthesize(ctx context.Context, req TtsRequest) (*http.Response, error)
}

// TtsRequest is the provider-facing TTS payload.
type TtsRequest struct {
	Provider      string
	Model         string
	Input         string
	Voice         string
	ResponseFormat string
	Body          map[string]any
}

// TtsHandler handles POST /v1/audio/speech.
type TtsHandler struct {
	Executor TtsExecutor
}

func (h *TtsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "failed to read body")
		return
	}
	defer r.Body.Close()

	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}

	input, _ := payload["input"].(string)
	if input == "" {
		writeError(w, http.StatusBadRequest, "Missing required field: input")
		return
	}

	provider := "openai"
	if p, ok := payload["provider"].(string); ok && p != "" {
		provider = p
	}

	req := TtsRequest{
		Provider:       provider,
		Model:          getString(payload, "model"),
		Input:          input,
		Voice:          getString(payload, "voice"),
		ResponseFormat: getString(payload, "response_format", "mp3"),
		Body:           payload,
	}

	if h.Executor == nil {
		// ponytail: no executor configured; return base64 JSON for tests.
		serveTtsJSON(w, []byte("fake-audio-bytes"), req.ResponseFormat)
		return
	}

	upstream, err := h.Executor.Synthesize(r.Context(), req)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer upstream.Body.Close()

	copyHeader(w.Header(), upstream.Header)
	w.WriteHeader(upstream.StatusCode)
	io.Copy(w, upstream.Body)
}

func serveTtsJSON(w http.ResponseWriter, audio []byte, format string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]any{
		"audio":  base64.StdEncoding.EncodeToString(audio),
		"format": format,
	})
}

func getString(m map[string]any, key string, fallback ...string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	if len(fallback) > 0 {
		return fallback[0]
	}
	return ""
}

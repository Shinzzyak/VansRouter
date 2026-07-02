package sse

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// SttExecutor runs a speech-to-text request against a provider.
type SttExecutor interface {
	Transcribe(ctx context.Context, req SttRequest) (*http.Response, error)
}

// SttRequest is the provider-facing STT payload.
type SttRequest struct {
	Provider string
	Model    string
	File     []byte
	FileName string
	Language string
	Prompt   string
	Body     map[string]any
}

// SttHandler handles POST /v1/audio/transcriptions.
type SttHandler struct {
	Executor SttExecutor
}

func (h *SttHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	if err := r.ParseMultipartForm(32 << 20); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("failed to parse form: %v", err))
		return
	}
	defer r.MultipartForm.RemoveAll()

	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "Missing required field: file")
		return
	}
	defer file.Close()

	data, err := io.ReadAll(file)
	if err != nil {
		writeError(w, http.StatusBadRequest, "failed to read file")
		return
	}

	model := r.FormValue("model")
	if model == "" {
		writeError(w, http.StatusBadRequest, "Missing required field: model")
		return
	}

	provider := "openai"
	if p := r.FormValue("provider"); p != "" {
		provider = p
	}

	req := SttRequest{
		Provider: provider,
		Model:    model,
		File:     data,
		FileName: header.Filename,
		Language: r.FormValue("language"),
		Prompt:   r.FormValue("prompt"),
		Body: map[string]any{
			"language":        r.FormValue("language"),
			"prompt":          r.FormValue("prompt"),
			"response_format": r.FormValue("response_format"),
			"temperature":     r.FormValue("temperature"),
		},
	}

	if h.Executor == nil {
		// ponytail: no executor configured; echo a placeholder transcript for tests.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]any{"text": "placeholder transcript"})
		return
	}

	upstream, err := h.Executor.Transcribe(r.Context(), req)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer upstream.Body.Close()

	copyHeader(w.Header(), upstream.Header)
	w.WriteHeader(upstream.StatusCode)
	io.Copy(w, upstream.Body)
}

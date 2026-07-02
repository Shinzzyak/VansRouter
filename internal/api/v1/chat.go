package v1

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/9router/9router/internal/models"
)

// ChatService executes a chat completion. It is an interface so the route can
// be wired without committing to a specific executor, credential store, or
// model resolver until those services are fully ported.
type ChatService interface {
	Chat(ctx context.Context, req ChatRequest) (*ChatResponse, error)
}

// ChatRequest is the input to ChatService.
type ChatRequest struct {
	Body      map[string]any
	APIKey    string
	UserAgent string
	RemoteIP  string
	Endpoint  string
}

// ChatResponse is the output of ChatService.
type ChatResponse struct {
	StatusCode  int
	ContentType string
	Headers     http.Header
	Body        io.ReadCloser
}

// ModelAllowlister checks if a model string is in the configured allow-list.
type ModelAllowlister interface {
	IsModelAllowed(ctx context.Context, modelStr string, apiKeyPresent bool) (bool, error)
}

// ChatHandler handles POST /v1/chat/completions.
type ChatHandler struct {
	Service ChatService
	Builder ModelAllowlister
}

// NewChatHandler returns a ChatHandler that uses models.Builder for allow-listing.
func NewChatHandler(service ChatService, builder *models.Builder) *ChatHandler {
	return &ChatHandler{Service: service, Builder: builder}
}

// ServeHTTP implements http.Handler.
func (h *ChatHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST required")
		return
	}
	defer r.Body.Close()
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request_error", "Invalid JSON body")
		return
	}
	if strings.Contains(r.Header.Get("Accept"), "text/event-stream") && body["stream"] == nil {
		body["stream"] = true
	}
	modelStr, _ := body["model"].(string)
	if modelStr == "" {
		writeError(w, http.StatusBadRequest, "invalid_request_error", "Missing model")
		return
	}
	apiKey := extractAPIKey(r)
	if h.Builder != nil {
		allowed, err := h.Builder.IsModelAllowed(r.Context(), modelStr, apiKey != "")
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if !allowed {
			writeError(w, http.StatusNotFound, "model_not_found", "Model not available")
			return
		}
	}
	if h.Service == nil {
		writeError(w, http.StatusServiceUnavailable, "service_unavailable", "Chat service not configured")
		return
	}
	resp, err := h.Service.Chat(r.Context(), ChatRequest{
		Body:      body,
		APIKey:    apiKey,
		UserAgent: r.UserAgent(),
		Endpoint:  "/v1/chat/completions",
	})
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return
		}
		writeError(w, http.StatusBadGateway, "bad_gateway", err.Error())
		return
	}
	defer resp.Body.Close()
	headers := w.Header()
	for k, vv := range resp.Headers {
		for _, v := range vv {
			headers.Add(k, v)
		}
	}
	if resp.ContentType != "" {
		headers.Set("Content-Type", resp.ContentType)
	}
	w.WriteHeader(resp.StatusCode)
	copyBody(w, resp.Body)
}

func extractAPIKey(r *http.Request) string {
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		return ""
	}
	if strings.HasPrefix(authHeader, "Bearer ") {
		return strings.TrimPrefix(authHeader, "Bearer ")
	}
	return authHeader
}

// copyBody copies src to w, flushing after each write if w supports it.
func copyBody(w http.ResponseWriter, src io.Reader) {
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 16*1024)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			_, _ = w.Write(buf[:n])
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err != nil {
			return
		}
	}
}

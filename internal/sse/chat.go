package sse

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

// ModelResolver resolves a user-facing model string to provider + upstream model ID.
type ModelResolver interface {
	Resolve(ctx context.Context, model string) (provider string, modelID string, err error)
}

// Authorizer validates the incoming request and returns the API key + whether it is allowed.
type Authorizer interface {
	Authorize(r *http.Request) (apiKey string, allowed bool, err error)
}

// CredentialStore returns the next usable account for a provider, excluding failed ones.
type CredentialStore interface {
	GetCredentials(ctx context.Context, provider string, exclude map[string]struct{}) (*Account, error)
}

// Account holds a single provider account.
type Account struct {
	ConnectionID   string
	ConnectionName string
	Data           any
}

// ChatExecutor runs the provider request. It must honor ctx cancellation.
type ChatExecutor interface {
	Execute(ctx context.Context, req ChatRequest) ChatResult
}

// ChatRequest is the input to ChatExecutor.
type ChatRequest struct {
	Body        map[string]any
	Provider    string
	Model       string
	Account     *Account
	AccountCount int
}

// ChatResult describes the outcome of a single provider attempt.
type ChatResult struct {
	Response  *http.Response
	Err       error
	ErrorCode string
	Status    int
}

// Logger is a minimal logging interface used by ChatHandler.
type Logger interface {
	Debug(msg string, keysAndValues ...any)
	Info(msg string, keysAndValues ...any)
	Warn(msg string, keysAndValues ...any)
}

// noopLogger satisfies Logger silently.
type noopLogger struct{}

func (noopLogger) Debug(string, ...any) {}
func (noopLogger) Info(string, ...any)  {}
func (noopLogger) Warn(string, ...any)  {}

// ChatHandler orchestrates the /v1/chat/completions request path:
// auth, model resolution, account retry loop, and r.Context propagation.
type ChatHandler struct {
	Resolver    ModelResolver
	Authorizer  Authorizer
	Credentials CredentialStore
	Executor    ChatExecutor
	Log         Logger
}

// HandleChat processes a chat completion request. It propagates r.Context()
// cancellation through the retry loop and into ChatExecutor.Execute.
func (h *ChatHandler) HandleChat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		h.error(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	ctx := r.Context()
	body, err := h.parseBody(r)
	if err != nil {
		h.error(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}
	if strings.Contains(r.Header.Get("Accept"), "text/event-stream") && body["stream"] == nil {
		body["stream"] = true
	}
	modelStr, _ := body["model"].(string)
	if modelStr == "" {
		h.error(w, http.StatusBadRequest, "Missing model")
		return
	}
	if _, allowed, err := h.Authorizer.Authorize(r); err != nil || !allowed {
		h.error(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	provider, model, err := h.Resolver.Resolve(ctx, modelStr)
	if err != nil {
		h.error(w, http.StatusBadRequest, err.Error())
		return
	}

	// ponytail: maxAttempts=10 is a hardcoded safety cap. The JS port uses
	// accounts.excludeConnectionIds exhaustion as the natural bound and adds
	// circuit-breaker + cooldown-wait + combo routing on top. Add those when
	// the credential store grows beyond a single mock.
	exclude := make(map[string]struct{})
	var streamEarlyEofRetries int
	const maxAttempts = 10
	for attempt := 0; attempt < maxAttempts; attempt++ {
		select {
		case <-ctx.Done():
			h.error(w, 499, "Request aborted")
			return
		default:
		}

		acct, err := h.Credentials.GetCredentials(ctx, provider, exclude)
		if err != nil {
			h.error(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		if acct == nil {
			h.error(w, http.StatusNotFound, "No active credentials for provider: "+provider)
			return
		}

		result := h.Executor.Execute(ctx, ChatRequest{
			Body:         body,
			Provider:     provider,
			Model:        model,
			Account:      acct,
			AccountCount: 0,
		})

		if errors.Is(result.Err, context.Canceled) {
			h.error(w, 499, "Request aborted")
			return
		}
		if result.Err != nil {
			h.log().Warn("chat retry", "provider", provider, "model", model, "error", result.Err, "connection", acct.ConnectionID)
			exclude[acct.ConnectionID] = struct{}{}
			continue
		}
		if result.ErrorCode == "STREAM_EARLY_EOF" && streamEarlyEofRetries < 1 {
			streamEarlyEofRetries++
			h.log().Warn("stream early eof retry", "provider", provider, "model", model)
			continue
		}
		if result.Response != nil {
			h.copyResponse(w, result.Response)
			return
		}
		exclude[acct.ConnectionID] = struct{}{}
	}
	h.error(w, http.StatusServiceUnavailable, "All accounts unavailable")
}

func (h *ChatHandler) parseBody(r *http.Request) (map[string]any, error) {
	defer r.Body.Close()
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		return nil, err
	}
	return body, nil
}

func (h *ChatHandler) copyResponse(w http.ResponseWriter, resp *http.Response) {
	header := w.Header()
	for k, vv := range resp.Header {
		for _, v := range vv {
			header.Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	if resp.Body == nil {
		return
	}
	defer resp.Body.Close()
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 16*1024)
	for {
		n, err := resp.Body.Read(buf)
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

func (h *ChatHandler) error(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"message": msg}})
}

func (h *ChatHandler) log() Logger {
	if h.Log != nil {
		return h.Log
	}
	return noopLogger{}
}

package sse

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type staticResolver struct{ provider, model string }

func (r staticResolver) Resolve(ctx context.Context, model string) (string, string, error) {
	return r.provider, r.model, nil
}

type allowAuthorizer struct{}

func (allowAuthorizer) Authorize(r *http.Request) (string, bool, error) { return "key", true, nil }

type fakeCredentialStore struct {
	accounts []*Account
	pos      int
}

func (s *fakeCredentialStore) GetCredentials(ctx context.Context, provider string, exclude map[string]struct{}) (*Account, error) {
	for s.pos < len(s.accounts) {
		acct := s.accounts[s.pos]
		s.pos++
		if _, ok := exclude[acct.ConnectionID]; ok {
			continue
		}
		return acct, nil
	}
	return nil, nil
}

func TestChatHandler_Success(t *testing.T) {
	wantBody := `{"id":"chatcmpl-1"}`
	exec := &fakeExecutor{
		responses: map[string]ChatResult{
			"conn-1": {
				Response: &http.Response{
					StatusCode: http.StatusOK,
					Header:     http.Header{"Content-Type": []string{"application/json"}},
					Body:       io.NopCloser(strings.NewReader(wantBody)),
				},
			},
		},
	}
	h := &ChatHandler{
		Resolver:   staticResolver{provider: "openai", model: "gpt-4o"},
		Authorizer: allowAuthorizer{},
		Credentials: &fakeCredentialStore{
			accounts: []*Account{{ConnectionID: "conn-1", ConnectionName: "primary", Data: nil}},
		},
		Executor: exec,
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`))
	rec := httptest.NewRecorder()
	h.HandleChat(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"id":"chatcmpl-1"`)
}

func TestChatHandler_RetryOnFailure(t *testing.T) {
	wantBody := `{"id":"chatcmpl-2"}`
	exec := &fakeExecutor{
		responses: map[string]ChatResult{
			"conn-1": {Err: errors.New("upstream 502")},
			"conn-2": {
				Response: &http.Response{
					StatusCode: http.StatusOK,
					Header:     http.Header{"Content-Type": []string{"application/json"}},
					Body:       io.NopCloser(strings.NewReader(wantBody)),
				},
			},
		},
	}
	h := &ChatHandler{
		Resolver:   staticResolver{provider: "openai", model: "gpt-4o"},
		Authorizer: allowAuthorizer{},
		Credentials: &fakeCredentialStore{
			accounts: []*Account{
				{ConnectionID: "conn-1"},
				{ConnectionID: "conn-2"},
			},
		},
		Executor: exec,
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4o","messages":[]}`))
	rec := httptest.NewRecorder()
	h.HandleChat(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"id":"chatcmpl-2"`)
	require.Len(t, exec.calls, 2)
	assert.Equal(t, "conn-1", exec.calls[0].Account.ConnectionID)
	assert.Equal(t, "conn-2", exec.calls[1].Account.ConnectionID)
}

func TestChatHandler_ContextCancelPropagates(t *testing.T) {
	blocked := make(chan struct{})
	exec := &fakeExecutor{
		hook: func(ctx context.Context, req ChatRequest) ChatResult {
			select {
			case <-ctx.Done():
				close(blocked)
				return ChatResult{Err: context.Canceled}
			case <-time.After(5 * time.Second):
				return ChatResult{}
			}
		},
	}
	h := &ChatHandler{
		Resolver:   staticResolver{provider: "openai", model: "gpt-4o"},
		Authorizer: allowAuthorizer{},
		Credentials: &fakeCredentialStore{
			accounts: []*Account{{ConnectionID: "conn-1"}},
		},
		Executor: exec,
	}

	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewReader([]byte(`{"model":"gpt-4o"}`))).WithContext(ctx)
	rec := httptest.NewRecorder()

	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()

	h.HandleChat(rec, req)

	assert.Equal(t, 499, rec.Code)
	select {
	case <-blocked:
	case <-time.After(time.Second):
		t.Fatal("executor did not observe context cancellation")
	}
}

func TestChatHandler_StreamEarlyEofRetry(t *testing.T) {
	wantBody := `{"id":"chatcmpl-ok"}`
	exec := &fakeExecutor{
		responses: map[string]ChatResult{
			"conn-1": {ErrorCode: "STREAM_EARLY_EOF"},
			"conn-2": {
				Response: &http.Response{
					StatusCode: http.StatusOK,
					Body:       io.NopCloser(strings.NewReader(wantBody)),
				},
			},
		},
	}
	h := &ChatHandler{
		Resolver:   staticResolver{provider: "openai", model: "gpt-4o"},
		Authorizer: allowAuthorizer{},
		Credentials: &fakeCredentialStore{
			accounts: []*Account{
				{ConnectionID: "conn-1"},
				{ConnectionID: "conn-2"},
			},
		},
		Executor: exec,
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4o"}`))
	rec := httptest.NewRecorder()
	h.HandleChat(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"id":"chatcmpl-ok"`)
	require.Len(t, exec.calls, 2)
}

func TestChatHandler_NoCredentials(t *testing.T) {
	h := &ChatHandler{
		Resolver:    staticResolver{provider: "openai", model: "gpt-4o"},
		Authorizer:  allowAuthorizer{},
		Credentials: &fakeCredentialStore{},
		Executor:    &fakeExecutor{},
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4o"}`))
	rec := httptest.NewRecorder()
	h.HandleChat(rec, req)

	assert.Equal(t, http.StatusNotFound, rec.Code)
	assert.Contains(t, rec.Body.String(), "No active credentials")
}

type fakeExecutor struct {
	responses map[string]ChatResult
	hook      func(context.Context, ChatRequest) ChatResult
	calls     []ChatRequest
}

func (e *fakeExecutor) Execute(ctx context.Context, req ChatRequest) ChatResult {
	e.calls = append(e.calls, req)
	if e.hook != nil {
		return e.hook(ctx, req)
	}
	res, ok := e.responses[req.Account.ConnectionID]
	if !ok {
		return ChatResult{Err: errors.New("unexpected connection")}
	}
	return res
}

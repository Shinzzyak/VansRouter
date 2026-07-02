package v1

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// fakeCancellingService blocks until its request context is cancelled and then
// records the cancellation cause.
type fakeCancellingService struct {
	mu          sync.Mutex
	cancelled   bool
	cancelCause error
}

func (f *fakeCancellingService) Chat(ctx context.Context, req ChatRequest) (*ChatResponse, error) {
	select {
	case <-ctx.Done():
		f.mu.Lock()
		f.cancelled = true
		f.cancelCause = context.Cause(ctx)
		f.mu.Unlock()
		return nil, context.Canceled
	case <-time.After(5 * time.Second):
		return nil, context.DeadlineExceeded
	}
}

func (f *fakeCancellingService) wasCancelled() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.cancelled
}

func TestContextPropagation(t *testing.T) {
	svc := &fakeCancellingService{}
	handler := &ChatHandler{Service: svc, Builder: nil}

	body := strings.NewReader(`{"model":"gpt-4","messages":[{"role":"user","content":"hi"}]}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", body)
	req.Header.Set("Content-Type", "application/json")

	ctx, cancel := context.WithCancel(req.Context())
	req = req.WithContext(ctx)

	rec := httptest.NewRecorder()

	// Cancel the client request shortly after the handler starts work.
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()

	handler.ServeHTTP(rec, req)

	assert.Eventually(t, svc.wasCancelled, time.Second, 10*time.Millisecond, "upstream Chat context should be cancelled")
	// When the client disconnects the handler returns early without writing a
	// response body. The recorder therefore keeps its default 200 status with an
	// empty body, which proves no success/error payload was emitted.
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Empty(t, rec.Body.String())
}

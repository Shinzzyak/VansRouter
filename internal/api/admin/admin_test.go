package admin

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/9router/9router/internal/usage"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeUsageStore struct {
	history []usage.Entry
	details []usage.Detail
}

func (s *fakeUsageStore) GetUsageHistory(ctx context.Context, filter map[string]any) ([]usage.Entry, error) {
	return s.history, nil
}

func (s *fakeUsageStore) GetUsageStats(ctx context.Context) (map[string]any, error) {
	return map[string]any{"totalRequests": len(s.history), "totalTokens": 0}, nil
}

func (s *fakeUsageStore) GetRequestDetails(ctx context.Context, filter map[string]any) ([]usage.Detail, int, error) {
	return s.details, len(s.details), nil
}

func (s *fakeUsageStore) GetRequestDetailByID(ctx context.Context, id string) (*usage.Detail, error) {
	for _, d := range s.details {
		if d.ID == id {
			return &d, nil
		}
	}
	return nil, nil
}

func TestHealthHandler(t *testing.T) {
	h := &HealthHandler{}
	req := httptest.NewRequest(http.MethodGet, "/admin/health", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	var payload map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, "ok", payload["status"])
	assert.NotEmpty(t, payload["timestamp"])
}

func TestHealthHandler_WrongMethod(t *testing.T) {
	h := &HealthHandler{}
	req := httptest.NewRequest(http.MethodPost, "/admin/health", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusMethodNotAllowed, rec.Code)
}

func TestProvidersHandler_NoRegistry(t *testing.T) {
	h := &ProvidersHandler{}
	req := httptest.NewRequest(http.MethodGet, "/admin/providers", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	var payload []map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Empty(t, payload)
}

func TestProvidersHandler_WrongMethod(t *testing.T) {
	h := &ProvidersHandler{}
	req := httptest.NewRequest(http.MethodPost, "/admin/providers", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusMethodNotAllowed, rec.Code)
}

func TestUsageHandler_List(t *testing.T) {
	store := &fakeUsageStore{
		history: []usage.Entry{{Provider: "openai", Model: "gpt-4", PromptTokens: 10}},
	}
	h := &UsageHandler{Store: store}
	req := httptest.NewRequest(http.MethodGet, "/admin/usage", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	var payload map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Len(t, payload["history"].([]any), 1)
	assert.Equal(t, float64(1), payload["stats"].(map[string]any)["totalRequests"])
}

func TestUsageHandler_NoStore(t *testing.T) {
	h := &UsageHandler{}
	req := httptest.NewRequest(http.MethodGet, "/admin/usage", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestUsageHandler_Detail(t *testing.T) {
	store := &fakeUsageStore{
		details: []usage.Detail{{ID: "d-1", Provider: "openai", Model: "gpt-4"}},
	}
	h := &UsageHandler{Store: store}
	req := httptest.NewRequest(http.MethodPost, "/admin/usage/detail", strings.NewReader(`{"id":"d-1"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	var payload usage.Detail
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, "d-1", payload.ID)
}

func TestUsageHandler_DetailNotFound(t *testing.T) {
	store := &fakeUsageStore{}
	h := &UsageHandler{Store: store}
	req := httptest.NewRequest(http.MethodPost, "/admin/usage/detail", strings.NewReader(`{"id":"missing"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusNotFound, rec.Code)
}

func TestRequestDetailsHandler(t *testing.T) {
	store := &fakeUsageStore{
		details: []usage.Detail{{ID: "d-1", Provider: "openai"}},
	}
	h := &RequestDetailsHandler{Store: store}
	req := httptest.NewRequest(http.MethodGet, "/admin/usage/details", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	var payload map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Len(t, payload["details"].([]any), 1)
	assert.Equal(t, float64(1), payload["pagination"].(map[string]any)["totalItems"])
}

func TestRouter(t *testing.T) {
	router := Router(nil, nil)
	server := httptest.NewServer(router)
	defer server.Close()

	resp, err := http.Get(server.URL + "/health")
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	body, _ := io.ReadAll(resp.Body)
	assert.Contains(t, string(body), `"status":"ok"`)
}

func TestUsageHandler_ListWithFilter(t *testing.T) {
	store := &fakeUsageStore{
		history: []usage.Entry{
			{Provider: "openai", Model: "gpt-4", Timestamp: time.Now().UTC()},
			{Provider: "claude", Model: "claude-3", Timestamp: time.Now().UTC()},
		},
	}
	h := &UsageHandler{Store: store}
	req := httptest.NewRequest(http.MethodGet, "/admin/usage?provider=claude", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	// fakeUsageStore ignores filters, but handler still passes provider param.
	var payload map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Len(t, payload["history"].([]any), 2)
}

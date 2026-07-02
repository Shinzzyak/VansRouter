package admin

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"

	"github.com/9router/9router/internal/usage"
)

// ponytail: UsageStore is a narrow subset of the JS usage repos. The JS
// port supports date range filtering, pagination, cost aggregation, chart
// data, and provider/model/connection breakdowns. Expand the interface when
// the dashboard queries need those features.
// UsageStore is the subset of usage.Store used by admin handlers.
type UsageStore interface {
	GetUsageHistory(ctx context.Context, filter map[string]any) ([]usage.Entry, error)
	GetUsageStats(ctx context.Context) (map[string]any, error)
	GetRequestDetails(ctx context.Context, filter map[string]any) ([]usage.Detail, int, error)
	GetRequestDetailByID(ctx context.Context, id string) (*usage.Detail, error)
}

// UsageHandler exposes usage data for the dashboard.
type UsageHandler struct {
	Store UsageStore
}

func (h *UsageHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.list(w, r)
	case http.MethodPost:
		h.detail(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET or POST required")
	}
}

func (h *UsageHandler) list(w http.ResponseWriter, r *http.Request) {
	if h.Store == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"history": []usage.Entry{},
			"stats":   map[string]any{"totalRequests": 0, "totalTokens": 0},
		})
		return
	}
	ctx := r.Context()
	filter := map[string]any{}
	if p := r.URL.Query().Get("provider"); p != "" {
		filter["provider"] = p
	}
	if m := r.URL.Query().Get("model"); m != "" {
		filter["model"] = m
	}

	history, err := h.Store.GetUsageHistory(ctx, filter)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	stats, err := h.Store.GetUsageStats(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"history": history,
		"stats":   stats,
	})
}

func (h *UsageHandler) detail(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	defer r.Body.Close()
	var payload struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request_error", "invalid JSON")
		return
	}
	if h.Store == nil {
		writeError(w, http.StatusNotFound, "not_found", "detail not found")
		return
	}
	detail, err := h.Store.GetRequestDetailByID(r.Context(), payload.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if detail == nil {
		writeError(w, http.StatusNotFound, "not_found", "detail not found")
		return
	}
	writeJSON(w, http.StatusOK, detail)
}

// RequestDetailsHandler handles paginated request detail listing.
type RequestDetailsHandler struct {
	Store UsageStore
}

func (h *RequestDetailsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET required")
		return
	}
	if h.Store == nil {
		writeJSON(w, http.StatusOK, map[string]any{"details": []usage.Detail{}, "pagination": map[string]any{"totalItems": 0}})
		return
	}
	filter := map[string]any{}
	if p := r.URL.Query().Get("provider"); p != "" {
		filter["provider"] = p
	}
	if m := r.URL.Query().Get("model"); m != "" {
		filter["model"] = m
	}
	if s := r.URL.Query().Get("status"); s != "" {
		filter["status"] = s
	}
	if page, err := strconv.Atoi(r.URL.Query().Get("page")); err == nil && page > 0 {
		filter["page"] = page
	}
	if pageSize, err := strconv.Atoi(r.URL.Query().Get("pageSize")); err == nil && pageSize > 0 {
		filter["pageSize"] = pageSize
	}

	details, total, err := h.Store.GetRequestDetails(r.Context(), filter)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"details":    details,
		"pagination": map[string]any{"totalItems": total},
	})
}

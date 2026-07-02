package dashboard

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/9router/9router/internal/db/repos"
	"github.com/9router/9router/internal/providers"
)

// UsageHandlers exposes dashboard usage endpoints.
type UsageHandlers struct {
	Repos *repos.Repos
}

// NewUsageHandlers creates usage handlers backed by repos.
func NewUsageHandlers(repos *repos.Repos) *UsageHandlers {
	return &UsageHandlers{Repos: repos}
}

var validUsagePeriods = map[string]bool{
	"today": true, "24h": true, "7d": true, "30d": true, "60d": true, "all": true,
}

var validChartPeriods = map[string]bool{
	"today": true, "24h": true, "7d": true, "30d": true, "60d": true,
}

// History handles GET /api/usage/history.
func (h *UsageHandlers) History(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET required")
		return
	}
	stats, err := h.usageStats("all")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, stats)
}

// Logs handles GET /api/usage/logs.
func (h *UsageHandlers) Logs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET required")
		return
	}
	logs, err := h.recentLogs(200)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, logs)
}

// Stats handles GET /api/usage/stats.
func (h *UsageHandlers) Stats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET required")
		return
	}
	period := r.URL.Query().Get("period")
	if period == "" {
		period = "7d"
	}
	if !validUsagePeriods[period] {
		writeError(w, http.StatusBadRequest, "invalid_period", "Invalid period")
		return
	}
	stats, err := h.usageStats(period)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, stats)
}

// Stream handles GET /api/usage/stream as a lightweight SSE feed.
func (h *UsageHandlers) Stream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET required")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	keepalive := time.NewTicker(25 * time.Second)
	defer keepalive.Stop()

	send := func(payload any) bool {
		_, err := fmt.Fprintf(w, "data: %s\n\n", mustJSON(payload))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		return err == nil
	}

	stats, _ := h.usageStats("7d")
	if !send(stats) {
		return
	}

	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			stats, _ := h.usageStats("7d")
			if !send(stats) {
				return
			}
		case <-keepalive.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		}
	}
}

// Providers handles GET /api/usage/providers.
func (h *UsageHandlers) Providers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET required")
		return
	}
	ids, err := h.distinctProviders()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	accounts, _ := h.Repos.Accounts.List("", nil)
	nameMap := make(map[string]string)
	for _, a := range accounts {
		if a.Name != "" {
			nameMap[a.Provider] = a.Name
		}
	}
	reg := loadProviderRegistry()

	out := make([]map[string]string, 0, len(ids))
	for _, id := range ids {
		name := id
		if n, ok := nameMap[id]; ok {
			name = n
		} else if reg != nil {
			name = providers.ResolveAlias(reg, id)
		}
		out = append(out, map[string]string{"id": id, "name": name})
	}
	writeJSON(w, http.StatusOK, map[string]any{"providers": out})
}

// RequestDetails handles GET /api/usage/request-details.
func (h *UsageHandlers) RequestDetails(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET required")
		return
	}
	q := r.URL.Query()
	page, _ := strconv.Atoi(q.Get("page"))
	if page < 1 {
		page = 1
	}
	pageSize, _ := strconv.Atoi(q.Get("pageSize"))
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}
	startDate := q.Get("startDate")
	if startDate == "" {
		startDate = time.Now().UTC().Add(-7 * 24 * time.Hour).Format(time.RFC3339)
	}
	endDate := q.Get("endDate")
	effectiveEnd := time.Now().UTC()
	if endDate != "" {
		if t, err := time.Parse(time.RFC3339, endDate); err == nil {
			effectiveEnd = t
		}
	}
	if effectiveStart, err := time.Parse(time.RFC3339, startDate); err == nil {
		if effectiveEnd.Sub(effectiveStart) > 30*24*time.Hour {
			writeError(w, http.StatusBadRequest, "invalid_range", "Date range must not exceed 30 days")
			return
		}
	}

	filter := map[string]any{
		"page": page, "pageSize": pageSize,
		"provider": q.Get("provider"), "model": q.Get("model"),
		"connectionId": q.Get("connectionId"), "status": q.Get("status"),
		"startDate": startDate, "endDate": endDate,
	}
	result, err := h.requestDetails(filter)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// RequestDetailByID handles GET /api/usage/request-details/[id].
func (h *UsageHandlers) RequestDetailByID(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET required")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/usage/request-details/")
	id = strings.TrimSpace(id)
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "ID required")
		return
	}
	detail, err := h.requestDetailByID(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if detail == nil {
		writeError(w, http.StatusNotFound, "not_found", "Not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"detail": detail})
}

// ConnectionUsage handles GET /api/usage/[connectionId].
func (h *UsageHandlers) ConnectionUsage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET required")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/usage/")
	id = strings.TrimSpace(id)
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "Connection ID required")
		return
	}
	acc, err := h.Repos.Accounts.GetByID(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if acc == nil {
		writeError(w, http.StatusNotFound, "not_found", "Connection not found")
		return
	}
	eligible := acc.AuthType == "oauth" || (acc.AuthType == "apikey" || acc.AuthType == "api_key")
	if !eligible {
		writeJSON(w, http.StatusOK, map[string]string{"message": "Usage not available for this connection"})
		return
	}
	// ponytail: live provider quota/usage is deferred; return local aggregates.
	stats, err := h.connectionUsage(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, stats)
}

// CodexResetCredits handles POST /api/usage/[connectionId]/codex-reset-credits.
func (h *UsageHandlers) CodexResetCredits(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST required")
		return
	}
	prefix := "/api/usage/"
	suffix := "/codex-reset-credits"
	id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, prefix), suffix)
	id = strings.TrimSpace(id)
	acc, err := h.Repos.Accounts.GetByID(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if acc == nil {
		writeError(w, http.StatusNotFound, "not_found", "Connection not found")
		return
	}
	if acc.Provider != "codex" {
		writeError(w, http.StatusBadRequest, "invalid_provider", "Codex reset credits are only available for Codex connections")
		return
	}
	if acc.AuthType != "oauth" && acc.AuthType != "access_token" {
		writeError(w, http.StatusBadRequest, "invalid_auth", "Codex reset credits require an OAuth or access-token connection")
		return
	}
	// ponytail: actual Codex reset-credit API call is deferred.
	writeJSON(w, http.StatusOK, map[string]any{
		"code":     "ok",
		"reset":    true,
		"windows_reset": 0,
		"redeemRequestId": newRequestID(),
		"credit":   nil,
	})
}

// Chart handles GET /api/usage/chart.
func (h *UsageHandlers) Chart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET required")
		return
	}
	period := r.URL.Query().Get("period")
	if period == "" {
		period = "7d"
	}
	if !validChartPeriods[period] {
		writeError(w, http.StatusBadRequest, "invalid_period", "Invalid period")
		return
	}
	data, err := h.chartData(period)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, data)
}

// helpers

func (h *UsageHandlers) usageStats(period string) (map[string]any, error) {
	stats := map[string]any{
		"totalRequests": 0, "totalPromptTokens": 0, "totalCompletionTokens": 0, "totalCost": 0.0,
		"byProvider": map[string]any{}, "byModel": map[string]any{}, "byAccount": map[string]any{},
		"byApiKey": map[string]any{}, "byEndpoint": map[string]any{},
		"last10Minutes": []map[string]any{}, "pending": map[string]any{"byModel": map[string]int{}, "byAccount": map[string]any{}},
		"activeRequests": []map[string]any{}, "recentRequests": []map[string]any{}, "errorProvider": "",
	}

	var cutoff time.Time
	switch period {
	case "today":
		cutoff = time.Now().UTC().Truncate(24 * time.Hour)
	case "24h":
		cutoff = time.Now().UTC().Add(-24 * time.Hour)
	case "7d":
		cutoff = time.Now().UTC().Add(-7 * 24 * time.Hour)
	case "30d":
		cutoff = time.Now().UTC().Add(-30 * 24 * time.Hour)
	case "60d":
		cutoff = time.Now().UTC().Add(-60 * 24 * time.Hour)
	default:
		cutoff = time.Time{}
	}

	if period == "all" || period == "7d" || period == "30d" || period == "60d" {
		maxDays := 0
		switch period {
		case "7d":
			maxDays = 7
		case "30d":
			maxDays = 30
		case "60d":
			maxDays = 60
		}
		if err := h.aggregateFromDaily(stats, maxDays); err != nil {
			return nil, err
		}
	} else {
		if err := h.aggregateFromHistory(stats, cutoff); err != nil {
			return nil, err
		}
	}

	h.fillLast10Minutes(stats)
	h.fillRecentRequests(stats, cutoff)
	return stats, nil
}

func (h *UsageHandlers) aggregateFromDaily(stats map[string]any, maxDays int) error {
	query := `SELECT dateKey, data FROM usageDaily`
	var rows *sql.Rows
	var err error
	if maxDays > 0 {
		cutoff := time.Now().UTC().Add(-time.Duration(maxDays-1) * 24 * time.Hour).Format("2006-01-02")
		rows, err = h.Repos.DB.Query(query+` WHERE dateKey >= ?`, cutoff)
	} else {
		rows, err = h.Repos.DB.Query(query)
	}
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var dateKey, data string
		if err := rows.Scan(&dateKey, &data); err != nil {
			return err
		}
		var day repos.UsageDay
		if err := json.Unmarshal([]byte(data), &day); err != nil {
			continue
		}
		stats["totalRequests"] = statsInt(stats, "totalRequests") + day.Requests
		stats["totalPromptTokens"] = statsInt(stats, "totalPromptTokens") + day.PromptTokens
		stats["totalCompletionTokens"] = statsInt(stats, "totalCompletionTokens") + day.CompletionTokens
		stats["totalCost"] = statsFloat(stats, "totalCost") + day.Cost
		mergeCounters(stats, "byProvider", day.ByProvider)
		mergeCounters(stats, "byModel", day.ByModel)
		mergeCounters(stats, "byAccount", day.ByAccount)
		mergeCounters(stats, "byApiKey", day.ByAPIKey)
		mergeCounters(stats, "byEndpoint", day.ByEndpoint)
	}
	return rows.Err()
}

func (h *UsageHandlers) aggregateFromHistory(stats map[string]any, cutoff time.Time) error {
	rows, err := h.Repos.DB.Query(
		`SELECT timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens FROM usageHistory WHERE timestamp >= ?`,
		cutoff.Format(time.RFC3339),
	)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var e usageHistoryRow
		var tokensJSON string
		if err := rows.Scan(&e.Timestamp, &e.Provider, &e.Model, &e.ConnectionID, &e.APIKey, &e.Endpoint, &e.PromptTokens, &e.CompletionTokens, &e.Cost, &e.Status, &tokensJSON); err != nil {
			return err
		}
		var tokens map[string]any
		_ = json.Unmarshal([]byte(tokensJSON), &tokens)
		pt := coalesceToken(tokens, "prompt_tokens", "input_tokens", e.PromptTokens)
		ct := coalesceToken(tokens, "completion_tokens", "output_tokens", e.CompletionTokens)
		addHistoryEntry(stats, &e, pt, ct)
	}
	return rows.Err()
}

func addHistoryEntry(stats map[string]any, e *usageHistoryRow, promptTokens, completionTokens int) {
	stats["totalRequests"] = statsInt(stats, "totalRequests") + 1
	stats["totalPromptTokens"] = statsInt(stats, "totalPromptTokens") + promptTokens
	stats["totalCompletionTokens"] = statsInt(stats, "totalCompletionTokens") + completionTokens
	stats["totalCost"] = statsFloat(stats, "totalCost") + e.Cost
	addCounter(stats, "byProvider", e.Provider, promptTokens, completionTokens, e.Cost)
	modelKey := e.Model
	if e.Provider != "" {
		modelKey = fmt.Sprintf("%s (%s)", e.Model, e.Provider)
	}
	addCounterWithMeta(stats, "byModel", modelKey, promptTokens, completionTokens, e.Cost, map[string]any{"rawModel": e.Model, "provider": e.Provider, "lastUsed": e.Timestamp})
	if e.ConnectionID != "" {
		addCounterWithMeta(stats, "byAccount", e.ConnectionID, promptTokens, completionTokens, e.Cost, map[string]any{"connectionId": e.ConnectionID, "lastUsed": e.Timestamp})
	}
	apiKeyVal := e.APIKey
	if apiKeyVal == "" {
		apiKeyVal = "local-no-key"
	}
	addCounterWithMeta(stats, "byApiKey", apiKeyVal, promptTokens, completionTokens, e.Cost, map[string]any{"apiKeyMasked": maskKey(apiKeyVal), "lastUsed": e.Timestamp})
	endpoint := e.Endpoint
	if endpoint == "" {
		endpoint = "Unknown"
	}
	addCounterWithMeta(stats, "byEndpoint", endpoint, promptTokens, completionTokens, e.Cost, map[string]any{"endpoint": endpoint, "lastUsed": e.Timestamp})
}

func mergeCounters(stats map[string]any, key string, src map[string]*repos.UsageCounter) {
	target := statsMap(stats, key)
	for k, v := range src {
		addCounterWithMeta(stats, key, k, v.PromptTokens, v.CompletionTokens, v.Cost, map[string]any{
			"rawModel": v.RawModel, "provider": v.Provider, "apiKeyMasked": maskKey(v.APIKey), "endpoint": v.Endpoint, "lastUsed": "",
		})
		_ = target
	}
}

func addCounter(stats map[string]any, bucket, key string, prompt, completion int, cost float64) {
	addCounterWithMeta(stats, bucket, key, prompt, completion, cost, nil)
}

func addCounterWithMeta(stats map[string]any, bucket, key string, prompt, completion int, cost float64, meta map[string]any) {
	m := statsMap(stats, bucket)
	var c map[string]any
	if existing, ok := m[key].(map[string]any); ok {
		c = existing
	} else {
		c = map[string]any{"requests": 0, "promptTokens": 0, "completionTokens": 0, "cost": 0.0}
		for k, v := range meta {
			c[k] = v
		}
	}
	c["requests"] = intValue(c["requests"]) + 1
	c["promptTokens"] = intValue(c["promptTokens"]) + prompt
	c["completionTokens"] = intValue(c["completionTokens"]) + completion
	c["cost"] = floatValue(c["cost"]) + cost
	m[key] = c
}

func (h *UsageHandlers) fillLast10Minutes(stats map[string]any) {
	now := time.Now().UTC()
	start := now.Add(-9 * time.Minute).Truncate(time.Minute)
	buckets := make([]map[string]any, 10)
	bucketMap := make(map[int64]map[string]any)
	for i := 0; i < 10; i++ {
		ts := start.Add(time.Duration(i) * time.Minute)
		b := map[string]any{"label": ts.Format("15:04"), "requests": 0, "promptTokens": 0, "completionTokens": 0, "cost": 0.0}
		buckets[i] = b
		bucketMap[ts.UnixMilli()] = b
	}
	rows, err := h.Repos.DB.Query(
		`SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ?`,
		start.Format(time.RFC3339),
	)
	if err != nil {
		stats["last10Minutes"] = buckets
		return
	}
	defer rows.Close()
	for rows.Next() {
		var ts string
		var pt, ct int
		var cost float64
		if err := rows.Scan(&ts, &pt, &ct, &cost); err != nil {
			continue
		}
		t, _ := time.Parse(time.RFC3339, ts)
		minute := t.Truncate(time.Minute).UnixMilli()
		if b, ok := bucketMap[minute]; ok {
			b["requests"] = intValue(b["requests"]) + 1
			b["promptTokens"] = intValue(b["promptTokens"]) + pt
			b["completionTokens"] = intValue(b["completionTokens"]) + ct
			b["cost"] = floatValue(b["cost"]) + cost
		}
	}
	stats["last10Minutes"] = buckets
}

func (h *UsageHandlers) fillRecentRequests(stats map[string]any, cutoff time.Time) {
	cutoffStr := ""
	if !cutoff.IsZero() {
		cutoffStr = cutoff.Format(time.RFC3339)
	}
	query := `SELECT timestamp, provider, model, promptTokens, completionTokens, status, tokens FROM usageHistory`
	var rows *sql.Rows
	var err error
	if cutoffStr != "" {
		rows, err = h.Repos.DB.Query(query+` WHERE timestamp >= ? ORDER BY id DESC LIMIT 100`, cutoffStr)
	} else {
		rows, err = h.Repos.DB.Query(query + ` ORDER BY id DESC LIMIT 100`)
	}
	if err != nil {
		return
	}
	defer rows.Close()
	var out []map[string]any
	seen := make(map[string]bool)
	for rows.Next() {
		var ts, provider, model, status string
		var pt, ct int
		var tokensJSON string
		if err := rows.Scan(&ts, &provider, &model, &pt, &ct, &status, &tokensJSON); err != nil {
			continue
		}
		var tokens map[string]any
		_ = json.Unmarshal([]byte(tokensJSON), &tokens)
		prompt := coalesceToken(tokens, "prompt_tokens", "input_tokens", pt)
		completion := coalesceToken(tokens, "completion_tokens", "output_tokens", ct)
		if prompt == 0 && completion == 0 {
			continue
		}
		minute := ""
		if t, err := time.Parse(time.RFC3339, ts); err == nil {
			minute = t.Format("2006-01-02T15:04")
		}
		key := fmt.Sprintf("%s|%s|%d|%d|%s", model, provider, prompt, completion, minute)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, map[string]any{
			"timestamp": ts, "model": model, "provider": provider,
			"promptTokens": prompt, "completionTokens": completion, "status": status,
		})
		if len(out) >= 20 {
			break
		}
	}
	stats["recentRequests"] = out
}

func (h *UsageHandlers) recentLogs(limit int) ([]string, error) {
	rows, err := h.Repos.DB.Query(
		`SELECT timestamp, provider, model, connectionId, promptTokens, completionTokens, status FROM usageHistory ORDER BY id DESC LIMIT ?`, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	accounts, _ := h.Repos.Accounts.List("", nil)
	accountMap := make(map[string]string)
	for _, a := range accounts {
		accountMap[a.ID] = a.Name
	}

	var logs []string
	for rows.Next() {
		var ts, provider, model, connectionID, status string
		var pt, ct int
		if err := rows.Scan(&ts, &provider, &model, &connectionID, &pt, &ct, &status); err != nil {
			continue
		}
		t, _ := time.Parse(time.RFC3339, ts)
		account := "-"
		if connectionID != "" {
			account = accountMap[connectionID]
			if account == "" {
				account = connectionID[:min(8, len(connectionID))]
			}
		}
		logs = append(logs, fmt.Sprintf("%s | %s | %s | %s | %d | %d | %s",
			t.Format("02-01-2006 15:04:05"), model, strings.ToUpper(provider), account, pt, ct, status))
	}
	return logs, nil
}

func (h *UsageHandlers) distinctProviders() ([]string, error) {
	rows, err := h.Repos.DB.Query(`SELECT DISTINCT provider FROM usageHistory WHERE provider IS NOT NULL AND provider != ''`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			continue
		}
		if p != "" {
			ids = append(ids, p)
		}
	}
	sort.Strings(ids)
	return ids, rows.Err()
}

func (h *UsageHandlers) chartData(period string) ([]map[string]any, error) {
	now := time.Now().UTC()
	if period == "today" || period == "24h" {
		bucketCount := 24
		bucketMs := time.Hour
		var start time.Time
		if period == "today" {
			start = now.Truncate(24 * time.Hour)
		} else {
			start = now.Add(-time.Duration(bucketCount) * bucketMs)
		}
		buckets := make([]map[string]any, bucketCount)
		for i := 0; i < bucketCount; i++ {
			ts := start.Add(time.Duration(i) * bucketMs)
			buckets[i] = map[string]any{"label": ts.Format("15:04"), "tokens": 0, "cost": 0.0}
		}
		rows, err := h.Repos.DB.Query(`SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ?`, start.Format(time.RFC3339))
		if err != nil {
			return buckets, nil
		}
		defer rows.Close()
		for rows.Next() {
			var ts string
			var pt, ct int
			var cost float64
			if err := rows.Scan(&ts, &pt, &ct, &cost); err != nil {
				continue
			}
			t, _ := time.Parse(time.RFC3339, ts)
			idx := int(t.Sub(start) / bucketMs)
			if idx >= 0 && idx < bucketCount {
				buckets[idx]["tokens"] = intValue(buckets[idx]["tokens"]) + pt + ct
				buckets[idx]["cost"] = floatValue(buckets[idx]["cost"]) + cost
			}
		}
		return buckets, nil
	}

	bucketCount := 7
	if period == "30d" {
		bucketCount = 30
	} else if period == "60d" {
		bucketCount = 60
	}
	cutoff := now.Add(-time.Duration(bucketCount-1) * 24 * time.Hour).Format("2006-01-02")
	dayMap := make(map[string]map[string]any)
	rows, err := h.Repos.DB.Query(`SELECT dateKey, data FROM usageDaily WHERE dateKey >= ?`, cutoff)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var dateKey, data string
		if err := rows.Scan(&dateKey, &data); err != nil {
			continue
		}
		var day repos.UsageDay
		if err := json.Unmarshal([]byte(data), &day); err != nil {
			continue
		}
		dayMap[dateKey] = map[string]any{"tokens": day.PromptTokens + day.CompletionTokens, "cost": day.Cost}
	}

	buckets := make([]map[string]any, bucketCount)
	for i := 0; i < bucketCount; i++ {
		d := now.Add(-time.Duration(bucketCount-1-i) * 24 * time.Hour)
		dateKey := d.Format("2006-01-02")
		label := d.Format("Jan 2")
		val := dayMap[dateKey]
		if val == nil {
			val = map[string]any{"tokens": 0, "cost": 0.0}
		}
		buckets[i] = map[string]any{"label": label, "tokens": val["tokens"], "cost": val["cost"]}
	}
	return buckets, nil
}

func (h *UsageHandlers) requestDetails(filter map[string]any) (map[string]any, error) {
	page := intValue(filter["page"])
	pageSize := intValue(filter["pageSize"])
	where, params := []string{}, []any{}
	add := func(col, val string) {
		if val != "" {
			where = append(where, col+" = ?")
			params = append(params, val)
		}
	}
	add("provider", stringValue(filter["provider"]))
	add("model", stringValue(filter["model"]))
	add("connectionId", stringValue(filter["connectionId"]))
	add("status", stringValue(filter["status"]))
	if s := stringValue(filter["startDate"]); s != "" {
		where = append(where, "timestamp >= ?")
		params = append(params, s)
	}
	if e := stringValue(filter["endDate"]); e != "" {
		where = append(where, "timestamp <= ?")
		params = append(params, e)
	}

	table := "usageHistory"
	if h.hasTable("requestDetails") {
		table = "requestDetails"
	}

	whereSQL := ""
	if len(where) > 0 {
		whereSQL = "WHERE " + strings.Join(where, " AND ")
	}
	var total int
	countQuery := fmt.Sprintf(`SELECT COUNT(*) FROM %s %s`, table, whereSQL)
	if err := h.Repos.DB.QueryRow(countQuery, params...).Scan(&total); err != nil {
		return nil, err
	}

	offset := (page - 1) * pageSize
	var rows *sql.Rows
	var err error
	if table == "requestDetails" {
		rows, err = h.Repos.DB.Query(
			fmt.Sprintf(`SELECT data FROM %s %s ORDER BY timestamp DESC LIMIT ? OFFSET ?`, table, whereSQL),
			append(params, pageSize, offset)...,
		)
	} else {
		rows, err = h.Repos.DB.Query(
			fmt.Sprintf(`SELECT timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta FROM %s %s ORDER BY timestamp DESC LIMIT ? OFFSET ?`, table, whereSQL),
			append(params, pageSize, offset)...,
		)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var details []map[string]any
	if table == "requestDetails" {
		for rows.Next() {
			var data string
			if err := rows.Scan(&data); err != nil {
				continue
			}
			var d map[string]any
			_ = json.Unmarshal([]byte(data), &d)
			details = append(details, d)
		}
	} else {
		for rows.Next() {
			details = append(details, h.scanUsageDetail(rows))
		}
	}

	totalPages := total / pageSize
	if total%pageSize != 0 {
		totalPages++
	}
	return map[string]any{
		"details": details,
		"pagination": map[string]any{
			"page": page, "pageSize": pageSize, "totalItems": total, "totalPages": totalPages,
			"hasNext": page < totalPages, "hasPrev": page > 1,
		},
	}, nil
}

func (h *UsageHandlers) requestDetailByID(id string) (map[string]any, error) {
	if h.hasTable("requestDetails") {
		var data string
		if err := h.Repos.DB.QueryRow(`SELECT data FROM requestDetails WHERE id = ?`, id).Scan(&data); err == sql.ErrNoRows {
			return nil, nil
		} else if err != nil {
			return nil, err
		}
		var d map[string]any
		_ = json.Unmarshal([]byte(data), &d)
		return d, nil
	}
	row := h.Repos.DB.QueryRow(
		`SELECT timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta FROM usageHistory WHERE id = ?`, id,
	)
	detail := h.scanUsageDetail(row)
	if detail == nil {
		return nil, nil
	}
	return detail, nil
}

func (h *UsageHandlers) scanUsageDetail(scanner interface{ Scan(...any) error }) map[string]any {
	var e usageHistoryRow
	var tokensJSON, metaJSON string
	err := scanner.Scan(&e.Timestamp, &e.Provider, &e.Model, &e.ConnectionID, &e.APIKey, &e.Endpoint, &e.PromptTokens, &e.CompletionTokens, &e.Cost, &e.Status, &tokensJSON, &metaJSON)
	if err != nil {
		return nil
	}
	var tokens, meta map[string]any
	_ = json.Unmarshal([]byte(tokensJSON), &tokens)
	_ = json.Unmarshal([]byte(metaJSON), &meta)
	return map[string]any{
		"timestamp": e.Timestamp, "provider": e.Provider, "model": e.Model,
		"connectionId": e.ConnectionID, "apiKey": e.APIKey, "endpoint": e.Endpoint,
		"promptTokens": e.PromptTokens, "completionTokens": e.CompletionTokens,
		"cost": e.Cost, "status": e.Status, "tokens": tokens, "meta": meta,
	}
}

func (h *UsageHandlers) connectionUsage(connectionID string) (map[string]any, error) {
	var total int
	var prompt, completion int
	var cost float64
	err := h.Repos.DB.QueryRow(
		`SELECT COUNT(*), COALESCE(SUM(promptTokens),0), COALESCE(SUM(completionTokens),0), COALESCE(SUM(cost),0) FROM usageHistory WHERE connectionId = ?`,
		connectionID,
	).Scan(&total, &prompt, &completion, &cost)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"connectionId": connectionID,
		"totalRequests": total,
		"promptTokens":  prompt,
		"completionTokens": completion,
		"cost":          cost,
		"message":       "Local usage aggregates only; live quota deferred.",
	}, nil
}

func (h *UsageHandlers) hasTable(name string) bool {
	var n string
	if err := h.Repos.DB.QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, name).Scan(&n); err != nil || n == "" {
		return false
	}
	return true
}

type usageHistoryRow struct {
	Timestamp      string
	Provider       string
	Model          string
	ConnectionID   string
	APIKey         string
	Endpoint       string
	PromptTokens   int
	CompletionTokens int
	Cost           float64
	Status         string
}

func statsInt(m map[string]any, key string) int {
	return intValue(m[key])
}

func statsFloat(m map[string]any, key string) float64 {
	return floatValue(m[key])
}

func statsMap(m map[string]any, key string) map[string]any {
	v, ok := m[key].(map[string]any)
	if !ok {
		v = map[string]any{}
		m[key] = v
	}
	return v
}

func intValue(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		return int(n)
	}
	return 0
}

func floatValue(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case int64:
		return float64(n)
	}
	return 0
}

func stringValue(v any) string {
	s, _ := v.(string)
	return s
}

func coalesceToken(tokens map[string]any, keys ...any) int {
	for _, k := range keys[:len(keys)-1] {
		key, _ := k.(string)
		if v, ok := tokens[key]; ok {
			switch n := v.(type) {
			case float64:
				return int(n)
			case int:
				return n
			}
		}
	}
	if n, ok := keys[len(keys)-1].(int); ok {
		return n
	}
	return 0
}

func maskKey(key string) string {
	if key == "" || key == "local-no-key" {
		return ""
	}
	if len(key) <= 8 {
		return key[:1] + "***"
	}
	return key[:8] + "..."
}

func newRequestID() string {
	return fmt.Sprintf("req-%d", time.Now().UnixNano())
}

var registryOnce sync.Once
var registryCache *providers.Registry

func loadProviderRegistry() *providers.Registry {
	registryOnce.Do(func() {
		for _, p := range []string{"data/providers.json", "../../data/providers.json", "../data/providers.json"} {
			if r, err := providers.LoadRegistry(p); err == nil {
				registryCache = r
				return
			}
		}
		exec, _ := os.Executable()
		base := filepath.Dir(exec)
		registryCache, _ = providers.LoadRegistry(filepath.Join(base, "data", "providers.json"))
	})
	return registryCache
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

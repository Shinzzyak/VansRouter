package usage

import (
	"context"
	"sync"
	"time"
)

// Entry is a single usage record.
type Entry struct {
	Timestamp      time.Time      `json:"timestamp"`
	Provider       string         `json:"provider"`
	Model          string         `json:"model"`
	ConnectionID   string         `json:"connectionId"`
	APIKey         string         `json:"apiKey"`
	APIKeyName     string         `json:"apiKeyName"`
	Endpoint       string         `json:"endpoint"`
	PromptTokens   int            `json:"promptTokens"`
	CompletionTokens int          `json:"completionTokens"`
	TotalTokens    int            `json:"totalTokens"`
	Cost           float64        `json:"cost"`
	Status         string         `json:"status"`
	Meta           map[string]any `json:"meta"`
}

// Detail is a request-detail record.
type Detail struct {
	ID              string         `json:"id"`
	Timestamp       time.Time      `json:"timestamp"`
	Provider        string         `json:"provider"`
	Model           string         `json:"model"`
	ConnectionID    string         `json:"connectionId"`
	APIKey          string         `json:"apiKey"`
	APIKeyName      string         `json:"apiKeyName"`
	Status          string         `json:"status"`
	Latency         map[string]any `json:"latency"`
	Tokens          map[string]any `json:"tokens"`
	Request         map[string]any `json:"request"`
	ProviderRequest map[string]any `json:"providerRequest"`
	ProviderResponse map[string]any `json:"providerResponse"`
	Response        map[string]any `json:"response"`
}

// Store is the persistence interface for usage data.
type Store interface {
	SaveUsage(ctx context.Context, e Entry) error
	GetUsageHistory(ctx context.Context, filter map[string]any) ([]Entry, error)
	GetUsageStats(ctx context.Context) (map[string]any, error)

	SaveRequestDetail(ctx context.Context, d Detail) error
	GetRequestDetails(ctx context.Context, filter map[string]any) ([]Detail, int, error)
	GetRequestDetailByID(ctx context.Context, id string) (*Detail, error)
}

// ponytail: MemoryStore is a placeholder. The JS port uses better-sqlite3
// with usageHistory, usageDaily, and requestDetails tables plus batching and
// retention. Replace with a SQL-backed Store that embeds migrations when the
// DB layer is wired end-to-end.
// MemoryStore is an in-memory Store for tests and lightweight deployments.
type MemoryStore struct {
	mu      sync.RWMutex
	usage   []Entry
	details []Detail
}

// NewMemoryStore returns a fresh in-memory store.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{}
}

func (s *MemoryStore) SaveUsage(_ context.Context, e Entry) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e.Timestamp.IsZero() {
		e.Timestamp = time.Now().UTC()
	}
	if e.Status == "" {
		e.Status = "ok"
	}
	// Deduplicate by composite key (same as JS better-sqlite3 logic).
	for i, existing := range s.usage {
		if sameUsageKey(existing, e) {
			if existing.Endpoint == "" && e.Endpoint != "" {
				s.usage[i].Endpoint = e.Endpoint
			}
			return nil
		}
	}
	s.usage = append(s.usage, e)
	return nil
}

func sameUsageKey(a, b Entry) bool {
	return a.Timestamp.Equal(b.Timestamp) &&
		a.Provider == b.Provider &&
		a.Model == b.Model &&
		a.ConnectionID == b.ConnectionID &&
		a.APIKey == b.APIKey &&
		a.PromptTokens == b.PromptTokens &&
		a.CompletionTokens == b.CompletionTokens
}

func (s *MemoryStore) GetUsageHistory(_ context.Context, filter map[string]any) ([]Entry, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Entry, 0, len(s.usage))
	for _, e := range s.usage {
		if matchesUsageFilter(e, filter) {
			out = append(out, e)
		}
	}
	return out, nil
}

func matchesUsageFilter(e Entry, filter map[string]any) bool {
	if f, ok := filter["provider"].(string); ok && f != "" && e.Provider != f {
		return false
	}
	if f, ok := filter["model"].(string); ok && f != "" && e.Model != f {
		return false
	}
	if f, ok := filter["connectionId"].(string); ok && f != "" && e.ConnectionID != f {
		return false
	}
	if f, ok := filter["apiKey"].(string); ok && f != "" && e.APIKey != f {
		return false
	}
	if f, ok := filter["endpoint"].(string); ok && f != "" && e.Endpoint != f {
		return false
	}
	return true
}

func (s *MemoryStore) GetUsageStats(_ context.Context) (map[string]any, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	total := 0
	for _, e := range s.usage {
		total += e.PromptTokens + e.CompletionTokens
	}
	return map[string]any{
		"totalRequests": len(s.usage),
		"totalTokens":   total,
	}, nil
}

func (s *MemoryStore) SaveRequestDetail(_ context.Context, d Detail) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if d.ID == "" {
		d.ID = generateDetailID(d.Model)
	}
	if d.Timestamp.IsZero() {
		d.Timestamp = time.Now().UTC()
	}
	for i, existing := range s.details {
		if existing.ID == d.ID {
			s.details[i] = d
			return nil
		}
	}
	s.details = append(s.details, d)
	return nil
}

func (s *MemoryStore) GetRequestDetails(_ context.Context, filter map[string]any) ([]Detail, int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Detail, 0, len(s.details))
	for _, d := range s.details {
		if matchesDetailFilter(d, filter) {
			out = append(out, d)
		}
	}
	return out, len(out), nil
}

func matchesDetailFilter(d Detail, filter map[string]any) bool {
	if f, ok := filter["provider"].(string); ok && f != "" && d.Provider != f {
		return false
	}
	if f, ok := filter["model"].(string); ok && f != "" && d.Model != f {
		return false
	}
	if f, ok := filter["connectionId"].(string); ok && f != "" && d.ConnectionID != f {
		return false
	}
	if f, ok := filter["status"].(string); ok && f != "" && d.Status != f {
		return false
	}
	return true
}

func (s *MemoryStore) GetRequestDetailByID(_ context.Context, id string) (*Detail, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, d := range s.details {
		if d.ID == id {
			return &d, nil
		}
	}
	return nil, nil
}

func generateDetailID(model string) string {
	if model == "" {
		model = "unknown"
	}
	return time.Now().UTC().Format(time.RFC3339Nano) + "-" + model
}

// Service wraps a Store with higher-level helpers.
type Service struct {
	Store Store
}

// RecordUsage normalizes token counts and persists an Entry.
func (svc *Service) RecordUsage(ctx context.Context, e Entry) error {
	if svc.Store == nil {
		return nil
	}
	return svc.Store.SaveUsage(ctx, e)
}

// RecordRequestDetail persists a Detail.
func (svc *Service) RecordRequestDetail(ctx context.Context, d Detail) error {
	if svc.Store == nil {
		return nil
	}
	return svc.Store.SaveRequestDetail(ctx, d)
}

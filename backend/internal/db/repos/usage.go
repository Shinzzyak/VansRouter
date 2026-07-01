package repos

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// UsageEntry is a single request usage record.
type UsageEntry struct {
	ID               string
	Timestamp        string
	Provider         string
	Model            string
	ConnectionID     string
	APIKey           string
	Endpoint         string
	PromptTokens     int
	CompletionTokens int
	Cost             float64
	Status           string
	Tokens           map[string]any
	Meta             map[string]any
}

// UsageDay holds aggregated usage for one calendar day.
type UsageDay struct {
	Requests          int                       `json:"requests"`
	PromptTokens      int                       `json:"promptTokens"`
	CompletionTokens  int                       `json:"completionTokens"`
	Cost              float64                   `json:"cost"`
	ByProvider        map[string]*UsageCounter  `json:"byProvider"`
	ByModel           map[string]*UsageCounter  `json:"byModel"`
	ByAccount         map[string]*UsageCounter  `json:"byAccount"`
	ByAPIKey          map[string]*UsageCounter  `json:"byApiKey"`
	ByEndpoint        map[string]*UsageCounter  `json:"byEndpoint"`
}

// UsageCounter is an aggregate counter bucket.
type UsageCounter struct {
	Requests         int    `json:"requests"`
	PromptTokens     int    `json:"promptTokens"`
	CompletionTokens int    `json:"completionTokens"`
	Cost             float64 `json:"cost"`
	RawModel         string `json:"rawModel,omitempty"`
	Provider         string `json:"provider,omitempty"`
	APIKey           string `json:"apiKey,omitempty"`
	Endpoint         string `json:"endpoint,omitempty"`
}

// UsageRepo handles usage history, daily rollups, and lifetime counters.
type UsageRepo struct {
	db *sql.DB
}

// NewUsageRepo creates a new usage repository.
func NewUsageRepo(db *sql.DB) *UsageRepo {
	return &UsageRepo{db: db}
}

func localDateKey(ts string) string {
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		t = time.Now()
	}
	return t.Format("2006-01-02")
}

func addToCounter(target map[string]*UsageCounter, key string, vals *UsageCounter) {
	c, ok := target[key]
	if !ok {
		c = &UsageCounter{}
		target[key] = c
	}
	c.Requests += vals.Requests
	c.PromptTokens += vals.PromptTokens
	c.CompletionTokens += vals.CompletionTokens
	c.Cost += vals.Cost
}

func (r *UsageRepo) aggregateEntryToDay(day *UsageDay, e *UsageEntry) {
	day.Requests++
	day.PromptTokens += e.PromptTokens
	day.CompletionTokens += e.CompletionTokens
	day.Cost += e.Cost

	if day.ByProvider == nil {
		day.ByProvider = make(map[string]*UsageCounter)
		day.ByModel = make(map[string]*UsageCounter)
		day.ByAccount = make(map[string]*UsageCounter)
		day.ByAPIKey = make(map[string]*UsageCounter)
		day.ByEndpoint = make(map[string]*UsageCounter)
	}

	vals := &UsageCounter{
		Requests:         1,
		PromptTokens:     e.PromptTokens,
		CompletionTokens: e.CompletionTokens,
		Cost:             e.Cost,
		RawModel:         e.Model,
		Provider:         e.Provider,
	}

	if e.Provider != "" {
		addToCounter(day.ByProvider, e.Provider, vals)
	}
	modelKey := e.Model
	if e.Provider != "" {
		modelKey = fmt.Sprintf("%s|%s", e.Model, e.Provider)
	}
	addToCounter(day.ByModel, modelKey, vals)
	if e.ConnectionID != "" {
		addToCounter(day.ByAccount, e.ConnectionID, vals)
	}
	apiKeyVal := e.APIKey
	if apiKeyVal == "" {
		apiKeyVal = "local-no-key"
	}
	akKey := fmt.Sprintf("%s|%s|%s", apiKeyVal, e.Model, e.Provider)
	addToCounter(day.ByAPIKey, akKey, vals)
	endpoint := e.Endpoint
	if endpoint == "" {
		endpoint = "Unknown"
	}
	epKey := fmt.Sprintf("%s|%s|%s", endpoint, e.Model, e.Provider)
	addToCounter(day.ByEndpoint, epKey, vals)
}

// Save persists a usage entry, updates the daily rollup, and increments the lifetime counter.
func (r *UsageRepo) Save(e *UsageEntry) error {
	if e.Timestamp == "" {
		e.Timestamp = time.Now().UTC().Format(time.RFC3339)
	}
	if e.Status == "" {
		e.Status = "ok"
	}
	e.ID = uuid.New().String()

	tokens := e.Tokens
	if tokens == nil {
		tokens = make(map[string]any)
	}
	if e.PromptTokens == 0 {
		if p, ok := tokens["prompt_tokens"]; ok {
			if n, ok := p.(float64); ok {
				e.PromptTokens = int(n)
			}
		}
	}
	if e.CompletionTokens == 0 {
		if c, ok := tokens["completion_tokens"]; ok {
			if n, ok := c.(float64); ok {
				e.CompletionTokens = int(n)
			}
		}
	}

	tokensJSON, _ := json.Marshal(tokens)
	metaJSON, _ := json.Marshal(e.Meta)

	return r.withTx(func(tx *sql.Tx) error {
		if _, err := tx.Exec(
			`INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			e.Timestamp, e.Provider, e.Model, e.ConnectionID, e.APIKey, e.Endpoint,
			e.PromptTokens, e.CompletionTokens, e.Cost, e.Status, string(tokensJSON), string(metaJSON),
		); err != nil {
			return fmt.Errorf("insert usage history: %w", err)
		}

		dateKey := localDateKey(e.Timestamp)
		var data string
		if err := tx.QueryRow(`SELECT data FROM usageDaily WHERE dateKey = ?`, dateKey).Scan(&data); err != nil && err != sql.ErrNoRows {
			return fmt.Errorf("load usage daily: %w", err)
		}
		day := &UsageDay{}
		if data != "" {
			if err := json.Unmarshal([]byte(data), day); err != nil {
				day = &UsageDay{}
			}
		}
		r.aggregateEntryToDay(day, e)
		dayJSON, _ := json.Marshal(day)
		if _, err := tx.Exec(
			`INSERT INTO usageDaily(dateKey, data) VALUES(?, ?) ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data`,
			dateKey, string(dayJSON),
		); err != nil {
			return fmt.Errorf("upsert usage daily: %w", err)
		}

		var lifetime int
		if err := tx.QueryRow(`SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'`).Scan(&lifetime); err != nil && err != sql.ErrNoRows {
			return fmt.Errorf("load lifetime counter: %w", err)
		}
		if _, err := tx.Exec(
			`INSERT INTO _meta(key, value) VALUES('totalRequestsLifetime', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			fmt.Sprintf("%d", lifetime+1),
		); err != nil {
			return fmt.Errorf("increment lifetime counter: %w", err)
		}
		return nil
	})
}

// GetLifetimeCounter returns the current totalRequestsLifetime value.
func (r *UsageRepo) GetLifetimeCounter() (int, error) {
	var value string
	if err := r.db.QueryRow(`SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'`).Scan(&value); err == sql.ErrNoRows {
		return 0, nil
	} else if err != nil {
		return 0, fmt.Errorf("get lifetime counter: %w", err)
	}
	var n int
	fmt.Sscanf(value, "%d", &n)
	return n, nil
}

// ListHistory returns usage history rows ordered by id ascending.
func (r *UsageRepo) ListHistory(limit int) ([]*UsageEntry, error) {
	rows, err := r.db.Query(
		`SELECT id, timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta FROM usageHistory ORDER BY id ASC LIMIT ?`,
		limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list history: %w", err)
	}
	defer rows.Close()

	var out []*UsageEntry
	for rows.Next() {
		var e UsageEntry
		var tokensJSON, metaJSON string
		if err := rows.Scan(&e.ID, &e.Timestamp, &e.Provider, &e.Model, &e.ConnectionID, &e.APIKey, &e.Endpoint, &e.PromptTokens, &e.CompletionTokens, &e.Cost, &e.Status, &tokensJSON, &metaJSON); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(tokensJSON), &e.Tokens)
		_ = json.Unmarshal([]byte(metaJSON), &e.Meta)
		out = append(out, &e)
	}
	return out, rows.Err()
}

// GetDaily returns the aggregated data for a single date key.
func (r *UsageRepo) GetDaily(dateKey string) (*UsageDay, error) {
	var data string
	if err := r.db.QueryRow(`SELECT data FROM usageDaily WHERE dateKey = ?`, dateKey).Scan(&data); err == sql.ErrNoRows {
		return nil, nil
	} else if err != nil {
		return nil, fmt.Errorf("get daily: %w", err)
	}
	day := &UsageDay{}
	if err := json.Unmarshal([]byte(data), day); err != nil {
		return nil, fmt.Errorf("parse daily: %w", err)
	}
	return day, nil
}

func (r *UsageRepo) withTx(fn func(*sql.Tx) error) error {
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

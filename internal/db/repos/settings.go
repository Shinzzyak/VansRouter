package repos

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// DefaultSettings mirrors the JS DEFAULT_SETTINGS from src/lib/db/repos/settingsRepo.js.
// Values can be overridden by the row stored in the settings table.
var DefaultSettings = map[string]any{
	"cloudEnabled":                  false,
	"tunnelEnabled":                 false,
	"tunnelUrl":                     "",
	"tunnelProvider":                "cloudflare",
	"tailscaleEnabled":              false,
	"tailscaleUrl":                  "",
	"stickyRoundRobinLimit":         3,
	"providerStrategies":            map[string]any{},
	"comboStrategy":                 "fallback",
	"comboStickyRoundRobinLimit":    1,
	"comboStrategies":               map[string]any{},
	"requireLogin":                  true,
	"requireApiKey":                 false,
	"allowRemoteNoApiKey":           false,
	"tunnelDashboardAccess":         true,
	"authMode":                      "password",
	"oidcIssuerUrl":                 "",
	"oidcClientId":                  "",
	"oidcClientSecret":              "",
	"oidcScopes":                    "openid profile email",
	"oidcLoginLabel":                "Sign in with OIDC",
	"enableObservability":           true,
	"observabilityMaxRecords":       1000,
	"observabilityBatchSize":        20,
	"observabilityFlushIntervalMs":  5000,
	"observabilityMaxJsonSize":      5,
	"outboundProxyEnabled":          false,
	"outboundProxyUrl":              "",
	"outboundNoProxy":               "",
	"mitmRouterBaseUrl":             "http://localhost:20128",
	"dnsToolEnabled":                map[string]any{},
	"rtkEnabled":                    true,
	"headroomEnabled":               false,
	"headroomUrl":                   "http://localhost:8787",
	"headroomCompressUserMessages":  false,
	"cavemanEnabled":                false,
	"cavemanLevel":                  "full",
	"ponytailEnabled":               false,
	"ponytailLevel":                 "full",
}

// SettingsRepo reads and writes the singleton settings row.
type SettingsRepo struct {
	db *sql.DB

	mu          sync.RWMutex
	cached      map[string]any
	cachedAt    time.Time
	cacheTTL    time.Duration
	now         func() time.Time
}

// NewSettingsRepo creates a settings repository with a 5-second in-memory cache.
func NewSettingsRepo(db *sql.DB) *SettingsRepo {
	return &SettingsRepo{
		db:       db,
		cacheTTL: 5 * time.Second,
		now:      time.Now,
	}
}

// Get returns the merged settings map. It caches the result for a short TTL.
func (r *SettingsRepo) Get() (map[string]any, error) {
	r.mu.RLock()
	if r.cached != nil && r.now().Sub(r.cachedAt) < r.cacheTTL {
		defer r.mu.RUnlock()
		return cloneMap(r.cached), nil
	}
	r.mu.RUnlock()

	r.mu.Lock()
	defer r.mu.Unlock()
	// Double-check after acquiring write lock.
	if r.cached != nil && r.now().Sub(r.cachedAt) < r.cacheTTL {
		return cloneMap(r.cached), nil
	}

	raw, err := r.readRaw()
	if err != nil {
		return nil, err
	}
	merged := r.mergeWithDefaults(raw)
	r.cached = merged
	r.cachedAt = r.now()
	return cloneMap(merged), nil
}

// GetBool returns a boolean setting value, falling back to the default.
func (r *SettingsRepo) GetBool(key string) bool {
	s, err := r.Get()
	if err != nil {
		return false
	}
	v, ok := s[key].(bool)
	if !ok {
		def, _ := DefaultSettings[key].(bool)
		return def
	}
	return v
}

// GetString returns a string setting value, falling back to the default.
func (r *SettingsRepo) GetString(key string) string {
	s, err := r.Get()
	if err != nil {
		def, _ := DefaultSettings[key].(string)
		return def
	}
	v, ok := s[key].(string)
	if !ok {
		def, _ := DefaultSettings[key].(string)
		return def
	}
	return v
}

// Update applies partial updates and invalidates the cache.
func (r *SettingsRepo) Update(updates map[string]any) (map[string]any, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	raw, err := r.readRaw()
	if err != nil {
		return nil, err
	}
	next := mergeMaps(raw, updates)
	data, err := json.Marshal(next)
	if err != nil {
		return nil, fmt.Errorf("marshal settings: %w", err)
	}
	if _, err := r.db.Exec(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, string(data)); err != nil {
		return nil, fmt.Errorf("write settings: %w", err)
	}
	r.cached = r.mergeWithDefaults(next)
	r.cachedAt = r.now()
	return cloneMap(r.cached), nil
}

// PasswordHash returns the stored bcrypt password hash, if any.
func (r *SettingsRepo) PasswordHash() (string, error) {
	s, err := r.Get()
	if err != nil {
		return "", err
	}
	hash, _ := s["password"].(string)
	return hash, nil
}

// SetPasswordHash stores a bcrypt password hash in settings.
func (r *SettingsRepo) SetPasswordHash(hash string) error {
	_, err := r.Update(map[string]any{"password": hash})
	return err
}

// readRaw reads the raw settings JSON without merging defaults or caching.
func (r *SettingsRepo) readRaw() (map[string]any, error) {
	var data string
	row := r.db.QueryRow(`SELECT data FROM settings WHERE id = 1`)
	if err := row.Scan(&data); err != nil {
		if err == sql.ErrNoRows {
			return map[string]any{}, nil
		}
		return nil, fmt.Errorf("read settings: %w", err)
	}
	var raw map[string]any
	if err := json.Unmarshal([]byte(data), &raw); err != nil {
		return nil, fmt.Errorf("parse settings: %w", err)
	}
	if raw == nil {
		raw = map[string]any{}
	}
	return raw, nil
}

// mergeWithDefaults returns a new map with defaults overlaid by raw values.
func (r *SettingsRepo) mergeWithDefaults(raw map[string]any) map[string]any {
	return mergeMaps(DefaultSettings, raw)
}

// InvalidateCache clears the in-memory cache. Tests can use this to force a DB read.
func (r *SettingsRepo) InvalidateCache() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cached = nil
}

// mergeMaps returns a shallow merge of base and overlay. overlay wins on conflict.
func mergeMaps(base, overlay map[string]any) map[string]any {
	out := make(map[string]any, len(base)+len(overlay))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range overlay {
		out[k] = v
	}
	return out
}

// cloneMap returns a shallow copy of m.
func cloneMap(m map[string]any) map[string]any {
	return mergeMaps(m, nil)
}

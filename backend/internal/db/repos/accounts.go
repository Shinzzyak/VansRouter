package repos

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// Account mirrors the providerConnections table row. Extra fields are stored
// as JSON in the data column to stay compatible with the JS schema.
type Account struct {
	ID                   string
	Provider             string
	AuthType             string
	Name                 string
	Email                string
	Priority             int
	IsActive             bool
	Data                 map[string]any
	CreatedAt            string
	UpdatedAt            string
	AccessToken          string `json:"-"`
	RefreshToken         string `json:"-"`
	ExpiresAt            string `json:"-"`
	TokenType            string `json:"-"`
	Scope                string `json:"-"`
	ProjectID            string `json:"-"`
	APIKey               string `json:"-"`
	DisplayName          string `json:"-"`
	GlobalPriority       int    `json:"-"`
	DefaultModel         string `json:"-"`
	TestStatus           string `json:"-"`
	LastTested           string `json:"-"`
	LastError            string `json:"-"`
	LastErrorAt          string `json:"-"`
	RateLimitedUntil     string `json:"-"`
	ExpiresIn            int    `json:"-"`
	ErrorCode            string `json:"-"`
	ConsecutiveUseCount  int    `json:"-"`
	IDToken              string `json:"-"`
	LastRefreshAt        string `json:"-"`
	ProviderSpecificData map[string]any `json:"-"`
}

// accountCacheKey is used to key the per-filter TTL cache.
type accountCacheKey struct {
	Provider string
	IsActive string // "", "true", or "false"
}

// AccountsRepo provides CRUD for provider connection accounts with a TTL cache.
type AccountsRepo struct {
	db    *sql.DB
	cache *TTLCache[accountCacheKey, []*Account]
}

// NewAccountsRepo creates a new account repository with a 60-second list cache.
func NewAccountsRepo(db *sql.DB) *AccountsRepo {
	return &AccountsRepo{
		db:    db,
		cache: NewTTLCache[accountCacheKey, []*Account](60 * time.Second),
	}
}

var accountOptionalFields = []string{
	"displayName", "email", "globalPriority", "defaultModel",
	"accessToken", "refreshToken", "expiresAt", "tokenType",
	"scope", "projectId", "apiKey", "testStatus",
	"lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn", "errorCode",
	"consecutiveUseCount", "idToken", "lastRefreshAt",
}

func (r *AccountsRepo) rowToAccount(row *sql.Row) (*Account, error) {
	var a Account
	var data string
	var name, email sql.NullString
	var priority sql.NullInt64
	var isActive int
	err := row.Scan(&a.ID, &a.Provider, &a.AuthType, &name, &email, &priority, &isActive, &data, &a.CreatedAt, &a.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	a.Name = nullStringValue(name)
	a.Email = nullStringValue(email)
	a.Priority = int(nullInt64Value(priority))
	a.IsActive = isActive == 1
	if err := json.Unmarshal([]byte(data), &a.Data); err != nil {
		a.Data = make(map[string]any)
	}
	r.hydrateExtra(&a)
	return &a, nil
}

func (r *AccountsRepo) scanAccount(rows *sql.Rows) (*Account, error) {
	var a Account
	var data string
	var name, email sql.NullString
	var priority sql.NullInt64
	var isActive int
	if err := rows.Scan(&a.ID, &a.Provider, &a.AuthType, &name, &email, &priority, &isActive, &data, &a.CreatedAt, &a.UpdatedAt); err != nil {
		return nil, err
	}
	a.Name = nullStringValue(name)
	a.Email = nullStringValue(email)
	a.Priority = int(nullInt64Value(priority))
	a.IsActive = isActive == 1
	if err := json.Unmarshal([]byte(data), &a.Data); err != nil {
		a.Data = make(map[string]any)
	}
	r.hydrateExtra(&a)
	return &a, nil
}

func (r *AccountsRepo) hydrateExtra(a *Account) {
	if a.Data == nil {
		return
	}
	for _, f := range accountOptionalFields {
		if v, ok := a.Data[f]; ok {
			switch f {
			case "displayName":
				a.DisplayName, _ = v.(string)
			case "accessToken":
				a.AccessToken, _ = v.(string)
			case "refreshToken":
				a.RefreshToken, _ = v.(string)
			case "expiresAt":
				a.ExpiresAt, _ = v.(string)
			case "tokenType":
				a.TokenType, _ = v.(string)
			case "scope":
				a.Scope, _ = v.(string)
			case "projectId":
				a.ProjectID, _ = v.(string)
			case "apiKey":
				a.APIKey, _ = v.(string)
			case "testStatus":
				a.TestStatus, _ = v.(string)
			case "lastTested":
				a.LastTested, _ = v.(string)
			case "lastError":
				a.LastError, _ = v.(string)
			case "lastErrorAt":
				a.LastErrorAt, _ = v.(string)
			case "rateLimitedUntil":
				a.RateLimitedUntil, _ = v.(string)
			case "lastRefreshAt":
				a.LastRefreshAt, _ = v.(string)
			case "idToken":
				a.IDToken, _ = v.(string)
			case "defaultModel":
				a.DefaultModel, _ = v.(string)
			case "errorCode":
				a.ErrorCode, _ = v.(string)
			case "globalPriority":
				if n, ok := v.(float64); ok {
					a.GlobalPriority = int(n)
				}
			case "expiresIn":
				if n, ok := v.(float64); ok {
					a.ExpiresIn = int(n)
				}
			case "consecutiveUseCount":
				if n, ok := v.(float64); ok {
					a.ConsecutiveUseCount = int(n)
				}
			}
		}
	}
	if v, ok := a.Data["providerSpecificData"]; ok {
		if m, ok := v.(map[string]any); ok {
			a.ProviderSpecificData = m
		}
	}
}

func (r *AccountsRepo) accountToData(a *Account) string {
	data := make(map[string]any)
	for k, v := range a.Data {
		data[k] = v
	}
	for _, f := range accountOptionalFields {
		switch f {
		case "displayName":
			data[f] = a.DisplayName
		case "accessToken":
			data[f] = a.AccessToken
		case "refreshToken":
			data[f] = a.RefreshToken
		case "expiresAt":
			data[f] = a.ExpiresAt
		case "tokenType":
			data[f] = a.TokenType
		case "scope":
			data[f] = a.Scope
		case "projectId":
			data[f] = a.ProjectID
		case "apiKey":
			data[f] = a.APIKey
		case "testStatus":
			data[f] = a.TestStatus
		case "lastTested":
			data[f] = a.LastTested
		case "lastError":
			data[f] = a.LastError
		case "lastErrorAt":
			data[f] = a.LastErrorAt
		case "rateLimitedUntil":
			data[f] = a.RateLimitedUntil
		case "lastRefreshAt":
			data[f] = a.LastRefreshAt
		case "idToken":
			data[f] = a.IDToken
		case "defaultModel":
			data[f] = a.DefaultModel
		case "errorCode":
			data[f] = a.ErrorCode
		case "globalPriority":
			data[f] = a.GlobalPriority
		case "expiresIn":
			data[f] = a.ExpiresIn
		case "consecutiveUseCount":
			data[f] = a.ConsecutiveUseCount
		}
	}
	if a.ProviderSpecificData != nil {
		data["providerSpecificData"] = a.ProviderSpecificData
	}
	b, _ := json.Marshal(data)
	return string(b)
}

// List returns accounts matching the optional provider and active filters.
func (r *AccountsRepo) List(provider string, isActive *bool) ([]*Account, error) {
	cacheKey := accountCacheKey{Provider: provider, IsActive: activeKey(isActive)}
	if cached, ok := r.cache.Get(cacheKey); ok {
		return cached, nil
	}

	where := []string{}
	params := []any{}
	if provider != "" {
		where = append(where, "provider = ?")
		params = append(params, provider)
	}
	if isActive != nil {
		where = append(where, "isActive = ?")
		params = append(params, boolToInt(*isActive))
	}
	sqlText := `SELECT id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt FROM providerConnections`
	if len(where) > 0 {
		sqlText += " WHERE " + joinWhere(where)
	}
	sqlText += " ORDER BY priority ASC, updatedAt DESC"

	rows, err := r.db.Query(sqlText, params...)
	if err != nil {
		return nil, fmt.Errorf("list accounts: %w", err)
	}
	defer rows.Close()

	var list []*Account
	for rows.Next() {
		a, err := r.scanAccount(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, a)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	r.cache.Set(cacheKey, list)
	return list, nil
}

// GetByID returns a single account by id.
func (r *AccountsRepo) GetByID(id string) (*Account, error) {
	row := r.db.QueryRow(`SELECT id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt FROM providerConnections WHERE id = ?`, id)
	return r.rowToAccount(row)
}

// Create inserts a new provider account.
func (r *AccountsRepo) Create(a *Account) (*Account, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	a.ID = uuid.New().String()
	a.CreatedAt = now
	a.UpdatedAt = now
	if a.Data == nil {
		a.Data = make(map[string]any)
	}
	_, err := r.db.Exec(
		`INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		a.ID, a.Provider, a.AuthType, nullString(a.Name), nullString(a.Email), a.Priority, boolToInt(a.IsActive), r.accountToData(a), a.CreatedAt, a.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("create account: %w", err)
	}
	r.invalidateCache(a.Provider)
	return a, nil
}

// Update merges the provided account fields and invalidates the cache.
func (r *AccountsRepo) Update(id string, fn func(*Account)) (*Account, error) {
	existing, err := r.GetByID(id)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, nil
	}
	fn(existing)
	existing.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	_, err = r.db.Exec(
		`UPDATE providerConnections SET provider = ?, authType = ?, name = ?, email = ?, priority = ?, isActive = ?, data = ?, updatedAt = ? WHERE id = ?`,
		existing.Provider, existing.AuthType, nullString(existing.Name), nullString(existing.Email),
		existing.Priority, boolToInt(existing.IsActive), r.accountToData(existing), existing.UpdatedAt, id,
	)
	if err != nil {
		return nil, fmt.Errorf("update account: %w", err)
	}
	r.invalidateCache(existing.Provider)
	return existing, nil
}

// Delete removes an account by id and invalidates the cache.
func (r *AccountsRepo) Delete(id string) (bool, error) {
	var provider string
	if err := r.db.QueryRow(`SELECT provider FROM providerConnections WHERE id = ?`, id).Scan(&provider); err == sql.ErrNoRows {
		return false, nil
	} else if err != nil {
		return false, fmt.Errorf("delete account lookup: %w", err)
	}
	res, err := r.db.Exec(`DELETE FROM providerConnections WHERE id = ?`, id)
	if err != nil {
		return false, fmt.Errorf("delete account: %w", err)
	}
	n, _ := res.RowsAffected()
	if n > 0 {
		r.invalidateCache(provider)
	}
	return n > 0, nil
}

func (r *AccountsRepo) invalidateCache(provider string) {
	r.cache.InvalidateAll()
	_ = provider
}

func nullString(s string) sql.NullString {
	return sql.NullString{String: s, Valid: s != ""}
}

func nullStringValue(ns sql.NullString) string {
	if ns.Valid {
		return ns.String
	}
	return ""
}

func nullInt64Value(ni sql.NullInt64) int64 {
	if ni.Valid {
		return ni.Int64
	}
	return 0
}

func activeKey(isActive *bool) string {
	if isActive == nil {
		return ""
	}
	if *isActive {
		return "true"
	}
	return "false"
}

func joinWhere(parts []string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += " AND "
		}
		out += p
	}
	return out
}

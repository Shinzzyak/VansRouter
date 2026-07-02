package dashboard

import (
	"encoding/json"
	"net/http"

	"github.com/9router/9router/internal/db/repos"
	"github.com/9router/9router/internal/providers"
)

// ProvidersHandlers holds provider-connection dependencies.
type ProvidersHandlers struct {
	Repos    *repos.Repos
	Registry *providers.Registry
}

// NewProvidersHandlers creates providers handlers.
func NewProvidersHandlers(repos *repos.Repos) *ProvidersHandlers {
	return &ProvidersHandlers{Repos: repos}
}

// ListConnections handles GET /api/providers.
func (h *ProvidersHandlers) ListConnections(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET required")
		return
	}

	connections, err := h.Repos.Accounts.List("", nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	safeConnections := make([]map[string]any, 0, len(connections))
	for _, c := range connections {
		m := connectionToMap(c)
		delete(m, "apiKey")
		delete(m, "accessToken")
		delete(m, "refreshToken")
		delete(m, "idToken")
		safeConnections = append(safeConnections, m)
	}

	aliasMap := make(map[string]string)
	providerList := make([]map[string]any, 0)
	if h.Registry != nil {
		for id, p := range h.Registry.Providers {
			if p.Alias != "" && p.Alias != id {
				aliasMap[p.Alias] = id
			}
			aliases := resolveAliases(p.Aliases)
			displayName := id
			if p.Display != nil {
				var disp struct {
					Name string `json:"name"`
				}
				_ = json.Unmarshal(p.Display, &disp)
				if disp.Name != "" {
					displayName = disp.Name
				}
			}
			providerList = append(providerList, map[string]any{
				"id":           id,
				"alias":        p.Alias,
				"aliases":      aliases,
				"displayName":  displayName,
				"noAuth":       p.NoAuth,
				"serviceKinds": p.ServiceKinds,
			})
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"connections": safeConnections,
		"aliasMap":    aliasMap,
		"providers":   providerList,
	})
}

// connectionToMap converts a repos.Account into a flat map matching the JS
// provider connection response shape.
func connectionToMap(a *repos.Account) map[string]any {
	m := map[string]any{
		"id":                     a.ID,
		"provider":               a.Provider,
		"authType":               a.AuthType,
		"name":                   a.Name,
		"email":                  a.Email,
		"priority":               a.Priority,
		"isActive":               a.IsActive,
		"displayName":            a.DisplayName,
		"globalPriority":         a.GlobalPriority,
		"defaultModel":           a.DefaultModel,
		"testStatus":             a.TestStatus,
		"lastTested":             a.LastTested,
		"lastError":              a.LastError,
		"lastErrorAt":            a.LastErrorAt,
		"rateLimitedUntil":       a.RateLimitedUntil,
		"expiresIn":              a.ExpiresIn,
		"errorCode":              a.ErrorCode,
		"consecutiveUseCount":    a.ConsecutiveUseCount,
		"lastRefreshAt":          a.LastRefreshAt,
		"providerSpecificData":   a.ProviderSpecificData,
		"data":                   a.Data,
		"createdAt":              a.CreatedAt,
		"updatedAt":              a.UpdatedAt,
	}
	for k, v := range a.Data {
		if _, ok := m[k]; !ok {
			m[k] = v
		}
	}
	return m
}

func resolveAliases(raw json.RawMessage) []string {
	var out []string
	_ = json.Unmarshal(raw, &out)
	return out
}

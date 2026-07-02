package dashboard

import (
	"encoding/json"
	"net/http"
	"os"

	"github.com/9router/9router/internal/auth"
	"github.com/9router/9router/internal/db/repos"
)

// SettingsHandlers holds settings dependencies.
type SettingsHandlers struct {
	Settings *repos.SettingsRepo
}

// NewSettingsHandlers creates settings handlers.
func NewSettingsHandlers(settings *repos.SettingsRepo) *SettingsHandlers {
	return &SettingsHandlers{Settings: settings}
}

// GetSettings handles GET /api/settings.
func (h *SettingsHandlers) GetSettings(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET required")
		return
	}
	s, err := h.Settings.Get()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	resp := h.sanitizeSettings(s)
	resp["enableRequestLogs"] = os.Getenv("ENABLE_REQUEST_LOGS") == "true"
	resp["enableTranslator"] = os.Getenv("ENABLE_TRANSLATOR") == "true"
	writeJSON(w, http.StatusOK, resp)
}

// UpdateSettings handles PATCH /api/settings.
func (h *SettingsHandlers) UpdateSettings(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPatch {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "PATCH required")
		return
	}
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON body")
		return
	}

	// Strip protected keys.
	delete(body, "password")
	delete(body, "mitmSudoEncrypted")

	// Handle password change.
	if newPassword, ok := body["newPassword"].(string); ok && newPassword != "" {
		current, err := h.Settings.Get()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		storedHash, _ := current["password"].(string)
		currentPassword, _ := body["currentPassword"].(string)

		if storedHash != "" {
			if currentPassword == "" {
				writeError(w, http.StatusBadRequest, "current_password_required", "Current password required")
				return
			}
			if !auth.CheckPassword(currentPassword, storedHash) {
				writeError(w, http.StatusUnauthorized, "invalid_current_password", "Invalid current password")
				return
			}
		} else {
			if currentPassword != "" && currentPassword != "123456" {
				writeError(w, http.StatusUnauthorized, "invalid_current_password", "Invalid current password")
				return
			}
		}

		hash, err := auth.HashPassword(newPassword)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		body["password"] = hash
		delete(body, "newPassword")
		delete(body, "currentPassword")
	}

	// Trim empty OIDC client secret.
	if v, ok := body["oidcClientSecret"].(string); ok && v == "" {
		delete(body, "oidcClientSecret")
	}

	updated, err := h.Settings.Update(body)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	// ponytail: outbound proxy env application and combo rotation reset are
	// deferred; they require the corresponding Go services to be wired.

	writeJSON(w, http.StatusOK, h.sanitizeSettings(updated))
}

// sanitizeSettings removes secrets and adds derived fields.
func (h *SettingsHandlers) sanitizeSettings(s map[string]any) map[string]any {
	resp := cloneMap(s)
	delete(resp, "password")
	delete(resp, "oidcClientSecret")

	issuer := stringSetting(resp, "oidcIssuerUrl", "")
	clientID := stringSetting(resp, "oidcClientId", "")
	_, hasSecret := s["oidcClientSecret"]
	resp["oidcConfigured"] = issuer != "" && clientID != "" && hasSecret
	resp["hasPassword"] = false
	if hash, ok := s["password"].(string); ok && hash != "" {
		resp["hasPassword"] = true
	}
	return resp
}

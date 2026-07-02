package dashboard

import (
	"encoding/json"
	"net/http"
	"os"

	"github.com/9router/9router/internal/auth"
	"github.com/9router/9router/internal/db/repos"
)

// AuthHandlers holds dashboard auth dependencies.
type AuthHandlers struct {
	Settings *repos.SettingsRepo
	Limiter  *auth.LoginLimiter
}

// NewAuthHandlers creates auth handlers backed by settings and a login limiter.
func NewAuthHandlers(settings *repos.SettingsRepo) *AuthHandlers {
	return &AuthHandlers{
		Settings: settings,
		Limiter:  auth.NewLoginLimiter(),
	}
}

// LoginRequest is the body for POST /api/auth/login.
type LoginRequest struct {
	Password string `json:"password"`
}

// LoginResponse is the body returned by POST /api/auth/login.
type LoginResponse struct {
	Success          bool `json:"success"`
	MustChangePassword bool `json:"mustChangePassword"`
}

const resetHint = "Forgot password? Reset to default via 9Router CLI → Settings → Reset Password to Default."

// Login handles POST /api/auth/login.
func (h *AuthHandlers) Login(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST required")
		return
	}

	ip := clientIP(r)
	if lock := h.Limiter.IsLocked(ip, ""); lock.Locked {
		writeRateLimit(w, lock.RetryAfter)
		return
	}

	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON body")
		return
	}

	settings, err := h.Settings.Get()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	storedHash, _ := settings["password"].(string)
	initialPassword := os.Getenv("INITIAL_PASSWORD")
	if initialPassword == "" {
		initialPassword = "123456"
	}

	var valid bool
	if storedHash != "" {
		valid = auth.CheckPassword(req.Password, storedHash)
	} else {
		valid = req.Password == initialPassword
	}

	if !valid {
		res := h.Limiter.RecordFailure(ip, "")
		if lock := h.Limiter.IsLocked(ip, ""); lock.Locked {
			writeRateLimit(w, lock.RetryAfter)
			return
		}
		writeError(w, http.StatusUnauthorized, "invalid_password", "Invalid password. "+remainingText(res.RemainingBeforeLock))
		return
	}

	h.Limiter.ClearOnSuccess(ip, "")

	token, err := auth.IssueSession("admin", "admin")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	auth.SetSessionCookie(w, token, auth.ShouldUseSecureCookie(r))

	mustChange := storedHash == "" && os.Getenv("INITIAL_PASSWORD") == "" && !isLocalRequest(r)
	writeJSON(w, http.StatusOK, LoginResponse{Success: true, MustChangePassword: mustChange})
}

// Logout handles POST /api/auth/logout.
func (h *AuthHandlers) Logout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST required")
		return
	}
	auth.ClearSessionCookie(w)
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// StatusResponse is the body for GET /api/auth/status.
type StatusResponse struct {
	Authenticated bool   `json:"authenticated"`
	AuthMode      string `json:"authMode"`
	OidcConfigured bool  `json:"oidcConfigured"`
}

// Status handles GET /api/auth/status.
func (h *AuthHandlers) Status(w http.ResponseWriter, r *http.Request) {
	session := SessionFromRequest(r)
	settings, _ := h.Settings.Get()
	authMode := stringSetting(settings, "authMode", "password")
	writeJSON(w, http.StatusOK, StatusResponse{
		Authenticated:  session != nil,
		AuthMode:       authMode,
		OidcConfigured: authMode == "oidc" && isOidcConfigured(settings),
	})
}

// Check handles GET /api/auth/check.
func (h *AuthHandlers) Check(w http.ResponseWriter, r *http.Request) {
	session := SessionFromRequest(r)
	if session == nil {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Not authenticated")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"authenticated": true})
}

// ResetPassword handles POST /api/auth/reset-password.
func (h *AuthHandlers) ResetPassword(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST required")
		return
	}
	var req struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON body")
		return
	}
	if req.Password == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "Password required")
		return
	}
	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := h.Settings.SetPasswordHash(hash); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

func writeRateLimit(w http.ResponseWriter, retryAfter int) {
	w.Header().Set("Retry-After", string(rune('0'+retryAfter)))
	writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many failed attempts. Try again later. "+resetHint)
}

func remainingText(n int) string {
	if n == 1 {
		return "1 attempt left before lockout."
	}
	return "Attempts left before lockout."
}

func isOidcConfigured(settings map[string]any) bool {
	issuer := stringSetting(settings, "oidcIssuerUrl", "")
	clientID := stringSetting(settings, "oidcClientId", "")
	return issuer != "" && clientID != ""
}

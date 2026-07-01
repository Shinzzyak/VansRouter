package auth

import (
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

const (
	// SessionCookieName is the name of the dashboard session cookie.
	SessionCookieName = "session"
	// DefaultBcryptCost matches the bcryptjs default used by the JS backend.
	DefaultBcryptCost = 10
	// sessionTTL matches the JS "24h" JWT expiration.
	sessionTTL = 24 * time.Hour
)

// Stable dev fallback secret. Production deployments must set JWT_SECRET.
const devFallbackJWTSecret = "9router-dev-jwt-secret-do-not-use-in-production"

// Session holds the verified dashboard session claims.
type Session struct {
	UserID    string
	Role      string
	ExpiresAt time.Time
}

func jwtSecret() string {
	if s := os.Getenv("JWT_SECRET"); s != "" {
		return s
	}
	return devFallbackJWTSecret
}

// IssueSession creates a new JWT for the dashboard and returns the signed
// token string. The token carries the same field names as the JS backend
// (authenticated, userID, role) and expires after 24 hours.
func IssueSession(userID, role string) (string, error) {
	now := time.Now()
	claims := jwt.MapClaims{
		"authenticated": true,
		"userID":        userID,
		"role":          role,
		"iat":           now.Unix(),
		"exp":           now.Add(sessionTTL).Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(jwtSecret()))
}

// VerifySession parses and validates a session JWT and returns the extracted
// session. It returns nil for missing, malformed, or expired tokens.
func VerifySession(tokenString string) (*Session, error) {
	if strings.TrimSpace(tokenString) == "" {
		return nil, fmt.Errorf("missing session token")
	}
	token, err := jwt.Parse(tokenString, func(token *jwt.Token) (any, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return []byte(jwtSecret()), nil
	}, jwt.WithValidMethods([]string{"HS256"}))
	if err != nil {
		return nil, err
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("invalid session claims")
	}

	exp, err := claims.GetExpirationTime()
	if err != nil {
		return nil, err
	}

	s := &Session{
		UserID:    stringClaim(claims, "userID"),
		Role:      stringClaim(claims, "role"),
		ExpiresAt: exp.Time,
	}
	return s, nil
}

// VerifySessionBool returns true only when the token is present and valid.
func VerifySessionBool(tokenString string) bool {
	_, err := VerifySession(tokenString)
	return err == nil
}

// HashPassword hashes a plaintext password with bcrypt using the same default
// cost as the JS backend.
func HashPassword(password string) (string, error) {
	if password == "" {
		return "", fmt.Errorf("password cannot be empty")
	}
	bytes, err := bcrypt.GenerateFromPassword([]byte(password), DefaultBcryptCost)
	if err != nil {
		return "", err
	}
	return string(bytes), nil
}

// CheckPassword compares a plaintext password against a bcrypt hash.
func CheckPassword(password, hash string) bool {
	if password == "" || hash == "" {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

// ShouldUseSecureCookie decides whether the session cookie should be marked
// Secure. It mirrors the JS logic: AUTH_COOKIE_SECURE=true forces it, or the
// request indicates HTTPS via x-forwarded-proto.
func ShouldUseSecureCookie(r *http.Request) bool {
	if os.Getenv("AUTH_COOKIE_SECURE") == "true" {
		return true
	}
	if r == nil {
		return false
	}
	return strings.ToLower(r.Header.Get("x-forwarded-proto")) == "https"
}

// SetSessionCookie writes the session token as an httpOnly cookie with the
// same attributes as the JS backend.
func SetSessionCookie(w http.ResponseWriter, token string, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    token,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		Path:     "/",
	})
}

// ClearSessionCookie expires the session cookie.
func ClearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    "",
		HttpOnly: true,
		Secure:   false,
		SameSite: http.SameSiteLaxMode,
		Path:     "/",
		MaxAge:   -1,
	})
}

func stringClaim(claims jwt.MapClaims, key string) string {
	v, ok := claims[key].(string)
	if !ok {
		return ""
	}
	return v
}

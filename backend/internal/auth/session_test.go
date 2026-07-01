package auth

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSessionIssueAndVerify(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret-for-session-tests")

	token, err := IssueSession("user-42", "admin")
	require.NoError(t, err)
	require.NotEmpty(t, token)

	session, err := VerifySession(token)
	require.NoError(t, err)
	require.NotNil(t, session)
	assert.Equal(t, "user-42", session.UserID)
	assert.Equal(t, "admin", session.Role)
	assert.WithinDuration(t, time.Now().Add(sessionTTL), session.ExpiresAt, 5*time.Second)
	assert.True(t, VerifySessionBool(token))
}

func TestSessionVerifyMissing(t *testing.T) {
	session, err := VerifySession("")
	assert.Error(t, err)
	assert.Nil(t, session)
	assert.False(t, VerifySessionBool(""))
}

func TestSessionVerifyMalformed(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret")

	for _, token := range []string{"not.a.token", "bearer token", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"} {
		session, err := VerifySession(token)
		assert.Error(t, err, "token=%q", token)
		assert.Nil(t, session, "token=%q", token)
	}
}

func TestSessionVerifyExpired(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret")

	claims := jwt.MapClaims{
		"authenticated": true,
		"userID":        "old-user",
		"role":          "user",
		"iat":           time.Now().Add(-48 * time.Hour).Unix(),
		"exp":           time.Now().Add(-24 * time.Hour).Unix(),
	}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte("test-secret"))
	require.NoError(t, err)

	session, err := VerifySession(token)
	assert.Error(t, err)
	assert.Nil(t, session)
	assert.False(t, VerifySessionBool(token))
}

func TestSessionVerifyWrongSecret(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret")

	token, err := IssueSession("user-1", "user")
	require.NoError(t, err)

	t.Setenv("JWT_SECRET", "different-secret")
	session, err := VerifySession(token)
	assert.Error(t, err)
	assert.Nil(t, session)
}

func TestSessionVerifyClaimsMissing(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret")

	claims := jwt.MapClaims{
		"authenticated": true,
		"exp":           time.Now().Add(sessionTTL).Unix(),
	}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte("test-secret"))
	require.NoError(t, err)

	session, err := VerifySession(token)
	require.NoError(t, err)
	assert.Equal(t, "", session.UserID)
	assert.Equal(t, "", session.Role)
}

func TestSessionPasswordHash(t *testing.T) {
	hash, err := HashPassword("hunter2")
	require.NoError(t, err)
	require.NotEmpty(t, hash)

	assert.True(t, CheckPassword("hunter2", hash))
	assert.False(t, CheckPassword("wrong", hash))
	assert.False(t, CheckPassword("", hash))
	assert.False(t, CheckPassword("hunter2", ""))
}

func TestSessionPasswordHashEmpty(t *testing.T) {
	_, err := HashPassword("")
	assert.Error(t, err)
}

func TestSessionCookieHelpers(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret")

	t.Run("set secure cookie", func(t *testing.T) {
		rec := httptest.NewRecorder()
		SetSessionCookie(rec, "token-value", true)

		resp := rec.Result()
		cookies := resp.Cookies()
		require.Len(t, cookies, 1)
		c := cookies[0]
		assert.Equal(t, SessionCookieName, c.Name)
		assert.Equal(t, "token-value", c.Value)
		assert.True(t, c.HttpOnly)
		assert.True(t, c.Secure)
		assert.Equal(t, http.SameSiteLaxMode, c.SameSite)
		assert.Equal(t, "/", c.Path)
	})

	t.Run("set insecure cookie", func(t *testing.T) {
		rec := httptest.NewRecorder()
		SetSessionCookie(rec, "token-value", false)

		resp := rec.Result()
		cookies := resp.Cookies()
		require.Len(t, cookies, 1)
		assert.False(t, cookies[0].Secure)
	})

	t.Run("clear cookie", func(t *testing.T) {
		rec := httptest.NewRecorder()
		ClearSessionCookie(rec)

		resp := rec.Result()
		cookies := resp.Cookies()
		require.Len(t, cookies, 1)
		c := cookies[0]
		assert.Equal(t, SessionCookieName, c.Name)
		assert.Equal(t, "", c.Value)
		assert.Equal(t, -1, c.MaxAge)
	})
}

func TestSessionShouldUseSecureCookie(t *testing.T) {
	t.Run("forced via env", func(t *testing.T) {
		t.Setenv("AUTH_COOKIE_SECURE", "true")
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		assert.True(t, ShouldUseSecureCookie(req))
	})

	t.Run("env false does not force secure but still trusts forwarded proto", func(t *testing.T) {
		t.Setenv("AUTH_COOKIE_SECURE", "false")
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("x-forwarded-proto", "https")
		// env=false just means it does not force secure; HTTPS detection still applies.
		assert.True(t, ShouldUseSecureCookie(req))
	})

	t.Run("https via forwarded proto", func(t *testing.T) {
		t.Setenv("AUTH_COOKIE_SECURE", "")
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("x-forwarded-proto", "https")
		assert.True(t, ShouldUseSecureCookie(req))
	})

	t.Run("http by default", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		assert.False(t, ShouldUseSecureCookie(req))
	})

	t.Run("nil request", func(t *testing.T) {
		assert.False(t, ShouldUseSecureCookie(nil))
	})
}

func TestSessionFallsBackToDevSecret(t *testing.T) {
	// Remove any JWT_SECRET from the environment to exercise the fallback.
	t.Setenv("JWT_SECRET", "")

	token, err := IssueSession("dev-user", "admin")
	require.NoError(t, err)

	session, err := VerifySession(token)
	require.NoError(t, err)
	assert.Equal(t, "dev-user", session.UserID)
}

func TestSessionSecretReadsEnv(t *testing.T) {
	t.Setenv("JWT_SECRET", "from-env")

	// The helper reads os.Getenv each time, so a token issued under one secret
	// must not verify under a different one.
	token, err := IssueSession("u", "r")
	require.NoError(t, err)

	require.NoError(t, os.Unsetenv("JWT_SECRET"))
	_, err = VerifySession(token)
	assert.Error(t, err)
}

func TestSessionVerifyRejectsNoneAlg(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret")

	claims := jwt.MapClaims{
		"authenticated": true,
		"userID":        "u",
		"role":          "r",
		"exp":           time.Now().Add(sessionTTL).Unix(),
	}
	token, err := jwt.NewWithClaims(jwt.SigningMethodNone, claims).SignedString(jwt.UnsafeAllowNoneSignatureType)
	require.NoError(t, err)

	session, err := VerifySession(token)
	assert.Error(t, err)
	assert.Nil(t, session)
}

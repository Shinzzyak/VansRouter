package auth

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/9router/9router/backend/internal/db"
	"github.com/9router/9router/backend/internal/db/repos"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestExtractAPIKey(t *testing.T) {
	t.Run("bearer", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.Header.Set("Authorization", "Bearer sk-test")
		assert.Equal(t, "sk-test", ExtractAPIKey(r))
	})
	t.Run("x-api-key", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.Header.Set("x-api-key", "ak-test")
		assert.Equal(t, "ak-test", ExtractAPIKey(r))
	})
	t.Run("bearer wins over x-api-key", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.Header.Set("Authorization", "Bearer bearer-key")
		r.Header.Set("x-api-key", "x-key")
		assert.Equal(t, "bearer-key", ExtractAPIKey(r))
	})
	t.Run("missing", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		assert.Equal(t, "", ExtractAPIKey(r))
	})
}

func TestAPIKeyMiddleware(t *testing.T) {
	dbConn, cleanup := openAuthTestDB(t)
	defer cleanup()
	rp := repos.New(dbConn)
	_, err := rp.Keys.Create("test", "m1", "sk-ok")
	require.NoError(t, err)

	mw := APIKeyMiddleware(rp.Keys)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := APIKeyFromContext(r.Context())
		if key == nil {
			http.Error(w, "no context", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(key.Key))
	}))

	t.Run("valid key", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.Header.Set("Authorization", "Bearer sk-ok")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		assert.Equal(t, http.StatusOK, w.Code)
		assert.Equal(t, "sk-ok", w.Body.String())
	})
	t.Run("missing key", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		assert.Equal(t, http.StatusUnauthorized, w.Code)
	})
	t.Run("invalid key", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.Header.Set("Authorization", "Bearer sk-bad")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		assert.Equal(t, http.StatusUnauthorized, w.Code)
	})
}

func openAuthTestDB(t *testing.T) (*sql.DB, func()) {
	t.Helper()
	dir := t.TempDir()
	database, err := db.Open(filepath.Join(dir, "test.db"))
	require.NoError(t, err)
	require.NoError(t, db.Migrate(database))
	return database, func() {
		_ = database.Close()
	}
}

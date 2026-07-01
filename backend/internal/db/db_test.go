package db

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func openTestDB(t *testing.T) (*sql.DB, func()) {
	t.Helper()
	dir := t.TempDir()
	db, err := Open(dir)
	require.NoError(t, err)
	require.NoError(t, Migrate(db))
	return db, func() {
		_ = db.Close()
	}
}

func TestMigrate(t *testing.T) {
	db, cleanup := openTestDB(t)
	defer cleanup()

	var version int
	err := db.QueryRow(`SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1`).Scan(&version)
	require.NoError(t, err)
	assert.GreaterOrEqual(t, version, 1)

	// Running migrations again should be idempotent.
	require.NoError(t, Migrate(db))
	var count int
	err = db.QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&count)
	require.NoError(t, err)
	assert.Equal(t, 2, count)
}

func TestOpenCreatesDataDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "data")
	db, err := Open(dir)
	require.NoError(t, err)
	defer db.Close()

	info, err := os.Stat(dir)
	require.NoError(t, err)
	assert.True(t, info.IsDir())
}

package repos

import (
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/9router/9router/internal/db"
	"github.com/stretchr/testify/require"
)

func openReposTestDB(t *testing.T) (*sql.DB, func()) {
	t.Helper()
	dir := t.TempDir()
	database, err := db.Open(filepath.Join(dir, "test.db"))
	require.NoError(t, err)
	require.NoError(t, db.Migrate(database))
	return database, func() {
		_ = database.Close()
	}
}

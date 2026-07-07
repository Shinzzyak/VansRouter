package db

import (
	"database/sql"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"
)

func TestMigrate_NodejsDB(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	require.NoError(t, err)
	defer db.Close()

	// Simulate a Node.js 9Router DB with _meta table
	_, err = db.Exec(`
		CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		INSERT INTO _meta (key, value) VALUES ('schemaVersion', '3');
		INSERT INTO _meta (key, value) VALUES ('appVersion', '0.8.6');
		
		CREATE TABLE apiKeys (
			id TEXT PRIMARY KEY,
			key TEXT UNIQUE NOT NULL,
			name TEXT,
			machineId TEXT,
			isActive INTEGER DEFAULT 1,
			createdAt TEXT NOT NULL,
			allowedProviders TEXT,
			allowedCombos TEXT,
			allowedKinds TEXT
		);
		
		CREATE TABLE combos (
			id TEXT PRIMARY KEY,
			name TEXT UNIQUE NOT NULL,
			kind TEXT,
			models TEXT NOT NULL,
			createdAt TEXT NOT NULL,
			updatedAt TEXT NOT NULL
		);
		
		INSERT INTO apiKeys VALUES ('test-key', 'sk-test', 'test', 'machine1', 1, '2024-01-01', NULL, NULL, NULL);
		INSERT INTO combos VALUES ('combo1', 'default', 'llm', '["gpt-4"]', '2024-01-01', '2024-01-01');
	`)
	require.NoError(t, err)

	// Run migration
	err = Migrate(db)
	require.NoError(t, err, "Migrate should succeed on Node.js DB")

	// Verify schema_migrations was populated
	var count int
	err = db.QueryRow("SELECT COUNT(*) FROM schema_migrations").Scan(&count)
	require.NoError(t, err)
	assert.Greater(t, count, 0, "schema_migrations should have entries")

	// Verify existing data preserved
	var keyCount int
	err = db.QueryRow("SELECT COUNT(*) FROM apiKeys").Scan(&keyCount)
	require.NoError(t, err)
	assert.Equal(t, 1, keyCount, "apiKeys data should be preserved")

	var comboCount int
	err = db.QueryRow("SELECT COUNT(*) FROM combos").Scan(&comboCount)
	require.NoError(t, err)
	assert.Equal(t, 1, comboCount, "combos data should be preserved")
}

func TestDetectNodejsVersion(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	require.NoError(t, err)
	defer db.Close()

	// Test 1: No _meta table
	ver := detectNodejsVersion(db)
	assert.Equal(t, 0, ver, "should return 0 when no _meta table")

	// Test 2: _meta table exists but no schemaVersion
	_, err = db.Exec("CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
	require.NoError(t, err)
	ver = detectNodejsVersion(db)
	assert.Equal(t, 0, ver, "should return 0 when no schemaVersion")

	// Test 3: schemaVersion exists
	_, err = db.Exec("INSERT INTO _meta (key, value) VALUES ('schemaVersion', '3')")
	require.NoError(t, err)
	ver = detectNodejsVersion(db)
	assert.Equal(t, 3, ver, "should return 3 when schemaVersion=3")
}

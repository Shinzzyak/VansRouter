package db

import (
	"database/sql"
	"embed"
	"fmt"
	"path"
	"sort"
	"strconv"
	"strings"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// migrationRecord describes one embedded migration file.
type migrationRecord struct {
	Version int
	Name    string
	SQL     string
}

// loadMigrations reads and sorts all embedded migration files by version.
func loadMigrations() ([]migrationRecord, error) {
	entries, err := migrationsFS.ReadDir("migrations")
	if err != nil {
		return nil, fmt.Errorf("read migrations dir: %w", err)
	}

	var records []migrationRecord
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		base := strings.TrimSuffix(entry.Name(), ".sql")
		parts := strings.SplitN(base, "_", 2)
		if len(parts) != 2 {
			return nil, fmt.Errorf("invalid migration name %q", entry.Name())
		}
		version, err := strconv.Atoi(parts[0])
		if err != nil {
			return nil, fmt.Errorf("invalid migration version in %q: %w", entry.Name(), err)
		}
		sqlBytes, err := migrationsFS.ReadFile(path.Join("migrations", entry.Name()))
		if err != nil {
			return nil, fmt.Errorf("read migration %q: %w", entry.Name(), err)
		}
		records = append(records, migrationRecord{
			Version: version,
			Name:    parts[1],
			SQL:     string(sqlBytes),
		})
	}

	sort.Slice(records, func(i, j int) bool {
		return records[i].Version < records[j].Version
	})
	return records, nil
}

// Migrate runs all embedded migrations that have not yet been applied.
// It uses a schema_migrations table to track applied versions.
func Migrate(db *sql.DB) error {
	records, err := loadMigrations()
	if err != nil {
		return err
	}

	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	for _, rec := range records {
		var applied bool
		if err := db.QueryRow(`SELECT 1 FROM schema_migrations WHERE version = ?`, rec.Version).Scan(&applied); err != nil && err != sql.ErrNoRows {
			return fmt.Errorf("check migration %d: %w", rec.Version, err)
		}
		if applied {
			continue
		}

		tx, err := db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration %d: %w", rec.Version, err)
		}
		if _, err := tx.Exec(rec.SQL); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("apply migration %d (%s): %w", rec.Version, rec.Name, err)
		}
		if _, err := tx.Exec(`INSERT INTO schema_migrations (version) VALUES (?)`, rec.Version); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("record migration %d: %w", rec.Version, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration %d: %w", rec.Version, err)
		}
	}
	return nil
}

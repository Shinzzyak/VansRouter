package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/9router/9router/backend/internal/api"
	"github.com/9router/9router/backend/internal/config"
	"github.com/9router/9router/backend/internal/db"
	"github.com/9router/9router/backend/internal/log"
	"github.com/9router/9router/backend/internal/providers"
)

func main() {
	if err := run(); err != nil {
		if !errors.Is(err, http.ErrServerClosed) {
			fmt.Fprintf(os.Stderr, "server error: %v\n", err)
			os.Exit(1)
		}
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	logger, err := log.New(string(cfg.LogLevel))
	if err != nil {
		return fmt.Errorf("init logger: %w", err)
	}

	server, cleanup, err := newServer(cfg, logger)
	if err != nil {
		return err
	}
	defer cleanup()

	listener, err := net.Listen("tcp", fmt.Sprintf(":%d", cfg.Port))
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	logger.Info("starting server", slog.String("addr", listener.Addr().String()))

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	errChan := make(chan error, 1)
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errChan <- err
		}
	}()

	select {
	case <-stop:
		logger.Info("shutdown signal received")
	case err := <-errChan:
		return err
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return server.Shutdown(shutdownCtx)
}

func newServer(cfg *config.Config, logger *slog.Logger) (*http.Server, func(), error) {
	database, err := db.Open(cfg.DBPath())
	if err != nil {
		return nil, nil, fmt.Errorf("open database: %w", err)
	}

	if err := db.Migrate(database); err != nil {
		database.Close()
		return nil, nil, fmt.Errorf("migrate database: %w", err)
	}

	registry, err := providers.LoadRegistry(registryPath())
	if err != nil {
		database.Close()
		return nil, nil, fmt.Errorf("load registry: %w", err)
	}
	logger.Info("loaded provider registry", slog.Int("count", len(registry.Providers)))

	router := api.Routes(logger)
	return &http.Server{Handler: router}, func() { database.Close() }, nil
}

func registryPath() string {
	// In tests and dev builds the source lives under backend/cmd/server.
	// Walk up from this source file until we find backend/data/providers.json.
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		return filepath.Join("data", "providers.json")
	}
	dir := filepath.Dir(file)
	for {
		candidate := filepath.Join(dir, "data", "providers.json")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return filepath.Join("data", "providers.json")
}

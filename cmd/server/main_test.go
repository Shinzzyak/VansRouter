package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/9router/9router/internal/config"
	"github.com/9router/9router/internal/log"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestServerStart(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DATA_DIR", dir)
	t.Setenv("PORT", "0")

	cfg, err := config.Load()
	require.NoError(t, err)

	logger, err := log.New("info")
	require.NoError(t, err)

	server, cleanup, err := newServer(cfg, logger)
	require.NoError(t, err)
	defer cleanup()

	listener, err := net.Listen("tcp", ":0")
	require.NoError(t, err)
	defer listener.Close()

	go func() {
		_ = server.Serve(listener)
	}()

	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}()

	baseURL := "http://" + listener.Addr().String()
	resp, err := http.Get(baseURL + "/health")
	require.NoError(t, err)
	defer resp.Body.Close()

	assert.Equal(t, http.StatusOK, resp.StatusCode)

	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	assert.JSONEq(t, `{"status":"ok"}`, string(body))

	assert.FileExists(t, filepath.Join(dir, "db", "data.sqlite"))
}

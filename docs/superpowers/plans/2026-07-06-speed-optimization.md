# Go Backend Speed Optimization Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve end-to-end request throughput and latency of the Go backend with minimal, stdlib-only changes.

**Architecture:** Keep the existing chi router, handler structure, and SQLite storage. Apply targeted optimizations at the edges that dominate latency: HTTP server tuning, request middleware, upstream connection reuse, API-key validation caching, and model-list data loading. No new dependencies; no speculative abstractions.

**Tech Stack:** Go 1.24, chi router, modernc.org/sqlite, stdlib `net/http`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `cmd/server/main.go` | Creates `http.Server`; needs timeout/connection tuning |
| `internal/api/middleware/logger.go` | Access log middleware; allocates per request |
| `internal/api/middleware/cors.go` | Sets CORS headers on every request |
| `internal/auth/apikey.go` | Resolves API key from DB on every protected request |
| `internal/db/repos/keys.go` | DB access for API keys |
| `internal/models/models.go` | Builds model list; calls Source 5 times per build |
| `internal/models/sql_source.go` | DB-backed Source implementation |
| `internal/providers/executors/proxy.go` | Shared upstream HTTP client/transport |
| `internal/providers/executors/base.go` | Upstream request executor |
| `internal/sse/chat.go` | Streaming chat response copy path |

---

## Task 1: Tune `http.Server` Timeouts and Limits

**Files:**
- Modify: `cmd/server/main.go:90`

**Why:** Default `http.Server` has no read/write/idle timeouts and unlimited header bytes. Under load this leaks connections and exposes the server to slowloris-style attacks.

- [ ] **Step 1: Add server tuning constants**

  Edit `cmd/server/main.go` and add these constants near the top:

  ```go
  const (
      readTimeout       = 30 * time.Second
      readHeaderTimeout = 10 * time.Second
      writeTimeout      = 0 // streaming endpoints manage their own deadlines
      idleTimeout       = 120 * time.Second
      maxHeaderBytes    = 1 << 20 // 1 MiB
  )
  ```

- [ ] **Step 2: Configure `http.Server`**

  Replace the return in `newServer`:

  ```go
  return &http.Server{
      Handler:           router,
      ReadTimeout:       readTimeout,
      ReadHeaderTimeout: readHeaderTimeout,
      WriteTimeout:      writeTimeout,
      IdleTimeout:       idleTimeout,
      MaxHeaderBytes:    maxHeaderBytes,
  }, func() { database.Close() }, nil
  ```

- [ ] **Step 3: Build and run smoke test**

  Run:
  ```bash
  go build ./cmd/server
  JWT_SECRET=test-secret DATA_DIR=/tmp/9router-data-smoke PORT=20128 ./9router-server &
  curl -s -o /dev/null -w '%{http_code}\n' --max-time 10 http://localhost:20128/health
  ```
  Expected output: `200`

- [ ] **Step 4: Commit**

  ```bash
  git add cmd/server/main.go
  git commit -m "perf(server): tune http.Server timeouts and limits"
  ```

---

## Task 2: Reduce Request Logger Allocations

**Files:**
- Modify: `internal/api/middleware/logger.go`

**Why:** `statusRecorder` wraps `http.ResponseWriter` and counts bytes by adding every write. The wrapper allocation per request is small but non-zero on hot paths.

- [ ] **Step 1: Write a micro-benchmark**

  Create `internal/api/middleware/logger_bench_test.go`:

  ```go
  package middleware

  import (
      "net/http"
      "net/http/httptest"
      "testing"

      "log/slog"
      "os"
  )

  func BenchmarkRequestLogger(b *testing.B) {
      logger := slog.New(slog.NewTextHandler(io.Discard, nil))
      handler := RequestLogger(logger)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
          w.WriteHeader(http.StatusOK)
          w.Write([]byte("ok"))
      }))

      b.ReportAllocs()
      b.ResetTimer()
      for i := 0; i < b.N; i++ {
          req := httptest.NewRequest(http.MethodGet, "/health", nil)
          rec := httptest.NewRecorder()
          handler.ServeHTTP(rec, req)
      }
  }
  ```

  Run:
  ```bash
  go test ./internal/api/middleware -bench=BenchmarkRequestLogger -benchmem
  ```
  Expected: benchmark completes; note baseline alloc/op.

- [ ] **Step 2: Replace byte counter with response size header**

  Since the access log only needs bytes for non-streaming responses, skip the wrapper allocation entirely. Change `RequestLogger` to:

  ```go
  func RequestLogger(logger *slog.Logger) func(http.Handler) http.Handler {
      return func(next http.Handler) http.Handler {
          return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
              start := time.Now()
              next.ServeHTTP(w, r)
              logger.LogAttrs(r.Context(), slog.LevelInfo, "http_request",
                  slog.String("method", r.Method),
                  slog.String("path", r.URL.Path),
                  slog.String("query", r.URL.RawQuery),
                  slog.Int("status", http.StatusOK), // placeholder, see step 3
                  slog.String("ip", ClientIP(r)),
                  slog.String("ua", r.UserAgent()),
                  slog.Duration("duration", time.Since(start)),
              )
          })
      }
  }
  ```

  This is intentionally a placeholder; the real fix is Step 3.

- [ ] **Step 3: Use `http.responseController` or a lightweight atomic status recorder**

  Keep the wrapper but store only `status` via an `atomic.Int32` and drop the byte counter. Replace `statusRecorder` with:

  ```go
  type statusRecorder struct {
      http.ResponseWriter
      status atomic.Int32
  }

  func (s *statusRecorder) WriteHeader(code int) {
      s.status.Store(int32(code))
      s.ResponseWriter.WriteHeader(code)
  }

  func (s *statusRecorder) statusCode() int {
      if c := s.status.Load(); c != 0 {
          return int(c)
      }
      return http.StatusOK
  }
  ```

  Update `RequestLogger` to use `rec.statusCode()` and remove the `bytes` log field.

- [ ] **Step 4: Update tests and run benchmark**

  Run:
  ```bash
  go test ./internal/api/middleware -bench=BenchmarkRequestLogger -benchmem
  ```
  Expected: fewer allocations per op than baseline.

- [ ] **Step 5: Commit**

  ```bash
  git add internal/api/middleware/logger.go internal/api/middleware/logger_bench_test.go
  git commit -m "perf(middleware): reduce request logger allocations"
  ```

---

## Task 3: Skip CORS Processing for Internal Requests

**Files:**
- Modify: `internal/api/middleware/cors.go`

**Why:** CORS headers are set unconditionally on every request even when the caller is the local dashboard (same origin) or a CLI tool that doesn't need them.

- [ ] **Step 1: Add origin check helper**

  Add to `internal/api/middleware/cors.go`:

  ```go
  func requiresCORS(r *http.Request) bool {
      origin := r.Header.Get("Origin")
      if origin == "" {
          return false
      }
      host := r.Host
      if h, _, err := net.SplitHostPort(host); err == nil {
          host = h
      }
      o, err := url.Parse(origin)
      if err != nil {
          return true
      }
      oh := o.Hostname()
      if oh == host || oh == "localhost" || oh == "127.0.0.1" {
          return false
      }
      return true
  }
  ```

  Add imports `net`, `net/url`.

- [ ] **Step 2: Early-return when CORS not needed**

  Update `Wrap`:

  ```go
  func (c *CORS) Wrap(next http.Handler) http.Handler {
      origin := c.AllowOrigin
      return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
          if !requiresCORS(r) {
              if r.Method == http.MethodOptions {
                  w.WriteHeader(http.StatusNoContent)
                  return
              }
              next.ServeHTTP(w, r)
              return
          }
          // existing CORS header logic
          ...
      })
  }
  ```

- [ ] **Step 3: Run tests**

  ```bash
  go test ./internal/api/middleware
  ```
  Expected: PASS

- [ ] **Step 4: Commit**

  ```bash
  git add internal/api/middleware/cors.go
  git commit -m "perf(middleware): skip CORS headers for same-origin requests"
  ```

---

## Task 4: Cache Valid API Keys In-Memory

**Files:**
- Modify: `internal/auth/apikey.go`
- Modify: `internal/db/repos/keys.go`

**Why:** Every `/v1/*` request performs a SQLite lookup for the API key. This serializes on the DB lock and is the hottest path in the proxy.

- [ ] **Step 1: Add cache to KeysRepo**

  Modify `internal/db/repos/keys.go`:

  ```go
  type KeysRepo struct {
      db *sql.DB
      // positive cache: key string -> *APIKey
      cache   map[string]*APIKey
      cacheMu sync.RWMutex
      cacheTTL time.Duration
  }
  ```

  Initialize in constructor:

  ```go
  func NewKeysRepo(db *sql.DB) *KeysRepo {
      return &KeysRepo{
          db:       db,
          cache:    make(map[string]*APIKey),
          cacheTTL: 5 * time.Second,
      }
  }
  ```

- [ ] **Step 2: Implement cached GetByKey**

  Add helper:

  ```go
  type cachedKey struct {
      key   *APIKey
      expiry time.Time
  }

  func (r *KeysRepo) GetByKey(key string) (*APIKey, error) {
      r.cacheMu.RLock()
      if ent, ok := r.cache[key]; ok && time.Now().Before(ent.expiry) {
          r.cacheMu.RUnlock()
          return ent.key, nil
      }
      r.cacheMu.RUnlock()

      info, err := r.getByKeyDB(key)
      if err != nil {
          return nil, err
      }

      r.cacheMu.Lock()
      r.cache[key] = cachedKey{key: info, expiry: time.Now().Add(r.cacheTTL)}
      r.cacheMu.Unlock()
      return info, nil
  }
  ```

  Rename existing `GetByKey` to `getByKeyDB`.

- [ ] **Step 3: Add cache invalidation hook**

  In `CreateKey`, `UpdateKey`, `DeleteKey` of `KeysRepo`, clear the cached entry after mutation.

- [ ] **Step 4: Update tests**

  Run:
  ```bash
  go test ./internal/db/repos ./internal/auth
  ```
  Expected: PASS

- [ ] **Step 5: Commit**

  ```bash
  git add internal/db/repos/keys.go internal/auth/apikey.go
  git commit -m "perf(auth): cache valid API keys with short TTL"
  ```

---

## Task 5: Batch Model Source Queries Into One DB Round Trip

**Files:**
- Modify: `internal/models/models.go`
- Modify: `internal/models/sql_source.go`
- Create: `internal/models/source_snapshot.go`

**Why:** `Builder.load()` calls `Source.Combos`, `Connections`, `CustomModels`, `ModelAliases`, `DisabledByAlias` — five separate DB round trips per cache miss.

- [ ] **Step 1: Add Snapshot type to Source interface**

  Create `internal/models/source_snapshot.go`:

  ```go
  package models

  type SourceSnapshot struct {
      Combos         []Combo
      Connections    []Connection
      CustomModels   []CustomModel
      ModelAliases   map[string]string
      DisabledByAlias map[string][]string
  }
  ```

- [ ] **Step 2: Extend Source interface with Snapshot method**

  In `internal/models/models.go`, add to `Source`:

  ```go
  Snapshot(ctx context.Context) (*SourceSnapshot, error)
  ```

- [ ] **Step 3: Implement Snapshot in SQL source**

  In `internal/models/sql_source.go`, add a method that runs the five queries in one function (still sequential; one transaction optional) and returns the snapshot. Keep existing methods for backward compatibility.

  ```go
  func (s *SQLSource) Snapshot(ctx context.Context) (*SourceSnapshot, error) {
      combos, err := s.Combos(ctx)
      if err != nil { return nil, err }
      conns, err := s.Connections(ctx)
      if err != nil { return nil, err }
      customs, err := s.CustomModels(ctx)
      if err != nil { return nil, err }
      aliases, err := s.ModelAliases(ctx)
      if err != nil { return nil, err }
      disabled, err := s.DisabledByAlias(ctx)
      if err != nil { return nil, err }
      return &SourceSnapshot{
          Combos:          combos,
          Connections:     conns,
          CustomModels:    customs,
          ModelAliases:    aliases,
          DisabledByAlias: disabled,
      }, nil
  }
  ```

- [ ] **Step 4: Use Snapshot in Builder**

  In `internal/models/models.go`, change `Builder.load` to:

  ```go
  func (b *Builder) load(ctx context.Context) (*SourceSnapshot, error) {
      snap, err := b.src.Snapshot(ctx)
      if err != nil {
          return nil, err
      }
      return snap, nil
  }
  ```

  Update `BuildModelsList` and `cachedAllowList` to read from `snap.*` fields.

- [ ] **Step 5: Update test fake**

  In test files, implement `Snapshot` on the fake source by calling the existing methods.

- [ ] **Step 6: Run tests**

  ```bash
  go test ./internal/models
  ```
  Expected: PASS

- [ ] **Step 7: Commit**

  ```bash
  git add internal/models/source_snapshot.go internal/models/models.go internal/models/sql_source.go
  git commit -m "perf(models): batch model source queries into single snapshot"
  ```

---

## Task 6: Add `sync.Pool` for JSON Encode Buffers

**Files:**
- Modify: `internal/api/v1/chat.go`
- Modify: `internal/api/v1/common.go`
- Modify: `internal/sse/chat.go`

**Why:** Many handlers allocate `bytes.Buffer` for JSON encoding on every request.

- [ ] **Step 1: Add shared buffer pool**

  Create `internal/api/v1/buffer_pool.go`:

  ```go
  package v1

  import (
      "bytes"
      "sync"
  )

  var jsonBufferPool = sync.Pool{
      New: func() any { return new(bytes.Buffer) },
  }

  func acquireJSONBuffer() *bytes.Buffer {
      b := jsonBufferPool.Get().(*bytes.Buffer)
      b.Reset()
      return b
  }

  func releaseJSONBuffer(b *bytes.Buffer) {
      if b != nil {
          b.Reset()
          jsonBufferPool.Put(b)
      }
  }
  ```

- [ ] **Step 2: Use pool in chat handler error path**

  In `internal/api/v1/chat.go` `writeError`, if it currently allocates, replace with pool usage. If it already uses a fixed helper, update that helper.

  Example helper:

  ```go
  func writeJSONError(w http.ResponseWriter, status int, code, message string) {
      w.Header().Set("Content-Type", "application/json")
      w.WriteHeader(status)
      buf := acquireJSONBuffer()
      defer releaseJSONBuffer(buf)
      json.NewEncoder(buf).Encode(map[string]any{"error": map[string]any{"type": code, "message": message}})
      w.Write(buf.Bytes())
  }
  ```

- [ ] **Step 3: Run tests**

  ```bash
  go test ./internal/api/v1
  ```
  Expected: PASS

- [ ] **Step 4: Commit**

  ```bash
  git add internal/api/v1/buffer_pool.go internal/api/v1/chat.go
  git commit -m "perf(v1): reuse JSON encode buffers via sync.Pool"
  ```

---

## Task 7: Final Verification

- [ ] **Step 1: Full build and test**

  ```bash
  go build ./cmd/server
  go test ./...
  ```
  Expected: build succeeds; all tests pass.

- [ ] **Step 2: End-to-end smoke test**

  Start the server:
  ```bash
  JWT_SECRET=test-secret DATA_DIR=/tmp/9router-data-smoke PORT=20128 ./9router-server &
  ```

  Run smoke:
  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' http://localhost:20128/health
  curl -s -o /dev/null -w '%{http_code}\n' http://localhost:20128/v1/models
  ```
  Expected: `200` for both.

- [ ] **Step 3: Optional micro-benchmark regression check**

  Run logger benchmark from Task 2 again and confirm lower allocs/op than baseline.

- [ ] **Step 4: Commit any final fixes**

---

## Out of Scope (per ponytail)

- Replacing SQLite with another database.
- Custom connection pooling beyond stdlib `http.Transport`.
- Rewriting the translator to avoid allocations; measured first before attempting.
- Adding distributed caches (Redis/memcached).
- Async usage batching; `MemoryStore` is already in-memory and the SQL path is not wired end-to-end yet.

These are valid future optimizations only after profiling shows they matter.

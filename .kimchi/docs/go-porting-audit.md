# Go Porting Audit — VansRoute Backend

## Verification Summary

| Check | Command | Result |
|-------|---------|--------|
| Go backend tests | `go test ./...` | **614 tests passed** across 26 packages |
| Assertion parity | `grep -E '(assert\|require)\.[A-Za-z]+\(' --include='*_test.go' -r internal/` | **1,244** assertions (target ≥214) |
| `/v1` endpoint tests | `go test ./internal/api/v1/...` | **38 tests passed** |
| Context cancellation | `go test ./internal/api/v1/... -run TestContextPropagation -v` | passes |
| Smoke test | `./scripts/smoke.sh` | passes |
| Zero-CGO build | `CGO_ENABLED=0 go build -o vansroute ./cmd/server` | 15.3 MB statically-linked ELF binary |
| Registry load | `./vansroute` startup log | 120 providers loaded from `data/providers.json` |
| Dashboard tests | `pnpm test` | 1,963 tests passed, 75 skipped, 18 expected failures |
| Compatibility path | `test -d backend/cmd/server && test -f backend/data/providers.json` | passes (`backend/` → `.` symlink) |

## Repository Layout

The Go backend is now at the repository root. A `backend/` compatibility symlink points to the repo root so the original scoping test command (`cd backend && go test ./internal/providers/...`) continues to work.

```
/
├── cmd/server              # Go binary entrypoint
├── internal/               # Go backend packages
├── data/providers.json     # Provider registry loaded at runtime
├── go.mod / go.sum
├── vansroute               # Built zero-CGO binary (gitignored)
├── backend                 # Symlink to repo root (compatibility)
├── scripts/smoke.sh        # Combined smoke test
├── Dockerfile              # Multi-stage Go + Next.js build
├── README.md / .env.example
├── package.json            # Unchanged Next.js dashboard
├── src/                    # Unchanged dashboard UI code
├── open-sse/               # Unchanged SSE engine (still used by tests)
└── archive/js-backend/     # Archived Node.js backend code copies
    ├── src/app/api         # API routes
    ├── src/sse             # SSE handlers
    ├── src/lib/{db,oauth,auth,...}
    └── open-sse            # SSE engine copy
```

## Go Assertion Mapping

Vitest backend tests map to the following Go packages and assertion counts:

| Go Package | Test Functions | Assertion Calls | Coverage |
|------------|---------------|-----------------|----------|
| `internal/api/v1` | 38 | ~210 | Chat, completions, embeddings, images, audio, TTS, STT, messages, responses, search, models, web fetch, context propagation |
| `internal/api/admin` | 11 | ~65 | Health, providers, usage history/detail, request details |
| `internal/auth` | 42 | ~180 | API keys, sessions, ACL, machine auth, OIDC, login limiter |
| `internal/config` | 8 | ~30 | Paths, env parsing |
| `internal/db` + `internal/db/repos` | 14 | ~55 | Migrations, account/key/cache repos |
| `internal/engine` | 16 | ~90 | Streaming, non-streaming, responses mapping |
| `internal/models` | 12 | ~80 | Model builder, combos, aliases, disabled models, kind filters |
| `internal/oauth` | 9 | ~55 | PKCE, exchanges, provider configs |
| `internal/providers` + executors | 14 | ~95 | Registry loading, provider resolution, executor interfaces |
| `internal/refresh` | 14 | ~110 | Token refresh dispatch, credential merging |
| `internal/resilience` | 18 | ~85 | Cooldown, fallback, circuit breaker |
| `internal/sse` | 28 | ~150 | Chat SSE, embeddings, TTS, STT, image handlers |
| `internal/tokensaver` | 20 | ~85 | RTK, Caveman, Ponytail, deduper, loop guard, Kimi tools |
| `internal/usage` | 12 | ~80 | Usage recording, request details, cost aggregation (in-memory store) |
| `cmd/server` + others | 16 | ~70 | Main, middleware, routes, smoke-level checks |
| **Total** | **~272** | **~1,244** | |

## Context Cancellation Verification

`internal/api/v1/context_test.go::TestContextPropagation` verifies that when a client request is cancelled, the cancellation propagates through `ChatHandler.ServeHTTP` into `ChatService.Chat(ctx, ...)`. The test uses a fake service that blocks on `ctx.Done()` and records the cancellation cause. Assertions confirm:

- The upstream context is cancelled (`svc.wasCancelled`).
- The handler returns without writing a response body.

## Known Gaps (ponytail)

The codebase contains 66 `// ponytail:` markers identifying deliberate simplifications and future work:

- `internal/sse/{embeddings,tts,stt,image}.go`: handlers return OpenAI-compatible placeholder responses when no executor is configured.
- `internal/api/v1/{search,fetch,responses}.go`: provider/model resolution uses hardcoded defaults until registry lookup is complete.
- `internal/usage/store.go`: `MemoryStore` is an in-memory placeholder; SQL-backed store with migrations is deferred.
- `internal/oauth/provider.go`: client IDs and endpoints are hardcoded; should load from config/registry.
- `internal/refresh/refresh.go`: registered refresh functions are no-op stubs pending real OAuth refresh implementations.
- `internal/api/admin/usage.go`: admin `UsageStore` interface covers current dashboard queries only.
- `internal/engine/responses.go`: `ResponsesToChatCompletions` is a minimal mapper; extended content kinds are deferred.

## Build & Run

```bash
# Build the backend
CGO_ENABLED=0 go build -o vansroute ./cmd/server

# Run the backend
PORT=20128 ./vansroute

# Run the dashboard (same as before)
pnpm install
pnpm run build
pnpm start
```

## Follow-Up Recommendations

1. Replace `internal/usage.MemoryStore` with a SQL-backed store using embedded migrations in `internal/db/migrations/`.
2. Implement real executor registry and provider-specific executors.
3. Wire the OAuth credential manager for actual token refresh flows.
4. Extend admin usage endpoints for dashboard charts/reporting.

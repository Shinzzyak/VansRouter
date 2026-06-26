<div align="center">

  # ⚡ VansRoute

  ### Universal AI Gateway — One Endpoint, Every Provider

  **Circuit breaker resilience · Kimchi CLI-native · RTK token compression · 40+ providers**

  [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
  [![Tests](https://img.shields.io/badge/tests-149%20passing-brightgreen)](#-testing)
  [![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](./package.json)
  [![Next.js](https://img.shields.io/badge/Next.js-16-black)](./package.json)

  [🚀 Quick Start](#-quick-start) • [💡 Features](#-features) • [🔄 Architecture](#-architecture) • [📊 Comparison](#-how-vansroute-compares) • [📖 Docs](#-setup-guide) • [🙏 Credits](#-credits--references)
</div>

---

## ❓ Why VansRoute?

You connect Claude Code, Codex, Cursor, Cline, or any OpenAI-compatible CLI to one endpoint. VansRoute handles the rest:

- **Circuit breaker** — if a provider dies, VansRoute trips the breaker and routes to the next one. No more "1 error → all error" cascade.
- **Account semaphore** — per-account concurrency limiter prevents hammering one account with 10 simultaneous requests.
- **Kimchi CLI-native** — VansRoute's Kimchi provider mimics the official Kimchi CLI exactly: same 5 models, same capabilities, same temperature rules, same structured output flags.
- **Quota auto-reactivation** — when Kimchi credits run out, the account is parked until the 1st of next month, then auto-reactivated. No manual babysitting.
- **RTK + Caveman + Ponytail** — stacked token compression saves 15-95% on tool outputs.
- **Per-API-key ACL** — hand out keys that can only touch specific providers, combos, or model kinds.

---

## 🚀 Quick Start

```bash
git clone https://github.com/Vanszs/VansRouter.git
cd VansRouter
pnpm install
pnpm run build
cp -r public .next/standalone/public
cp -r .next/static .next/standalone/.next/static
PORT=20127 node .next/standalone/server.js
```

Open `http://localhost:20127/dashboard`, add your provider API keys, generate a VansRoute API key, and point your CLI tool to:

```
http://localhost:20127/v1
```

---

## 💡 Features

### Resilience Engine

| Feature | What it does |
|---------|-------------|
| **Circuit Breaker** | Per-provider state machine: CLOSED → DEGRADED → OPEN → HALF_OPEN. After 5 failures, provider is skipped entirely until probe succeeds. Adaptive backoff escalates on repeated failures. |
| **Account Semaphore** | Per `provider:connectionId` concurrency limiter with FIFO queue and 30s timeout. Prevents rate-limit cascades from concurrent requests to the same account. |
| **Provider Failure Tracking** | `recordProviderFailure()` with 5s dedup per connection. Only failure-eligible status codes (408, 429, 500, 502, 503, 504) count toward the breaker. |
| **Provider Exhaustion Detection** | `isProviderExhaustedReason()` lets the combo router skip all remaining targets from an exhausted provider. |
| **Quota Auto-Reactivation** | Kimchi accounts deactivated due to credit exhaustion are automatically reactivated on the 1st of each month via a Next.js instrumentation hook + hourly timer. |

### Kimchi CLI Alignment

VansRoute's `kimchi` provider is configured to be indistinguishable from the official Kimchi CLI:

- Exactly **5 models** from the Kimchi CLI catalog
- Capabilities copied field-for-field from `https://models.dev/api.json`
- Per-model `temperature`, `structuredOutput`, `thinkingCanDisable`, `vision`, `videoInput`
- Param stripping matches CLI `temperature:false` flags

| Model | Reasoning | Vision | Temperature | Structured Output |
|-------|-----------|--------|-------------|-------------------|
| `kimi-k2.7` | ✅ toggle off | ✅ + video | ❌ | ✅ |
| `kimi-k2.6` | ✅ toggle | ✅ + video | ✅ | ✅ |
| `minimax-m3` | ✅ | ✅ | ✅ | — |
| `nemotron-3-ultra-fp4` | ❌ | ❌ | ✅ | — |
| `glm-5.2-fp8` | ✅ (OpenAI) | ❌ | ✅ | — |

### Token Compression

| Saver | What it does |
|-------|-------------|
| **RTK** | Compresses `tool_result` content before sending upstream |
| **Caveman** | Instructs the model to respond in ultra-terse mode |
| **Ponytail** | Forces the laziest (simplest) code output |

### Provider Support

40+ providers including: Kimchi (CLI-aligned), AgentRouter ($200 free), GitHub Copilot, Codex, Gemini CLI, OpenCode, Kilo, NVIDIA NIM, OpenRouter, and more.

### Format Translation

OpenAI ↔ Claude ↔ Gemini ↔ Kiro — transparent format conversion so any CLI tool works with any provider.

---

## 🔄 Architecture

```
┌─────────────┐
│  Your CLI   │  (Claude Code, Codex, Cursor, Cline, OpenCode...)
└──────┬──────┘
       │ POST http://localhost:20127/v1/chat/completions
       ↓
┌──────────────────────────────────────────────────────┐
│                   VansRoute Engine                     │
│                                                        │
│  1. Circuit Breaker check (skip dead providers)        │
│  2. Account Semaphore (queue if at concurrency cap)   │
│  3. RTK / Caveman / Ponytail injection                │
│  4. Format translation (OpenAI ↔ Claude ↔ Gemini)     │
│  5. Kimchi CLI-aligned param stripping                 │
│  6. Executor → upstream provider                       │
│  7. Response translation back to client format         │
│                                                        │
│  On success: clearProviderFailure()                    │
│  On error:  recordProviderFailure() → breaker counts   │
│             markAccountUnavailable() → try next acct   │
│             Kimchi quota? → deactivate until month end │
└──────────────────────────────────────────────────────┘
       │
       ├─→ Kimchi (5 CLI models, quota auto-reactivation)
       ├─→ AgentRouter ($200 free credits, passthrough)
       ├─→ GitHub Copilot / Codex (subscription tier)
       ├─→ Gemini CLI / OpenCode (free tier)
       └─→ OpenRouter / NVIDIA / others
```

---

## 📊 How VansRoute Compares

| Capability | VansRoute | Typical routers |
|-----------|-----------|-----------------|
| Circuit breaker (provider-level) | ✅ In-memory, no DB dependency | ❌ or DB-backed |
| Account concurrency limiter | ✅ FIFO + timeout | ❌ |
| Kimchi CLI-native config | ✅ 5 models, per-model caps | ❌ |
| Quota auto-reactivation (monthly) | ✅ Kimchi-specific | ❌ |
| RTK token compression | ✅ Stacked (RTK + Caveman + Ponytail) | Partial or none |
| Per-API-key ACL | ✅ Providers + combos + kinds | ❌ |
| NVIDIA Kimi stream coercion | ✅ `stream:false` upstream, SSE back | ❌ |
| AgentRouter passthrough | ✅ $200 free credits | ❌ |
| Format translation | ✅ OpenAI ↔ Claude ↔ Gemini ↔ Kiro | Partial |

---

## 📖 Setup Guide

### 1. Install & Build

```bash
git clone https://github.com/Vanszs/VansRouter.git
cd VansRouter
pnpm install
pnpm run build
cp -r public .next/standalone/public
cp -r .next/static .next/standalone/.next/static
```

### 2. Start

```bash
PORT=20127 node .next/standalone/server.js
```

Or with PM2:
```bash
PORT=3003 pm2 start .next/standalone/server.js --name vansroute
pm2 save
```

### 3. Configure

1. Open `http://localhost:20127/dashboard`
2. Add provider connections (API keys)
3. Generate a VansRoute API key
4. Point your CLI to `http://localhost:20127/v1`

### 4. Kimchi Models

Use any of the 5 CLI-aligned models:

```json
{
  "model": "kimchi/kimi-k2.6",
  "baseURL": "http://localhost:20127/v1",
  "apiKey": "your-vansroute-key"
}
```

When Kimchi credits run out, the account is auto-parked until the 1st of next month. No manual intervention needed.

---

## 🧪 Testing

```bash
pnpm test                          # All tests
pnpm test tests/unit/              # Unit tests only

# Targeted resilience + Kimchi audit suite (149 tests)
npx vitest run --config tests/vitest.config.js --pool=forks \
  tests/unit/kimi-max-tokens.test.js \
  tests/unit/kimchi-cli-derived.test.js \
  tests/unit/kimchi-cli-config.test.js \
  tests/unit/kimchi-quota-reactivation.test.js \
  tests/unit/loop-guard.test.js \
  tests/unit/loop-guard-wiring.test.js \
  tests/unit/termination-prompt.test.js \
  tests/unit/kimi-nvidia-hardening.test.js \
  tests/unit/kimi-native-tool-parser.test.js \
  tests/translator/thinking-unified.test.js
```

---

## 📁 Structure

```
VansRouter/
├── src/
│   ├── shared/utils/
│   │   └── circuitBreaker.js              # Circuit breaker (CLOSED→OPEN→HALF_OPEN)
│   ├── sse/
│   │   ├── handlers/chat.js               # Retry loop with breaker + semaphore
│   │   └── services/
│   │       └── kimchiQuotaReactivation.js  # Monthly auto-reactivation
│   ├── instrumentation.js                 # Next.js startup hook
│   └── app/                               # Dashboard + API routes
├── open-sse/
│   ├── services/
│   │   ├── accountFallback.js             # + provider failure tracking
│   │   └── accountSemaphore.js            # Per-account concurrency limiter
│   ├── utils/
│   │   └── circuitBreaker.js              # Copy for open-sse import path
│   ├── providers/registry/
│   │   ├── kimchi.js                      # 5 CLI-aligned models
│   │   └── agentrouter.js                 # Passthrough ($200 free)
│   └── handlers/chatCore.js               # Core SSE engine
├── tests/unit/
│   ├── kimchi-cli-config.test.js          # CLI alignment tests
│   ├── kimchi-quota-reactivation.test.js  # Auto-reactivation tests
│   └── ...                                # Full audit suite
└── .docs/audit/                           # Audit documentation
```

---

## 🙏 Credits & References

VansRoute builds on the work of two excellent open-source projects:

- **[VansRoute](https://github.com/decolua/VansRoute)** by [@decolua](https://github.com/decolua) — the foundation: provider registry, RTK token saver, format translation, combo strategies, per-API-key ACL. VansRoute started as a hardened fork of VansRoute and retains full format compatibility.

- **[OmniRoute](https://github.com/diegosouzapw/OmniRoute)** by [@diegosouzapw](https://github.com/diegosouzapw) — the resilience inspiration: circuit breaker pattern, account semaphore, provider-level failure tracking, provider exhaustion detection. VansRoute ported these concepts from OmniRoute's TypeScript implementation to plain JavaScript ESM, simplified the persistence layer (in-memory instead of DB-backed), and added Kimchi-specific quota auto-reactivation.

Full credit to both projects. VansRoute stands on their work.

---

## 📄 License

MIT — see [LICENSE](./LICENSE)

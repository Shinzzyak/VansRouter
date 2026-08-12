<div align="center">

# VansRouter

**One OpenAI-compatible endpoint for all your AI coding tools — routed across 40+ providers with automatic fallback, token-saving, and zero-downtime failover.**

Connect Claude Code, Codex, Cursor, Cline, Copilot, Gemini, OpenCode & more to a single self-hosted gateway that speaks OpenAI **and** Anthropic formats — then let combos, capacity adapters, and a token saver handle the rest.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/Shinzzyak/VansRouter)](https://github.com/Shinzzyak/VansRouter/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/Shinzzyak/VansRouter/build-deploy-pm2.yml?label=CI%20build)](https://github.com/Shinzzyak/VansRouter/actions/workflows/build-deploy-pm2.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22.5-339933?logo=node.js&logoColor=white)](package.json)
[![GitHub stars](https://img.shields.io/github/stars/Shinzzyak/VansRouter?style=social)](https://github.com/Shinzzyak/VansRouter/stargazers)

[Quick Start](#-quick-start) · [Features](#-features) · [Architecture](#-architecture) · [Tech Stack](#-tech-stack) · [Development](#-development)

</div>

---

## 🤔 Why VansRouter?

- ❌ Subscription quotas expire unused every month
- ❌ Rate limits interrupt your flow mid-coding
- ❌ Tool outputs (`git diff`, `grep`, `ls`…) burn tokens fast
- ❌ Manual switching between providers

**VansRouter fixes all of it** — one base URL, automatic routing, and a token saver that cuts tool-output cost by 20–40%.

---

## ✨ Features

### 🔀 Combo strategies
Route each request through a named **combo** — an ordered list of models with a strategy:

| Strategy | What it does |
|---|---|
| **Fallback** | Try models in order; on failure (5xx, timeout, quota, 429) move to the next — zero downtime |
| **Round-robin** | Rotate across models/accounts to spread load and stay under rate limits |
| **Fusion** | Merge several models into one response pipeline |
| **Capacity adapter** | Auto-switch to adapter-pool models when the request needs capabilities the combo lacks |

### 🧠 Think-Execute (2-pass reasoning)
Combo requests can run a two-pass pipeline: a **think** pass (non-streaming, plans/tool-calls) followed by an **execute** pass (streaming with real tool execution). Tool-call plans are forwarded raw to the executor — no echoed plans, no loops.

### 🪙 RTK Token Saver
Auto-compresses `tool_result` content before it reaches the model — **save 20–40% tokens per request** with zero prompt changes. Works with Claude Code, Codex, Cursor, Cline and any tool-calling client.

### 🛡️ Resilience, built in
- **Circuit breaker** — per-`provider:proxy` keyed; a dead upstream or proxy never blocks the others (only 5xx/timeouts trip it, 429s don't)
- **Account semaphore** — per-provider concurrency limits with proxy awareness
- **Provider exhaustion detection** — quota/limit errors are recognized and routed around, not retried blindly
- **Model lockout** — failing models are temporarily parked and skipped

### 🔌 Universal compatibility
- **OpenAI-compatible** `/v1` endpoint and **Anthropic-compatible** route — point any client at one URL
- **Format translation** between OpenAI ↔ Claude ↔ Gemini ↔ Kiro
- **Per-API-key ACL** — scope which keys can use which models

### 📊 Dashboard
- Combo builder UI (drag-and-drop model panels, per-model strategy config)
- Provider & connection management with live model testing
- **Account pool** — bulk token/credential management with grouped stats
- **Bulk-import automation** — kiro, grok-cli, qoder, baseten signup/import managers
- **Proxy pools** — per-provider rotation (round-robin / random / smart / fill-first)
- Usage tracking per model and account

### ⚡ Performance
- Settings + connections cached (5s / 2s TTL) — minimal sync DB reads per request
- Per-provider mutex instead of a global one — parallel provider selection

---

## 🚀 Quick Start

> **VansRouter is a fork of [Vanszs/VansRouter](https://github.com/Vanszs/VansRouter)** with extra automation, resilience, and capacity features. Requires **Node ≥ 22.5**.

```bash
git clone https://github.com/Shinzzyak/VansRouter.git
cd VansRouter
npm install

# development
npm run dev

# production
npm run build
npm start
```

### Point your AI tool at it

Any OpenAI-compatible client (Claude Code, Codex, Cursor, Cline, OpenCode…):

```bash
export ANTHROPIC_BASE_URL=http://localhost:20128/v1    # Anthropic-format clients
export OPENAI_BASE_URL=http://localhost:20128/v1       # OpenAI-format clients
export ANTHROPIC_AUTH_TOKEN=<your-vansrouter-api-key>
```

Then add providers in the dashboard (or via the provider API), create a **combo**, and route traffic:

```bash
curl http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer <your-vansrouter-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "combo/smart-fallback",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

---

## 🏗️ Architecture

```
┌──────────────────┐   ┌────────────────────────────────────────────────────┐
│  Your AI tools   │   │                  VansRouter                        │
│  Claude Code     │   │                                                    │
│  Codex / Cursor  │──▶│  /v1 OpenAI & Anthropic-compatible endpoint        │
│  Cline / Copilot │   │  └─ Auth (per-key ACL)                             │
│  OpenCode / ...  │   │  └─ Combo strategies (fallback / RR / fusion)      │
│                  │   │  └─ Capacity adapters (vision / pdf / audio)       │
└──────────────────┘   │  └─ RTK token saver (tool_result compression)      │
                       │  └─ Circuit breaker + account semaphore            │
                       │  └─ Executors + format translation                 │
                       │  └─ 40+ providers, 100+ models, free tiers         │
                       └────────────────────────────────────────────────────┘
```

State lives in **SQLite** (`sql.js` WASM) — provider nodes, connections, combos, API keys, proxy pools, settings. The dashboard is a Next.js app served from the same process.

---

## 🛠️ Tech Stack

| Layer | Tech |
|---|---|
| Framework | **Next.js** (App Router) · React 19 |
| State / UI | Zustand · Recharts · @xyflow/react · Monaco Editor · dnd-kit |
| Storage | **SQLite** via sql.js (WASM, no native deps) |
| HTTP | undici · jose (JWT auth) · bcryptjs |
| Automation | playwright-core (bulk-import browser engine) |
| CI/CD | GitHub Actions (`build-deploy-pm2.yml`) |

---

## 🧑‍💻 Development

```bash
npm run lint          # eslint + custom undef/react-hooks checks
npm test              # unit tests (2800+)
npm run build         # standalone production build
```

Contributions welcome — PRs, issues, and ideas. All upstream updates from `Vanszs/VansRouter` are tracked and merged.

---

## 📄 License

[MIT](LICENSE) © 2024–2026 Avres (Shinzzyak) & contributors. Upstream: [Vanszs/VansRouter](https://github.com/Vanszs/VansRouter) © decolua and contributors.

> **Disclaimer:** free-tier providers come and go, and their availability/rate limits are outside this project's control. VansRouter makes no guarantee of uptime for free upstreams.

# Handover: OpenCode free tier bypass — PR #5997 + #10222 (OmniRoute)

**Untuk agen yang pegang VansRouter.** Temuan dari riset OmniRoute PR #10222:

## Masalah
opencode.ai free tier (`/zen/v1`) nolak request dari **datacenter IP** dengan `FreeUsageLimitError 429` kalau User-Agent bukan CLI. Vercel relay (datacenter) bisa bypass DULU karena inject identity CLI lengkap; sekarang gak bisa karena UA generik (curl/SDK) diteruskan → 429.

## Fix (2 PR berurutan)
1. **PR #5997**: sintesis header identity CLI lengkap — `User-Agent: opencode-cli/1.0.0`, `x-opencode-client: opencode-cli`, `x-opencode-project: opencode`, `x-opencode-request: <uuid>`, `x-opencode-session: <uuid>` — hanya untuk key yang client belum kirim (client-wins).
2. **PR #10222**: UA adalah pengecualian — non-CLI UA (curl/SDK) **di-REPLACE** dengan `opencode-cli/1.0.0`, karena #5997 gagal untuk non-CLI client (client-wins malah nerusin curl UA → 429). CLI UA asli tetap dipertahankan.

## Status di VansRouter saat ini (per cek 2026-08-13)
- `open-sse/executors/opencode.js` — SUDAH ada: `x-opencode-client: desktop`, `Authorization: Bearer public`, parseError poolScoped ip-limit (429/403 body limit/rate/quota).
- BELUM ada: `x-opencode-project`, `x-opencode-request`, `x-opencode-session` (UUID), UA replace, env `OPENCODE_SYNTHESIZE_CLI_HEADERS`.

## Yang perlu di-apply (mirror dari PR #10222)
- `open-sse/utils/opencodeHeaders.ts` (buat baru) — `forwardOpencodeClientHeaders(headers, clientHeaders, { cliDefaults })`: fill x-opencode-* + UUID; UA replace kalau non-CLI.
- `open-sse/executors/opencode.ts` — panggil helper itu di `buildHeaders`; env `OPENCODE_SYNTHESIZE_CLI_HEADERS` (default off).
- Test unit: non-CLI UA → replaced; CLI UA → preserved; x-opencode-* client-wins.

## Catatan
- Gateway 8081 (proxy-scraper) sudah punya `_UA_TARGET_MAP` — opencode.ai → UA `opencode-cli/1.0.0` di HTTP layer. Tapi header x-opencode-* harus dari VansRouter (gateway gak tau konteks client).
- IP tetap datacenter → kalau opencode cek IP juga, tetap 429. Butuh proxy residential/ISP (research jalan di deleg_38a9d149).

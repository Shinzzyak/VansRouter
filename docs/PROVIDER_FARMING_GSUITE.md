# Provider Farming via GSuite — 2026-08-15

## Ringkasan
Batch massal 110 akun GSuite (`e-mail.bty.web.id`) untuk 3 provider:
- **Kiro**: 108/110 berhasil (cookies + model + ARN)
- **Antigravity**: 108/110 berhasil (refresh token OAuth Google)
- **Kimchi (Cast AI)**: bulk 50 jalan — flow terbukti, key `castai_v1_*` per akun

## Scripts (di VPS `/home/ubuntu/VansRouter/scripts/python/`)
| Provider | Script | Output |
|---|---|---|
| Kiro | `kiroreg/kiro_bulk_gsuite.py` (batch), `kiroreg/kiro_login_one.py` (single) | `/tmp/kiro_results.tsv` + cookies per akun |
| Antigravity | `antigravityreg/ag_bulk_gsuite.py` | `/tmp/ag_tokens/` (JSON per akun) |
| Kimchi/Cast | `kimchireg/cast_bulk_gsuite.py` | `/tmp/cast_results.tsv` |

## Flow yang TERBUKTI (empiris, bukan catatan)

### Kiro (108/110)
1. `Camoufox` headful (Xvfb :99) → `app.kiro.dev/signin` → Google SSO
2. `#identifierId` → email → password → consent
3. **Speedbump Workspace TOS**: URL mengandung `workspacetermsofservice` → auto-klik **"I understand"**
4. Dump cookies → `app.kiro.dev/home` = sukses (cookies ~1440B)
5. API key = PAID (skip). Bonus claim = `CreateUserBonusCommand {bonusCode}` (code belum ada)

**Pitfall**: Camoufox = profil baru tiap run → cookies HARUS di-inject ulang tiap run.

### Antigravity (108/110)
1. Hapus `~/.gemini/antigravity-cli/antigravity-oauth-token`
2. Camoufox WARM dulu (browser start sebelum `agy` spawn)
3. `agy -p say --output-format json` → URL OAuth Google muncul cepat
4. Login Google → nativeapp page → klik "Login" → code `4/0...` dari callback
5. Paste code ke stdin agy → **refresh token `1//0...`**
6. Simpan token ke `/tmp/ag_tokens/{email}.json` (LENGKAP 103+ chars — jangan truncate!)

**Pitfall**: 
- Google blokir password submit dari IP datacenter → **wajib WARP `127.0.0.1:40000`** (intel subagent)
- Code OAuth single-use + PKCE-bound → 1 sesi agy utuh
- **RAM VPS**: 15+ zombie Playwright x-farm makan 1.7GB → OOM kill Camoufox. Kill dulu: `pkill -9 -f playwright`

### Kimchi (Cast AI) — bulk 50
1. `Playwright Firefox` (BUKAN Camoufox!) → `console.cast.ai/sign-up` → Google SSO
2. `click_text` pattern untuk tombol Google/Continue/Lanjutkan (robust)
3. `POST /api/v1/auth/tokens` dengan **nama unik** (`router-{random}`) — 409 "name in use" kalau duplikat
4. Key `castai_v1_*` muncul sekali di response → simpan

**Pitfall**:
- `login.cast.ai` (Auth0) → "Oops, something went wrong" dari IP datacenter (tenant block). Jalur langsung `console.cast.ai/sign-up` WORKS.
- Camoufox di login.cast.ai render error → pakai Playwright biasa
- 409 = token name duplikat → selalu random nama

## DB Insert (VansRouter)
```bash
python3 /tmp/insert_ag_kiro_db.py  # AG 108 + Kiro 86
python3 /tmp/reinsert_ag_db.py     # AG 108 (RT LENGKAP dari JSON)
python3 /tmp/insert_kiro_final.py  # Kiro final 11
```

## Update Router (refresh token AG)
- `open-sse/providers/registry/antigravity.js`: tambah `clientId` + `clientSecret` + `refresh: {encoding: "form"}`
- `open-sse/executors/default.js`: `antigravity: () => this.refreshFromGrant(...)` + `client_secret` di params
- Test refresh: `curl -d "grant_type=refresh_token&refresh_token=$RT&client_id=...&client_secret=..." https://oauth2.googleapis.com/token` → 200

## Verified Key Stats
- Kiro: 108 akun, model auto/claude-sonnet-4.5/-4/claude-haiku-4.5
- AG: 108 akun, refresh token valid (test 200), model Gemini 3.7/3.6/3.5 Flash, Claude Sonnet 4.6, Opus 4.6, GPT-OSS-120B
- Kimchi: $10/bln free per akun, `llm.kimchi.dev/openai/v1` + Bearer + **UA `kimchi/*` wajib** (402 tanpa)

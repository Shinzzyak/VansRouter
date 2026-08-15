# Provider GSuite Farming — Analisis Lengkap (2026-08-15)

## KESIMPULAN: Provider VALID + FREE + GSuite

### ✅ SUDAH DI-FARM (masuk DB router)
| Provider | Akun | Free tier | Auth | Status |
|---|---|---|---|---|
| **antigravity** | 108 | Gemini 3.6/3.7 Flash + Claude Sonnet 4.6 + Opus 4.6, quota mingguan | Google SSO | ✅ LIVE |
| **kiro** | 97 | 50 credits/minggu (reset Minggu), 9 model | Google SSO | ✅ LIVE |
| **kimchi** (Cast AI) | 50 | $10/bln free, reset bulanan | Google SSO | ✅ LIVE |
| grok-cli | 663 | free tier x.ai | SSO reuse | ✅ (bukan GSuite) |

### ❌ TIDAK VALID / DEAD
| Provider | Alasan |
|---|---|
| **gemini-cli** | Google DEPRECATE → "UNSUPPORTED_CLIENT, migrate to Antigravity" (verified via loadCodeAssist API) |
| gemini (AI Studio) | Kandidat tapi flow Angular kompleks + Google rate-limit IP; butuh cooldown |
| autoclaw (Z.ai) | Google login kena Shumei captcha (cv2 solver belum lolos) |
| codebuddy | "Account Access Restricted" datacenter IP |
| tokenharbor | verify email block domain kita |
| vyce | user skip |

### ⚠️ KANDIDAT (butuh kerja lagi)
- **AI Studio (gemini)**: API key free per Google account — flow: login → aistudio.google.com/app/apikey → Create API key. HTML confirmed ("Create API key" + "AIza" di DOM). Blocker: Google challenge IP + Angular app.
- **autoclaw**: --google-login mode exists — butuh fix Shumei captcha solver.

## MODEL LIST PER PROVIDER (verified via API)

### Antigravity (25 model via fetchAvailableModels)
```
gemini-3.7-flash-tiered (BARU!), gemini-3.6-flash-{high,medium,low},
gemini-3.5-flash-{low,extra-low}, gemini-3-flash-agent, gemini-3-flash,
gemini-3.1-pro-{high,low}, gemini-pro-agent, gemini-2.5-flash-thinking,
gemini-2.5-flash, gemini-2.5-flash-lite, gemini-2.5-pro,
claude-sonnet-4-6, claude-opus-4-6-thinking, gpt-oss-120b-medium,
gemini-3.1-flash-image, gemini-3.1-flash-lite, tab_*, chat_*
```

### Kiro FREE (9 model via ListAvailableModels)
```
Auto, Claude Sonnet 4.5, Claude Sonnet 4, Claude Haiku 4.5,
Deepseek v3.2, MiniMax M2.5, MiniMax M2.1, GLM 5, Qwen3 Coder Next
```

### Kimchi (Cast AI) — 10 model (via llm.kimchi.dev/v1/models/metadata)
```
kimi-k2.7, glm-5.2-fp8, minimax-m3, nemotron-3-ultra-fp4,
deepseek-v4-flash, + 5 lain (community tier)
```

### Gemini-cli — DEAD (Google deprecate, jangan pakai)

## ENDPOINTS PENTING (verified)

### Kiro
- Refresh: `POST https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken` `{refreshToken}` → `{accessToken, profileArn, expiresIn}`
- Models: `GET https://q.us-east-1.amazonaws.com/ListAvailableModels?origin=AI_EDITOR&profileArn=...` Bearer
- Usage: `GET https://codewhisperer.us-east-1.amazonaws.com/getUsageLimits?isEmailRequired=true&origin=AI_EDITOR&resourceType=AGENTIC_REQUEST`
- Kiro FREE = 50 credits/minggu, NO trial terpisah. Sign-up bonus $20 HANYA saat upgrade paid.

### Antigravity
- Refresh: `POST https://oauth2.googleapis.com/token` (client_id 1071006060591-...)
- loadCodeAssist: `POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist` `{metadata:{ideType:9,platform:3,pluginType:2},mode:1}` → `cloudaicompanionProject` per akun (WAJIB disimpan!)
- Models: `POST https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels` body `{}` → `models` map
- Chat: `POST https://cloudcode-pa.googleapis.com/v1internal:generateContent` envelope: `{project, model, userAgent, requestType, requestId, request:{contents,generationConfig,sessionId}}`

### Kimchi (Cast AI)
- Create key: `POST https://console.cast.ai/api/v1/auth/tokens` (session cookie, name unik!)
- Chat: `POST https://llm.kimchi.dev/openai/v1/chat/completions` — **WAJIB UA kimchi/0.1.90**
- Credits: `GET https://llm.kimchi.dev/v1/credits`

## SCRIPT LOKASI (VPS /home/ubuntu/VansRouter/scripts/python/)
- `kiroreg/kiro_bulk_gsuite.py` — batch Kiro (proven 108)
- `antigravityreg/ag_bulk_gsuite.py` — batch AG (proven 108)
- `kimchireg/cast_bulk_gsuite.py` — batch Cast (proven 50+)
- `kiroreg/kiro_list_models.py` — list model Kiro

## NEXT STEPS
1. Cast 50-110: cooldown ~60m → retry IP langsung (pola 8→41 proven)
2. AI Studio: cooldown IP → buat batch API key (flow ~confirmed, butuh fix)
3. Autoclaw: fix Shumei captcha solver
4. Insert hasil baru ke DB + update UI

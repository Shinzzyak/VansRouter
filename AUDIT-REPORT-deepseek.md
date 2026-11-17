# Laporan Audit Teknis — Jalur Routing Request VansRouter

**Repo:** `/home/ubuntu/VansRouter` (branch `main`, HEAD `7f67071c`)
**Scope:** jalur routing request end-to-end — executor, SSE streaming, backoff/cooldown, katalog model, billing/usage
**Metode:** statis (baca kode, grep call-site, inspeksi DB read-only). Tanpa modifikasi source, tanpa restart service.
**Tanggal audit:** 2026-11-17

---

## Ringkasan Eksekutif

Audit menemukan **7 temuan** pada jalur routing request. Distribusi prioritas:

| Prioritas | Jumlah |
|-----------|--------|
| P0 (crash/data-loss produksi) | 1 |
| P1 (degradasi nyata jalur utama) | 3 |
| P2 (edge case / dead code berbahaya) | 3 |

Top 3 prioritas: (1) format `disabledModels` tidak konsisten menyebabkan model yang "dinonaktifkan" tetap bisa diroute, (2) `checkFallbackError` di `combo.js` dipanggil tanpa `backoffLevel` sehingga eskalasi backoff selalu reset, (3) overcount token input karena `JSON.stringify` seluruh body termasuk tool schema. Area SSE streaming (`streamHandler.js`) dan circuit breaker dinyatakan bersih setelah pemeriksaan.

---

## P0 — Crash / Data-Loss Produksi

### [P0-1] Format `disabledModels` tidak konsisten — model nonaktif tetap bisa diroute

- **File:** `src/lib/db/repos/disabledModelsRepo.js:6-12` + `src/sse/services/allowedModels.js:492`
- **Kode bermasalah:**

```js
// disabledModelsRepo.js — mengembalikan apa adanya per alias
export async function getDisabledModels() {
  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ?`, [SCOPE]);
  const out = {};
  for (const r of rows) out[r.key] = parseJson(r.value, []);
  return out;
}

// allowedModels.js:492 — matcher hanya mencocokkan RAW id
const isDisabled = (alias, modelId) =>
  Array.isArray(disabledByAlias[alias]) && disabledByAlias[alias].includes(modelId);
```

- **Akar masalah:** tabel `kv` scope `disabledModels` diisi dari dua sumber dengan **dua format berbeda**. Verifikasi DB read-only (`mode=ro`) menunjukkan:
  - alias `kln`, `zc`, `bzr` → menyimpan **RAW id** (mis. `["hy3","deepseek-v4.1-flash",...]`)
  - alias `xki` → menyimpan **id berprefix `provider/model`** (mis. `["anthropic/claude-opus-4.6","deepseek/deepseek-v3.2",...]`, 100+ entri)

  Fungsi `isDisabled(alias, modelId)` membandingkan langsung `modelId` (yang selalu RAW) terhadap array. Untuk alias yang datanya berprefix, `includes(modelId)` **tidak pernah cocok** → `isDisabled` selalu `false`. Tidak ada normalisasi strip-prefix di sisi repo maupun sisi matcher.
- **Dampak produksi:** 100+ model di bawah alias `xki` (keluarga Claude, DeepSeek, Gemini, GPT, Qwen, GLM) yang sudah dinonaktifkan lewat dashboard/API **tetap muncul di `/v1/models` dan tetap bisa dipilih untuk routing**. Tidak ada crash — ini lebih berbahaya karena diam-diam: permintaan ke model yang seharusnya diblokir tetap diteruskan ke upstream, menghabiskan kuota/kuota billing dan mengembalikan jawaban yang seharusnya ditolak. Kena langsung: semua klien yang mengharapkan model `xki` diblokir. Gagal setiap request ke model nonaktif `xki`, severity tinggi dan persisten (data salah tersimpan permanen di `kv`).
- **Rekomendasi fix:** normalisasi di satu titik — di `getDisabledModels()` strip prefix `provider/` sebelum simpan/match, atau ubah `isDisabled` menjadi:
  ```js
  const isDisabled = (alias, modelId) => {
    const list = disabledByAlias[alias];
    if (!Array.isArray(list)) return false;
    return list.includes(modelId) || list.includes(`${alias}/${modelId}`);
  };
  ```
  Lalu jalankan migrasi one-shot read-only-safe untuk menormalkan baris `xki` ke format RAW. Tambahkan validasi format di API `PUT/POST /api/models/disabled` (tolak id yang mengandung `/` atau strip otomatis) agar tidak terulang.

---

## P1 — Degradasi Nyata di Jalur Utama

### [P1-1] `checkFallbackError` di combo dipanggil tanpa `backoffLevel` — eskalasi backoff selalu reset

- **File:** `open-sse/services/combo.js:764`
- **Kode bermasalah:**

```js
// accountFallback.js:40 — signature punya backoffLevel
export function checkFallbackError(status, errorText, backoffLevel = 0, provider = null) { ... }

// combo.js:764 — backoffLevel tidak diteruskan
const { shouldFallback, cooldownMs, requestScoped } =
  checkFallbackError(result.status, errorText);
```

- **Akar masalah:** `checkFallbackError` menerima `backoffLevel` untuk menghitung cooldown eskalatif antar percobaan. Pemanggil di `combo.js:764` menghilangkan argumen ke-3, sehingga setiap error dihitung dari `backoffLevel = 0`. Kontras dengan pemanggil di `src/sse/services/auth.js:441` yang meneruskan `backoffLevel` dengan benar (`checkFallbackError(status, errorText, backoffLevel)`).
- **Dampak produksi:** pada jalur combo, cooldown yang seharusnya naik bertahap (mis. 2s → 4s → 8s) selalu dihitung dari level 0 (cooldown minimum). Ketika satu member combo gagal berulang (429/503), combo langsung jatuh ke member berikutnya tanpa jeda memadai → memicu **429 cascade** ke provider yang sama, mempercepat habisnya kuota seluruh member combo, dan menaikkan latensi p95 karena provider overloaded tidak sempat pulih. Kena: semua request yang berjalan lewat combo saat ada member yang sedang bermasalah.
- **Rekomendasi fix:** lacak `backoffLevel` dalam loop combo (increment per failure per member), teruskan ke pemanggilan:
  ```js
  const { shouldFallback, cooldownMs, requestScoped, newBackoffLevel } =
    checkFallbackError(result.status, errorText, memberBackoffLevel.get(modelStr) || 0, provider);
  memberBackoffLevel.set(modelStr, newBackoffLevel);
  ```

### [P1-2] `applyErrorState` adalah dead export — state error akun tidak pernah diaplikasikan di jalur koneksi

- **File:** `open-sse/services/accountFallback.js:502`
- **Kode bermasalah:**

```js
export function applyErrorState(account, status, errorText) {
  const { cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel);
  // ... mengeset cooldown/backoff pada objek account
}
```

- **Akar masalah:** grep seluruh `open-sse/` dan `src/` menunjukkan `applyErrorState` **hanya didefinisikan, tidak pernah diimpor/dipanggil** oleh modul mana pun (0 call-site). State error per-akun (cooldown, backoff, consecutive-fails) pada jalur koneksi aktual justru dikelola lewat `markAccountUnavailable` (persist ke DB). Akibatnya in-memory error-state akun yang dimaksudkan fungsi ini tidak pernah aktif.
- **Dampak produksi:** backoff in-memory antar-request pada satu proses tidak terbentuk; perlindungan terhadap akun yang baru saja gagal hanya mengandalkan `markAccountUnavailable` (DB). Pada request berikutnya dalam window sangat pendek sebelum DB state ditulis terbaca, akun bermasalah bisa terpilih lagi → request gagal tambahan + latensi. Ini dead code yang **menipu pembaca** seolah ada lapisan proteksi padahal tidak. Kena: request yang beruntun menabrak akun yang sama saat sedang gagal.
- **Rekomendasi fix:** pilih salah satu — (a) hapus `applyErrorState` bila memang tidak terpakai, atau (b) wire-kan ke jalur pemilihan koneksi (`getProviderCredentials`/auth) agar state in-memory benar-benar dipakai sebagai fast-path guard sebelum query DB. Jangan biarkan dead export yang namanya mengesankan proteksi.

### [P1-3] Duplikasi objek literal `resolveProxyConfig` di payload chatCore — yang kedua menimpa yang pertama

- **File:** `src/sse/handlers/chat.js:836` dan `chat.js:852`
- **Kode bermasalah:**

```js
const payload = {
  ...
  resolveProxyConfig: async (creds, excludePoolIds = []) => { ...A... },  // baris 836
  clientSignal,
  resolveProxyConfig: async (creds, excludePoolIds = []) => { ...B... },  // baris 852 (duplikat key)
  ...
};
```

- **Akar masalah:** dalam satu objek literal ada dua properti dengan nama sama `resolveProxyConfig`. JavaScript memakai yang terakhir (baris 852); yang pertama (baris 836) mati. Keduanya isinya identik saat ini, tetapi keduanya memanggil `resolveConnectionProxyConfig` secara **tidak sinkron di dalam request path** tanpa cache — setiap pemanggilan me-resolve ulang proxy (potensi latensi tambahan dan query berulang).
- **Dampak produksi:** tidak crash. Risiko nyata: (a) saat salah satu cabang diedit dan yang lain tidak, perubahan diam-diam diabaikan (silent divergence), (b) duplikasi resolve proxy per-request menambah overhead pada jalur utama. Kena: seluruh request yang melewati jalur proxy-pool.
- **Rekomendasi fix:** hapus salah satu definisi (pertahankan satu), dan bungkus hasil `resolveConnectionProxyConfig` dengan cache per-`connectionId`+`model` agar tidak resolve berulang dalam satu request.

---

## P2 — Edge Case / Dead Code Berbahaya

### [P2-1] Overcount token input — `JSON.stringify` seluruh body termasuk tool schema

- **File:** `open-sse/utils/usageTracking.js:423-434`
- **Kode bermasalah:**

```js
export function estimateInputTokens(body, model) {
  if (!body || typeof body !== "object") return 0;
  try {
    const bodyStr = JSON.stringify(body);   // termasuk tools, system, thinking config
    return estimateChars(bodyStr, model);
  } catch (err) {
    return 0;
  }
}
```

- **Akar masalah:** komentar di file mengakui seluruh body dihitung ("tool schemas are part of the prompt"). Untuk request dengan tool schema besar (banyak tool / schema kompleks), estimasi input token **lebih besar dari yang benar-benar dikirim ke model sebagai prompt efektif** pada sebagian provider yang tidak menghitung schema sebagai prompt token. Estimasi ini dipakai untuk billing saat provider tidak mengembalikan `usage`.
- **Dampak produksi:** overcount `promptTokens` → `usageHistory.prompt_tokens` dan biaya `cost` lebih tinggi dari aktual untuk request ber-tool berat. Bukan crash, tetapi **data billing bias** yang sulit dideteksi. Miss/over count, bukan double count. Kena: semua request tool-calling yang provider-nya tidak mengembalikan usage resmi.
- **Rekomendasi fix:** pisahkan estimasi prompt dari tool schema, atau beri bobot berbeda; minimal tambahkan flag `estimated_tool_schema_included` di meta agar bisa dikoreksi saat provider mengirim usage resmi.

### [P2-2] `getCompatibleModels` menelan semua error dan mengembalikan cache kosong

- **File:** `src/sse/services/allowedModels.js:445-471`
- **Kode bermasalah:**

```js
try {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  const response = await guardedFetch(url, { ... signal: controller.signal });
  clearTimeout(timeoutId);
  if (!response.ok) return [];
  const data = await response.json();
  ...
  _compatibleModelsCache.set(cacheKey, { ids: result, expiresAt: now + TTL });
  return result;
} catch {
  return _compatibleModelsCache.get(cacheKey)?.ids || [];   // swallow semua error
}
```

- **Akar masalah:** blok `catch {}` kosong menelan timeout, error jaringan, dan error parse JSON tanpa logging. Ketika fetch gagal dan cache belum terisi, mengembalikan `[]` — seolah provider tidak punya model. Tidak ada pembeda antara "provider sah tapi kosong" vs "gagal fetch".
- **Dampak produksi:** pada startup dingin atau gangguan jaringan sesaat, daftar model provider tertentu bisa kosong dan request ke model valid ditolak `404 not available` (via `chat.js:584`) — **false negative** yang hilang sendiri setelah cache terisi. Sulit didiagnosis karena tidak ada log. Kena: request pertama ke provider baru setelah restart / saat upstream lambat.
- **Rekomendasi fix:** tambahkan `log.warn` di `catch` dengan `cacheKey` dan `error.message`; pertimbangkan negative-cache berdurasi pendek (mis. 30s) agar gagal fetch tidak dianggap "kosong" permanen.

### [P2-3] `capRetryAttemptsByAccountCount` menaikkan attempt saat jumlah akun kecil — kontradiktif dengan tujuan

- **File:** `open-sse/config/runtimeConfig.js:121-135`
- **Kode bermasalah:**

```js
export function capRetryAttemptsByAccountCount(retryConfig, accountCount) {
  if (!accountCount || accountCount < 3) return retryConfig;  // <3 akun: tanpa cap
  const maxAttempts = accountCount >= 5 ? 1 : 2;
  const capped = {};
  for (const [status, entry] of Object.entries(retryConfig)) {
    if (typeof entry === "number") capped[status] = Math.min(entry, maxAttempts);
    else capped[status] = { ...entry, attempts: Math.min(entry.attempts ?? 0, maxAttempts) };
  }
  return capped;
}
```

- **Akar masalah:** `Math.min(entry, maxAttempts)` dengan `maxAttempts` = 1 atau 2 hanya **menurunkan** attempt. Untuk fleet kecil (<3 akun) fungsi mengembalikan config apa adanya (attempt tetap tinggi) — padahal fleet kecil justru paling rentan terhadap retry berulang ke akun sama. Logika "cap" hanya aktif di fleet besar, tidak di fleet kecil yang paling butuh. Ini bukan bug crash, tetapi perilaku tidak sesuai intent yang tertera di komentar.
- **Dampak produksi:** fleet kecil (1-2 akun) tetap me-retry berkali ke akun sama saat akun bermasalah → latensi tail tinggi + kemungkinan 429 cascade pada provider yang sama. Kena: provider dengan sedikit akun (umum di custom node / provider baru).
- **Rekomendasi fix:** tinjau ulang intent — bila tujuannya membatasi retry ke akun bermasalah, fleet kecil seharusnya juga di-cap (mis. min(attempts, 2)) bukan dilepas tanpa batas. Tambahkan cap bawah untuk fleet <3.

---

## Area yang Dinyatakan Bersih

### SSE streaming (`open-sse/utils/streamHandler.js`) — **bersih**
Sudah diperiksa: penanganan chunk parsial dilakukan dengan buffer yang di-flush hanya pada delimiter baris utuh (tidak memecah frame SSE); ada stall-timeout antar chunk (`STREAM_STALL_TIMEOUT_MS`) dan time-to-first-token timeout (`STREAM_FIRST_CHUNK_TIMEOUT_MS`) yang dibaca dari env dengan override aman; `AbortController` dipakai untuk abort upstream saat client disconnect. Tidak ditemukan resource leak reader/stream pada alur normal. Satu-satunya catatan: penutupan stream saat error bergantung pada `finally` di pemanggil (chat.js:881-884) yang memang me-release semaphore — path ini benar.

### Circuit breaker (`open-sse/utils/circuitBreaker.js`) — **bersih**
Sudah diperiksa: transisi state CLOSED→DEGRADED→OPEN→HALF_OPEN lengkap dengan guard; `PROVIDER_FAILURE_ERROR_CODES` sengaja **mengecualikan 429** (benar — 429 adalah per-account, bukan provider-wide); eskalasi backoff OPEN (`2^(openProbeCycles/backoffEscalationCount)`, capped `maxBackoffMultiplier`) dihitung konsisten di `canExecute()` dan `getRetryAfterMs()`; failure-window dengan prune timestamp benar; tidak ada dead-lock state. Registry in-memory dengan opsi update-on-get aman.

### Semaphore akun (`open-sse/services/accountSemaphore.js`) — **bersih (dengan catatan kecil)**
Sudah diperiksa: `acquire()` menangani blocked-gate, queue penuh (reject cepat), timeout per-entry, dan abort signal; `release` idempotent (`released` flag); `drainQueue` menangani blockedUntil dengan block-timer agar tidak stuck. Catatan minor (bukan bug): `resolveAccountSemaphoreMaxConcurrency` default 3 dan bypass `maxConcurrency:0` — perilaku ini disengaja dan terdokumentasi.

### `loopGuard.js` — **bersih**
Deteksi loop stateless pada history, threshold wajar, ada guard panjang minimum teks untuk hindari false positive. Tidak ada efek samping pada jalur routing.

### `modelFallback.js` — **bersih**
Kapasitas `MAX_FALLBACK_MODELS=3`, dedup, tidak pernah mengembalikan model yang sama; no-op bila setting tidak dikonfigurasi (feature off). Logika chain per-model benar.

---

## Kualitas Umum Jalur Routing

Kualitas kode jalur routing VansRouter **di atas rata-rata proyek sejenis** — komentar menjelaskan *mengapa* (bukan *apa*) dengan bukti terukur, ada pemisahan tanggung jawab yang jelas antara executor/backoff/catalog, dan banyak "measured on <tanggal>" yang menunjukkan keputusan berbasis data. Kelemahan utamanya bukan pada mekanisme inti (SSE, circuit breaker, semaphore sudah solid) melainkan pada **konsistensi lintas-lapisan data dan state**: format `disabledModels` yang bergantung pada disiplin penulis (memunculkan bug P0-1), dead export `applyErrorState` yang mengesankan proteksi fiktif, dan duplikasi key `resolveProxyConfig` — semuanya kegagalan koordinasi antar-modul, bukan kegagalan algoritma. Prioritaskan normalisasi format `disabledModels` (P0-1) dan penerusan `backoffLevel` di combo (P1-1) karena keduanya memengaruhi keputusan routing nyata pada jalur utama.

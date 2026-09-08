# Bangk-Shield

**Status: v1 — menggantikan versi sebelumnya sepenuhnya.** Bukan iterasi tambahan, tapi rewrite arsitektur: rule engine dipindah ke build pipeline terkompilasi, ditambah circuit breaker, watermark kriptografis, dan logging dengan sampling.

Edge-based application layer honeypot untuk Cloudflare Workers. Mengintersep request mencurigakan (SQLi, RCE, SSRF, LFI, XSS, recon) di edge, membalas dengan roast lokal + fake payload yang meyakinkan, dan mencatat aktivitas serangan secara persisten.

---

## 1. Apa Ini Proyek Apa?

Bangk-Shield berjalan sepenuhnya di Cloudflare Workers, membalas request mencurigakan dengan respons palsu yang meyakinkan, dengan tiga tujuan: **deception** ke bot/scanner otomatis, **deterrence** ke attacker manual, dan **visibility** ke pemilik situs lewat log yang persisten (bukan `console.log` yang hilang begitu saja).

---

## 2. Struktur Proyek

```text
Bangk-Shield/
├── README.md
├── wrangler.toml
├── package.json
├── config/
│   ├── whitelist.json      # path/prefix/IP yang dilewatkan tanpa dicek
│   ├── rules.json           # SUMBER KEBENARAN rule deteksi (edit di sini)
│   └── rules.schema.json    # JSON Schema untuk validasi rules.json
├── scripts/
│   ├── build-rules.cjs      # validasi + lint ReDoS + compile-test + tulis artefak
│   └── rotate-salt.cjs      # rotasi salt watermark lewat Wrangler KV CLI
└── src/
    ├── index.js             # entry point, orkestrasi
    ├── rules.compiled.json  # ARTEFAK build, JANGAN diedit manual (lihat §4)
    ├── scanner.js           # compile regex + evaluasi skor
    ├── ratelimit.js         # circuit breaker berbasis KV
    ├── watermark.js         # hash watermark + resolusi salt dari KV
    ├── logger.js            # logging best-effort ke Analytics Engine
    └── utils.js             # whitelist check, baca body, sanitasi, passthrough
```

---

## 3. Cara Kerja Engine

Alur tiap request masuk (`src/index.js`):

1. **Known-asset check** (`isKnownAsset` di `utils.js`) — ekstensi statis, path/prefix di `whitelist.json`, atau IP terdaftar → langsung `passthrough()`.
2. **Circuit breaker** (`ratelimit.js`) — kalau IP klien sudah memicu honeypot ≥5 kali dalam 60 detik terakhir (tercatat di KV), langsung dibalas `403` statis murah, tanpa komputasi payload/watermark/delay.
3. **Context extraction** — `path`, `query`, `headers` (User-Agent), dan `body` (kalau `Content-Type` berbasis teks) dikumpulkan, masing-masing di-**decode** (`safeDecode`) dan di-lowercase.
4. **Scoring** (`scanner.js`) — tiap vector di `rules.compiled.json` dicek sinyalnya terhadap field context yang relevan (`where`), skor dijumlahkan, ditambah *combo bonus* kalau kombinasi sinyal tertentu muncul bersamaan.
5. **Trigger honeypot** kalau skor ≥ `global.score_threshold` (default `50`):
   - Delay acak (deception, `fake_payload.delay_ms` per vector).
   - Watermark SHA-256 dihasilkan dari `IP + User-Agent + tanggal + salt`.
   - Strike dicatat ke KV (untuk circuit breaker), event dicatat ke Analytics Engine (best-effort, non-blocking).
   - Response berisi roast acak + fake payload JSON + header `X-Bangk-Shield` dan `X-Bangk-Shield-Watermark`.
6. **Bukan serangan** → `passthrough()` ke origin.
7. **Fail-open** — error apapun di titik manapun → log `engine_error`, lalu tetap coba `passthrough()` (bukan blokir).

---

## 4. Build Pipeline — WAJIB Dijalankan Sebelum Dev/Deploy

`src/index.js` **tidak membaca** `config/rules.json` langsung. Ia membaca `src/rules.compiled.json`, sebuah artefak yang dihasilkan `scripts/build-rules.cjs`:

```bash
npm run build:rules
```

Tahapan build (fail-closed — kalau satu langkah gagal, artefak TIDAK ditulis, proses exit non-zero):
1. Parse `config/rules.json`.
2. Validasi terhadap `config/rules.schema.json` (Ajv).
3. Lint tiap regex pattern untuk pola rawan ReDoS (nested quantifier, dll).
4. Compile-test tiap regex (`new RegExp(...)`) — menangkap typo syntax sebelum sampai ke edge.
5. Tulis `src/rules.compiled.json`.

Script ini otomatis terpanggil lewat `predev` dan `predeploy` di `package.json` — jadi `npm run dev` dan `npm run deploy` selalu memakai rules terbaru. **Jangan edit `src/rules.compiled.json` manual** — perubahan akan tertimpa build berikutnya. Edit selalu di `config/rules.json`.

---

## 5. Konfigurasi Rules (`config/rules.json`)

Threshold global: **50**. Tiap vector punya beberapa `signals` (regex + `where` yaitu field context yang diperiksa + `score`), opsional `combo_bonus` (skor tambahan kalau kombinasi sinyal tertentu muncul bersamaan), `roast` (array, dipilih acak), dan `fake_payload` (delay + body JSON palsu).

| Vector | Bisa trigger sendirian? | Sinyal kuat (contoh) |
|---|---|---|
| **sqli** | Ya (skor 55–60) | `union select`, `or 1=1`, `sleep(` |
| **rce** | Ya (skor 50–60) | `exec(`, `/bin/bash`, `wget http://` |
| **ssrf** | Ya (skor 55–60) | `169.254.169.254`, `metadata.google.internal` |
| **lfi** | Ya untuk signature unik (`etc/passwd`=50), tidak untuk pola ambigu (`../../`=35, butuh combo) | `etc/passwd`, `php://filter` |
| **xss** | Tidak sendirian (skor 25–35), perlu combo | `<script`, `document.cookie` |
| **recon** | Tidak sendirian (skor 20–25), perlu combo | `.env`, `wp-admin`, `phpmyadmin` |

**Penting soal `where`:** field ini menentukan bagian request mana yang diperiksa signal tersebut (`path`, `query`, `body`, `headers`). Signal path-traversal seperti `etc/passwd` HARUS menyertakan `"path"` di `where`-nya — kalau tidak, signal itu tidak akan pernah cocok untuk serangan yang muncul di pathname (lihat §8 soal bug ini).

---

## 6. Watermark & Rotasi Salt

Tiap response honeypot menyertakan `X-Bangk-Shield-Watermark`, hash SHA-256 dari `IP + User-Agent + tanggal + salt`. Ini bukti verifikasi: kalau ada yang screenshot response ini dan klaim itu kerentanan asli, pemilik situs bisa membuktikan itu watermark Bangk-Shield miliknya.

Salt disimpan di Workers KV (`wm:salt:current`), **bukan** env var statis — supaya bisa dirotasi tanpa redeploy:

```bash
npm run salt:rotate
```

Script ini memindahkan salt lama ke riwayat (`wm:salt:history`, maksimal 5 generasi) lalu generate salt baru. Tanpa `BANGK_KV` dikonfigurasi, sistem fallback ke `env.WATERMARK_SALT` (statis, hanya untuk dev lokal) — **jangan andalkan ini di produksi**.

---

## 7. Circuit Breaker & Logging

- **Circuit breaker** (`ratelimit.js`): IP yang memicu honeypot ≥5 kali dalam 60 detik dapat respons `403` statis (tanpa delay/watermark/payload computation), meredam beban CPU dari scanner agresif. Berbasis KV counter — bukan atomic, cukup untuk anti-abuse ringan, bukan rate limit presisi tinggi.
- **Logging** (`logger.js`): dikirim ke Workers Analytics Engine, fire-and-forget lewat `ctx.waitUntil()`. Event dengan skor <30 di-sampling 20% saja untuk menghemat kuota harian tier gratis. **Tanpa binding `BANGK_ANALYTICS`, tidak ada log yang tersimpan sama sekali** (lihat §9).

---

## 8. Changelog — Bug yang Ditemukan & Diperbaiki

Draft kode sebelum versi ini punya bug kritis: `context` yang dievaluasi cuma berisi `query`, `headers`, `body` — **tidak ada `path`**. Akibatnya, semua signal yang menyasar pathname (`/etc/passwd`, `/.env`, `/wp-admin`, dst.) tidak akan pernah terdeteksi, karena `context['path']` selalu `undefined`. Ini sudah diperbaiki di `index.js` (`context.path = safeDecode(path).toLowerCase()`) dan divalidasi lewat pengujian manual terhadap 5 skenario (path traversal, recon combo, SQLi ter-encode, trafik legit) — semua lulus setelah perbaikan.

Selain itu, salt watermark yang di draft sebelumnya hanya baca `env.WATERMARK_SALT` (env var statis) — padahal PRD menjanjikan rotasi lewat KV. Sudah diperbaiki: `watermark.js` sekarang baca KV dulu, env var jadi fallback dev saja (lihat §6).

---

## 9. Known Limitations (Belum Diimplementasikan)

- **Admin dashboard (PRD §3.7)** — endpoint HTML untuk meninjau data Analytics Engine, terintegrasi Cloudflare Access, **belum ada kodenya sama sekali** di v1 ini. `ADMIN_PATH` di `wrangler.toml` baru placeholder. Ini butuh setup Cloudflare Access terpisah di dashboard akun + query balik ke Analytics Engine (GraphQL API, autentikasi API token) yang belum diimplementasikan.
- **Tanpa `BANGK_ANALYTICS` binding, tidak ada log tersimpan** — tidak ada fallback ke `console.log` seperti versi sebelumnya (desain baru ini murni Analytics Engine, sesuai PRD §3.5). Kalau butuh logging sebelum setup Analytics Engine, tambahkan sementara `console.log` di `logger.js`.
- **Circuit breaker via KV bukan atomic** — di bawah burst concurrent yang sangat tinggi, race condition pada `recordStrike` bisa membuat hitungan strike sedikit meleset. Untuk rate limiting presisi, perlu Durable Objects (di luar scope v1).
- **NFR latensi (§5 PRD, ≤25ms untuk scoring)** belum diukur dengan micro-benchmark sungguhan — baru diverifikasi secara fungsional (lulus test case), bukan diverifikasi secara performa.

---

## 10. Cara Menjalankan

### 10.1 Prasyarat
- Node.js LTS terbaru, npm.
- Akun Cloudflare (tier gratis cukup untuk KV + Analytics Engine dasar).

### 10.2 Install & login
```bash
npm install
npx wrangler login
```

### 10.3 Setup KV (wajib untuk circuit breaker & watermark rotation)
```bash
npm run kv:create
# Salin "id" dari output perintah di atas ke wrangler.toml, bagian [[kv_namespaces]]
```

### 10.4 Jalankan lokal
```bash
npm run dev
```
`predev` otomatis menjalankan `build:rules` lebih dulu. Contoh uji coba (path traversal sekarang benar-benar terdeteksi, lihat §8):

```bash
# LFI di path -> harus kena honeypot (skor 50 = threshold)
curl -i "http://localhost:8787/etc/passwd"

# Recon sendirian -> harus LOLOS (skor 25 < threshold 50)
curl -i "http://localhost:8787/.env"

# Recon combo -> harus kena honeypot (skor 25+20+20 combo bonus)
curl -i "http://localhost:8787/.env/wp-admin"

# SQLi di query, URL-encoded -> harus kena honeypot (sudah di-decode otomatis)
curl -i "http://localhost:8787/search?id=1%27%20union%20select%201--"

# Trafik biasa -> harus lolos normal
curl -i "http://localhost:8787/"
```

### 10.5 Deploy
```bash
npm run deploy
```
`predeploy` otomatis menjalankan `build:rules` lebih dulu. Isi `ORIGIN_URL` di `wrangler.toml` sebelum deploy produksi, atau `passthrough()` hanya akan membalas placeholder (lihat catatan di `src/utils.js`).

---

## 11. Roadmap

- Implementasi admin dashboard (PRD §3.7) + integrasi Cloudflare Access.
- Micro-benchmark CPU time untuk memverifikasi NFR §5 PRD secara kuantitatif.
- Evaluasi migrasi circuit breaker dari KV ke Durable Objects kalau presisi rate limit jadi kebutuhan nyata.
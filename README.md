# Bangk-Shield

**Status: Beta — menggantikan versi sebelumnya sepenuhnya.** Bukan iterasi tambahan, tapi rewrite arsitektur: rule engine dipindah ke build pipeline terkompilasi, ditambah circuit breaker, watermark kriptografis, dan logging dengan sampling.

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

Tiap response honeypot menyertakan `X-Bangk-Shield-Watermark`, hash yang bisa diverifikasi ulang oleh pemilik situs. Format persis (sesuai PRD Beta §3.4.1, dipakai test vector CI):

```
Canonical : bangk-shield/v1|<ip>|<ua>|<yyyy-mm-dd>|<salt>
Output    : bs1-<16 karakter hex pertama dari SHA-256(canonical)>
```

Salt disimpan di Workers KV, bukan env var statis — supaya bisa dirotasi tanpa redeploy. Bentuk data di KV:

```
wm:salt:current -> { "salt": "...", "since": "<ISO date>" }
wm:salt:history -> [{ "salt": "...", "since": "...", "until": "..." }, ...]  (maks 5 entri)
```

Rotasi:

```bash
npm run salt:rotate
```

Script ini memindahkan entri current lama ke `wm:salt:history` (dengan `until` diisi timestamp rotasi) lalu generate salt baru. Tanpa `BANGK_KV` dikonfigurasi, sistem fallback ke `env.WATERMARK_SALT` (statis, hanya untuk dev lokal) — **jangan andalkan ini di produksi**, dan setiap kali fallback terjadi, event `salt_fallback` tercatat ke Analytics Engine supaya operator sadar salt sedang tidak dirotasi dari KV.

---

## 7. Circuit Breaker & Logging

- **Circuit breaker** (`ratelimit.js`): IP yang memicu honeypot ≥5 kali dalam 60 detik dapat respons `403` statis (tanpa delay/watermark/payload computation), meredam beban CPU dari scanner agresif. Berbasis KV counter — bukan atomic, cukup untuk anti-abuse ringan, bukan rate limit presisi tinggi.
- **Logging** (`logger.js`): dikirim ke Workers Analytics Engine, fire-and-forget lewat `ctx.waitUntil()`. Event dengan skor <30 di-sampling 20% saja untuk menghemat kuota harian tier gratis. **Tanpa binding `BANGK_ANALYTICS`, tidak ada log yang tersimpan sama sekali** (lihat §9).

---

## 8. Changelog — Bug yang Ditemukan & Diperbaiki

**Bug kritis #1 — deteksi path hilang total.** Draft awal `context` yang dievaluasi cuma berisi `query`, `headers`, `body` — **tidak ada `path`**. Akibatnya semua signal yang menyasar pathname (`/etc/passwd`, `/.env`, `/wp-admin`, dst.) tidak akan pernah terdeteksi. Sudah diperbaiki (`context.path = safeDecode(path).toLowerCase()`) dan divalidasi lewat 5 skenario uji manual — semua lulus.

**Bug kritis #2 — format watermark tidak sesuai spesifikasi PRD Beta §3.4.1.** Kode awal menghasilkan canonical string `bangk-shield|...` (tanpa `/v1`) dan output `bs-<hash>` (tanpa `1`), padahal PRD mensyaratkan `bangk-shield/v1|...` dan `bs1-<hash>` untuk keperluan test vector CI. Sudah diperbaiki di `watermark.js`.

**Bug kritis #3 — bentuk data salt di KV tidak cocok antara kode dan PRD.** Kode awal memperlakukan nilai KV `wm:salt:current`/`wm:salt:history` sebagai **string polos**, padahal PRD Beta §3.4.1 mendefinisikan bentuk **objek** (`{ salt, since }` dan `{ salt, since, until }`). Kalau ini tidak diperbaiki, begitu `salt:rotate` mulai menulis objek sesuai PRD, `resolveSalt()` akan memakai string JSON utuh sebagai salt secara diam-diam — semua watermark jadi salah tanpa error apapun. Sudah diperbaiki di `watermark.js` (toleran terhadap dua bentuk untuk migrasi) dan `rotate-salt.cjs` (menulis bentuk objek).

**Optimasi — urutan circuit breaker vs scoring dibalik.** Draft awal memanggil `checkCircuitBreaker` (butuh `await` ke KV) untuk **setiap** request non-whitelist, termasuk yang ternyata legit — menambah latensi & biaya KV ke mayoritas trafik yang tidak bersalah. Sekarang scoring (murni in-memory, tanpa I/O) dikerjakan lebih dulu; KV baru disentuh kalau request memang lolos sebagai kandidat serangan.

**Lint baru — case-sensitivity di build pipeline.** Karena `index.js` selalu me-lowercase seluruh context sebelum dicocokkan ke regex, pattern dengan huruf kapital literal (mis. `UNION SELECT`) tidak akan pernah match — signal itu "mati" secara diam-diam meski sintaksnya valid. `build-rules.cjs` sekarang menggagalkan build (fail-closed) kalau menemukan huruf kapital literal di pattern manapun, sudah diuji lewat kasus negatif (build sengaja dirusak, terbukti gagal dengan pesan jelas).

**Logging yang sebelumnya tercecer, sekarang tersambung:**
- Event `circuit_breaker_block` (IP yang diblokir CB) sekarang ikut tercatat ke Analytics Engine — sebelumnya CB block sama sekali tidak ter-log.
- Event `salt_fallback` (salt gagal diambil dari KV, jatuh ke env var/default) sekarang tercatat oleh `index.js` — kebijakan logging-nya sengaja diletakkan di sini, bukan di `watermark.js`, karena modul itu tidak punya akses `ctx.waitUntil`.

---

## 9. Known Limitations (Belum Diimplementasikan / Risiko yang Disadari)

- **Admin dashboard (PRD Beta §3.7)** — endpoint HTML untuk meninjau data Analytics Engine, terintegrasi Cloudflare Access, **belum ada kodenya sama sekali** di Beta ini. `ADMIN_PATH` di `wrangler.toml` baru placeholder.
- **Circuit breaker cuma satu level.** PRD Beta §3.7 mendefinisikan dua level: >5 trigger/menit → respons honeypot minimal (sudah ada), dan **sustained M menit → known-attacker block 24 jam** (belum ada). `ratelimit.js` hanya punya counter 60 detik sliding window.
- **Risiko block IP bersama (shared-IP collateral).** Circuit breaker bekerja per-IP. Kalau situs Anda diakses lewat NAT kantor atau CGNAT ISP, satu pengguna yang memicu 5 false-positive bisa membuat semua pengguna lain di belakang IP publik yang sama ikut terblokir. Set `CIRCUIT_BREAKER_ENABLED = "false"` di `wrangler.toml` kalau ini jadi masalah nyata di situs Anda, atau tinjau ulang threshold (`STRIKE_THRESHOLD` di `ratelimit.js`).
- **Tanpa `BANGK_ANALYTICS` binding, tidak ada log tersimpan** — desain ini murni Analytics Engine (sesuai PRD Beta §3.5), tidak ada fallback `console.log`.
- **Circuit breaker via KV bukan atomic** — di bawah burst concurrent sangat tinggi, race condition pada `recordStrike` bisa membuat hitungan strike sedikit meleset. Untuk presisi tinggi, perlu Durable Objects (di luar scope Beta).
- **NFR latensi (§5 PRD Beta, ≤25ms untuk scoring)** belum diukur dengan micro-benchmark sungguhan — baru diverifikasi fungsional (lulus test case), bukan diverifikasi performa kuantitatif.

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

- Implementasi admin dashboard (PRD Beta §3.7) + integrasi Cloudflare Access.
- Micro-benchmark CPU time untuk memverifikasi NFR §5 PRD Beta secara kuantitatif.
- Evaluasi migrasi circuit breaker dari KV ke Durable Objects kalau presisi rate limit jadi kebutuhan nyata.
# Bangk-Shield

Edge-based application layer honeypot untuk Cloudflare Workers. Mengintersep request mencurigakan (RCE, SSRF, SQLi, LFI, XSS, fuzzing/recon) di edge, sebelum sempat menyentuh origin server, lalu membalasnya dengan "roasting" bernuansa lokal dan fake payload — sambil tetap mencatat aktivitas serangan untuk dianalisis.

## 1. Apa Ini Proyek Apa?

Bangk-Shield adalah lapisan pertahanan ringan yang berjalan sepenuhnya di Cloudflare Workers/Pages — tanpa server tambahan, tanpa infrastruktur yang perlu dikelola. Alih-alih hanya memblokir request mencurigakan secara diam-diam, Bangk-Shield membalasnya dengan respons palsu yang meyakinkan (fake payload) sekaligus pesan roasting, dengan tujuan:

- **Bagi bot/scanner otomatis** (sqlmap, nuclei, ffuf, dll.) — membuat mereka percaya sedang menemukan celah, sehingga membuang waktu di jalur palsu (deception).
- **Bagi attacker manual/pentester** — memberi sinyal jelas bahwa aktivitasnya sudah diketahui (deterrence).
- **Bagi pemilik situs** — memberi visibilitas: siapa mencoba apa, kapan, dan seberapa serius (lewat log yang tersimpan, bukan cuma `console.log` yang hilang begitu saja).

Target pengguna: developer yang ingin trap keamanan ringan untuk portofolio/blog/side project, dan DevSecOps/sysadmin yang ingin lapisan deteksi recon di edge sebelum origin server.

## 2. Apa yang Sudah Dibuat (Kode Inti)

Bagian **core engine** sudah selesai dan berada di `src/`:

- **`src/index.js`** — otak dari Bangk-Shield:
  - Routing utama (`fetch` handler) untuk setiap request yang masuk.
  - Pengecekan whitelist berdasarkan path, ekstensi aset statis, dan IP.
  - Pembacaan body request dengan batas ukuran (16 KB) supaya tidak jadi celah DoS, digabung dengan URL untuk diperiksa.
  - Sistem skor (`evaluateThreat`) yang mengevaluasi request berdasarkan **keyword** dan **regex** per attack vector, baru memicu honeypot jika skor totalnya melewati threshold — bukan sekadar satu kata kunci cocok, untuk menekan false positive.
  - Sanitasi data yang dipantulkan balik ke response (URL, User-Agent) — karakter kontrol dibuang, panjang dibatasi.
  - Pemanggilan logging secara **non-blocking** (`ctx.waitUntil`) supaya pencatatan log tidak menambah latensi response ke penyerang.
  - Header penanda `X-Bangk-Shield: honeypot-active` di setiap response honeypot, sebagai bukti bahwa ini jebakan bukan kerentanan nyata.
  - Mekanisme **fail-open**: kalau terjadi error di manapun dalam engine, request tetap diteruskan ke origin, tidak pernah diblokir tanpa sengaja.

- **`src/logger.js`** — modul pencatatan event serangan, dengan urutan prioritas backend:
  1. Workers Analytics Engine (`env.BANGK_ANALYTICS`) — jika binding tersedia.
  2. Workers KV (`env.BANGK_KV`) — fallback jika Analytics Engine tidak diaktifkan.
  3. `console.log` — fallback terakhir (berguna saat development lokal dengan `wrangler dev`).

Kedua file ini sudah mendokumentasikan sendiri **kontrak data** yang mereka harapkan dari file config (lihat komentar di bagian atas `index.js`), sehingga siapapun yang melanjutkan bisa mengisi config tanpa perlu membaca ulang seluruh logic.

## 3. Apa yang Masih Harus Dilakukan

Kode inti **tidak bergantung pada isi spesifik** file-file berikut — selama bentuknya sesuai kontrak di komentar `index.js`, tinggal drop-in tanpa mengubah logic engine.

### 3.1 `config/scoring.json` (belum ada)
Berisi threshold skor dan daftar attack vector beserta bobot, keyword, dan pattern regex.

```json
{
  "threshold": 5,
  "vectors": {
    "SQLi": {
      "weight": 5,
      "keywords": ["union select", "' or 1=1", "sleep("],
      "patterns": ["(\\%27)|(\\')|(\\-\\-)"]
    },
    "LFI": {
      "weight": 4,
      "keywords": ["../", "etc/passwd"],
      "patterns": ["(\\.\\./){2,}"]
    }
  }
}
```
> Vector lain yang perlu dilengkapi: **RCE, SSRF, XSS, Directory Fuzzing/Recon**.
> Saat menulis `patterns`, hindari nested quantifier seperti `(a+)+` yang rawan ReDoS — cek dengan tool seperti `safe-regex` sebelum dimasukkan.

### 3.2 `config/whitelist.json` (belum ada)
Path dan IP yang dilewatkan langsung tanpa dicek honeypot.

```json
{
  "paths": ["/api/health", "/favicon.ico"],
  "ips": ["203.0.113.10"]
}
```

### 3.3 `src/responses.json` (belum ada)
Roast dan fake payload per attack vector — **key harus sama persis** dengan nama vector di `scoring.json`.

```json
{
  "SQLi": {
    "roast": "Union select-nya nyasar ke sini, bro.",
    "payload": "status: query_blocked_by_waf"
  },
  "LFI": {
    "roast": "../../.. nya kejauhan, ini bukan folder System32.",
    "payload": "status: path_not_found"
  }
}
```

### 3.4 `wrangler.toml` (belum ada)
Konfigurasi deployment Cloudflare Workers. Minimal perlu:
- `main = "src/index.js"`
- Format **modules** (bukan legacy service-worker), karena kode pakai `export default { fetch(...) }`.
- `compatibility_date` yang sesuai.
- Binding opsional (kode tetap jalan tanpa ini, lihat fallback di `logger.js`):
  - `ASSETS` — untuk serve aset statis (Cloudflare Pages Functions).
  - `BANGK_ANALYTICS` — Workers Analytics Engine binding.
  - `BANGK_KV` — KV namespace binding.

### 3.5 `package.json` (belum ada)
Dependencies dasar untuk Wrangler (lihat §4 di bawah untuk contoh minimal).

### 3.6 Testing sebelum deploy produksi
- Uji dengan payload sungguhan (`sqlmap`, `nuclei`, manual curl) untuk memastikan threshold skor tidak terlalu sensitif (false positive) atau terlalu longgar (false negative).
- Cek header `X-Bangk-Shield` benar-benar muncul di response honeypot dan tidak muncul di trafik legit.
- Verifikasi log benar-benar tersimpan (cek dashboard Analytics Engine atau isi KV namespace).

## 4. Cara Bikin & Jalankan

### 4.1 Struktur folder akhir yang diharapkan
```text
Bangk-Shield/
├── README.md
├── wrangler.toml
├── package.json
├── config/
│   ├── whitelist.json
│   └── scoring.json
└── src/
    ├── index.js
    ├── logger.js
    └── responses.json
```

### 4.2 Prasyarat
- Node.js (versi LTS terbaru) dan npm terpasang.
- Akun Cloudflare (gratis sudah cukup untuk mulai).
- Wrangler CLI — tool resmi Cloudflare untuk develop & deploy Workers.

### 4.3 Setup awal
```bash
# 1. Install Wrangler sebagai dev dependency (atau global, sesuai preferensi)
npm install -D wrangler

# 2. Login ke akun Cloudflare
npx wrangler login

# 3. Lengkapi config/scoring.json, config/whitelist.json, src/responses.json
#    sesuai kontrak yang dijelaskan di §3, lalu buat wrangler.toml, contoh minimal:
```

Contoh minimal `wrangler.toml`:
```toml
name = "bangk-shield"
main = "src/index.js"
compatibility_date = "2026-01-01"

# Opsional — aktifkan sesuai kebutuhan
# [[kv_namespaces]]
# binding = "BANGK_KV"
# id = "isi-dengan-id-kv-namespace-anda"

# [[analytics_engine_datasets]]
# binding = "BANGK_ANALYTICS"
```

Contoh minimal `package.json`:
```json
{
  "name": "bangk-shield",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "wrangler": "^3.0.0"
  }
}
```

### 4.4 Jalankan secara lokal
```bash
npm run dev
```
Wrangler akan menjalankan Worker di `http://localhost:8787` (atau port lain yang ditampilkan di terminal). Coba akses dengan payload uji, misalnya:
```bash
curl "http://localhost:8787/?id=1' UNION SELECT 1--"
```
Kalau setup benar, response honeypot dengan header `X-Bangk-Shield: honeypot-active` akan muncul.

### 4.5 Deploy ke Cloudflare
```bash
npm run deploy
```
Setelah deploy sukses, Wrangler akan menampilkan URL Worker (format `*.workers.dev`) atau domain kustom jika sudah dikonfigurasi di dashboard Cloudflare / `wrangler.toml`.

## 5. Roadmap Selanjutnya (Post-MVP)

- **Phase 2:** Migrasi log dari Analytics Engine/KV ke database terpusat (Cloudflare D1 / Supabase) untuk agregasi lintas domain.
- **Phase 3:** Alerting instan via Webhook (Discord/Telegram) untuk serangan skor tinggi.
- **Phase 4:** Tombol "Deploy to Cloudflare" satu klik untuk adopsi developer lain.
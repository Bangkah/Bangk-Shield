# Bangk-Shield


Edge-based application layer honeypot untuk Cloudflare Workers. Mengintersep request mencurigakan (SQLi, RCE, SSRF, LFI, XSS, dan fuzzing/recon) di edge — sebelum sempat menyentuh origin server — lalu membalasnya dengan "roasting" bernuansa lokal dan fake payload, sambil tetap mencatat aktivitas serangan untuk dianalisis.

---

## 1. Apa Ini Proyek Apa?

Bangk-Shield adalah lapisan pertahanan ringan yang berjalan sepenuhnya di Cloudflare Workers — tanpa server tambahan, tanpa infrastruktur yang perlu dikelola. Alih-alih hanya memblokir request mencurigakan secara diam-diam, Bangk-Shield membalasnya dengan respons palsu yang meyakinkan (fake payload) sekaligus pesan roasting, dengan tiga tujuan:

- **Bagi bot/scanner otomatis** (sqlmap, nuclei, ffuf, dll.) — membuat mereka percaya sedang menemukan celah, sehingga membuang waktu di jalur palsu (*deception*).
- **Bagi attacker manual/pentester** — memberi sinyal jelas bahwa aktivitasnya sudah diketahui (*deterrence*).
- **Bagi pemilik situs** — memberi visibilitas: siapa mencoba apa, kapan, dan seberapa serius, lewat log yang benar-benar tersimpan (bukan cuma `console.log` yang hilang begitu saja).

Target pengguna: developer yang ingin trap keamanan ringan untuk portofolio/blog/side project, dan DevSecOps/sysadmin yang ingin lapisan deteksi recon di edge sebelum origin server.

---

## 2. Struktur Proyek

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

---

## 3. Cara Kerja Engine (`src/index.js`)

Alur setiap request yang masuk ke Worker:

1. **Cek whitelist** — path yang cocok ekstensi aset statis (`.js`, `.css`, `.svg`, dll.), path yang terdaftar di `config/whitelist.json`, atau IP klien yang terdaftar di sana → diteruskan langsung ke origin, tidak diperiksa.
2. **Baca URL + body** — body request dibaca maksimal 16 KB pertama (`MAX_INSPECT_BYTES`) untuk mencegah request raksasa jadi vektor DoS terhadap Worker itu sendiri. URL dan body digabung jadi satu teks yang diperiksa.
3. **Evaluasi skor** — teks tadi dicocokkan terhadap keyword dan regex tiap attack vector di `config/scoring.json`. Setiap vector yang cocok menambah skor sesuai bobotnya.
4. **Bandingkan ke threshold** — kalau skor total ≥ `threshold` (saat ini `5`), honeypot aktif: response palsu dikirim balik beserta header `X-Bangk-Shield: honeypot-active`.
5. **Log non-blocking** — event serangan dicatat lewat `ctx.waitUntil()` (lihat §7) supaya tidak menambah latensi response ke penyerang.
6. **Kalau bukan serangan** — request diteruskan apa adanya ke origin/aset asli.
7. **Fail-open** — kalau ada error apapun di titik manapun dalam proses ini, request tetap diteruskan ke origin. Bangk-Shield tidak pernah memblokir trafik karena bug internalnya sendiri.

Data yang dipantulkan balik ke response (URL, User-Agent) sudah disanitasi — karakter kontrol dibuang dan panjangnya dibatasi 500 karakter — supaya tidak jadi celah log/response injection.

---

## 4. Konfigurasi Deteksi (`config/scoring.json`)

Threshold saat ini: **5**. Bobot per attack vector didesain berjenjang, bukan flat, supaya vector yang risiko false-positive-nya tinggi butuh kombinasi sinyal, sementara vector yang sinyalnya sudah cukup spesifik bisa memicu sendirian:

| Vector | Bobot | Bisa memicu sendirian? | Contoh keyword/pattern yang dicek |
|---|---|---|---|
| **SQLi** | 5 | Ya | `union select`, `or 1=1`, `sleep(`, `xp_cmdshell`, pattern `\bunion\s+select\b` |
| **RCE** | 5 | Ya | `/bin/bash`, `exec(`, `eval(`, `wget http`, pattern `(;\|\|\|&&)\s*(cat\|ls\|whoami)` |
| **SSRF** | 5 | Ya | `169.254.169.254`, `metadata.google.internal`, `file://`, `gopher://` |
| **LFI** | 4 | Tidak (perlu tambahan sinyal) | `etc/passwd`, `php://filter`, pattern `(\.\./){2,}` |
| **XSS** | 3 | Tidak | `<script`, `onerror=`, `document.cookie`, pattern `<\s*script[^>]*>` |
| **Recon** | 2 | Tidak | `.env`, `.git/config`, `wp-admin`, `phpmyadmin`, `.htpasswd` |

Semua regex ditulis sederhana (tanpa nested quantifier seperti `(a+)+`) untuk menghindari *catastrophic backtracking* (ReDoS), dan hanya dites terhadap teks yang sudah dibatasi 16 KB.

> Daftar keyword/pattern lengkap ada langsung di `config/scoring.json` — tabel di atas hanya cuplikan.

---

## 5. Konfigurasi Whitelist (`config/whitelist.json`)

```json
{
  "paths": ["/robots.txt", "/sitemap.xml", "/favicon.ico", "/api/health"],
  "ips": []
}
```

Path-path umum yang wajar diakses siapa saja (robots, sitemap, favicon, health check) sudah dibebaskan dari pengecekan. Array `ips` sengaja dikosongkan — isi dengan IP kantor/tim/monitoring internal kalau perlu dikecualikan dari honeypot.

---

## 6. Respons Honeypot (`src/responses.json`)

Setiap attack vector punya roast bernuansa lokal dan fake payload sendiri (7 entri: `SQLi`, `RCE`, `SSRF`, `LFI`, `XSS`, `Recon`, plus `Unknown Reconnaissance` sebagai fallback untuk vector yang belum terdefinisi). Contoh:

```json
"SQLi": {
  "roast": "Union select nyasar ke lapak yang salah, bang...",
  "payload": "MySQL error 1064: syntax intentionally malformed near 'FROM users'..."
}
```

Setiap `payload` sengaja dibuat terlihat meyakinkan tapi **tidak mengandung info sensitif nyata apapun** (bukan versi software asli, bukan struktur file asli) — supaya aman kalau ter-screenshot dan tidak disalahartikan sebagai kebocoran beneran.

---

## 7. Logging (`src/logger.js`)

Urutan prioritas backend logging, dipilih otomatis sesuai binding yang aktif di `wrangler.toml`:

1. **Workers Analytics Engine** (`env.BANGK_ANALYTICS`) — kalau binding diaktifkan.
2. **Workers KV** (`env.BANGK_KV`) — fallback kalau Analytics Engine tidak diaktifkan.
3. **`console.log`** — fallback terakhir, terlihat lewat `wrangler tail` saat development lokal.

Di versi beta ini, **kedua binding (KV & Analytics Engine) belum diaktifkan** di `wrangler.toml` — jadi log saat ini jalan lewat fallback `console.log`. Ini disengaja untuk tahap testing awal supaya tidak perlu setup Cloudflare tambahan dulu.

---

## 8. Konfigurasi Deployment (`wrangler.toml` & `package.json`)

`wrangler.toml` saat ini:
- `main = "src/index.js"`, `compatibility_date = "2026-01-01"`.
- Belum ada `routes` — artinya kalau di-deploy sekarang, Worker akan aktif di subdomain `*.workers.dev` bawaan, bukan di domain kustom.
- Binding `ASSETS`, `BANGK_KV`, `BANGK_ANALYTICS` masih dikomentari (nonaktif) — lihat §7.

`package.json` menyediakan script:

| Script | Fungsi |
|---|---|
| `npm run dev` | Jalankan Worker secara lokal via `wrangler dev` |
| `npm run deploy` | Deploy ke akun Cloudflare |
| `npm run tail` | Lihat log real-time (`wrangler tail`) |
| `npm run kv:create` | Bikin KV namespace baru kalau nanti mau aktifkan `BANGK_KV` |

---

## 9. Cara Menjalankan

### 9.1 Prasyarat
- Node.js versi LTS terbaru dan npm.
- Akun Cloudflare (tier gratis cukup).

### 9.2 Install & login
```bash
npm install
npx wrangler login
```

### 9.3 Jalankan lokal
```bash
npm run dev
```
Worker akan aktif di `http://localhost:8787` (atau port lain yang ditampilkan). Contoh uji coba:

```bash
# SQLi -> harusnya kena honeypot
curl -i "http://localhost:8787/?id=1' UNION SELECT 1--"

# LFI -> harusnya kena honeypot
curl -i "http://localhost:8787/../../etc/passwd"

# Recon -> sendirian belum cukup skor (weight 2 < threshold 5), harusnya LOLOS
curl -i "http://localhost:8787/.env"

# Trafik biasa -> harusnya lolos normal
curl -i "http://localhost:8787/"
```
Response honeypot ditandai header `X-Bangk-Shield: honeypot-active`. Pantau log di terminal lain dengan `npm run tail`.

### 9.4 Deploy
```bash
npm run deploy
```
Setelah sukses, Wrangler menampilkan URL Worker. Untuk pasang di depan domain yang sudah ada, isi bagian `routes` di `wrangler.toml` (lihat komentar di dalamnya) lalu deploy ulang.

---

## 10. Roadmap Setelah Beta

- **Phase 2:** Aktifkan `BANGK_ANALYTICS` atau `BANGK_KV`, lalu migrasi ke database terpusat (Cloudflare D1 / Supabase) untuk agregasi log lintas domain.
- **Phase 3:** Alerting instan via Webhook (Discord/Telegram) untuk serangan skor tinggi.
- **Phase 4:** Tombol "Deploy to Cloudflare" satu klik untuk adopsi developer lain.

Penyesuaian bobot skor, pattern regex, dan isi roast/payload akan dilakukan berdasarkan hasil testing beta ini — dokumen ini akan diperbarui mengikuti perubahan tersebut.
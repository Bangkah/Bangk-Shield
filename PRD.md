# Product Requirements Document (PRD): Bangk-Shield (Beta Version)

## 1. Overview & Vision

**Product Name:** Bangk-Shield
**Description:** Aplikasi honeypot berbasis *edge* (Cloudflare Workers) yang mengintersep request mencurigakan — RCE, SSRF, SQLi, LFI, XSS, dan *fuzzing* — lalu merespons dengan payload palsu dan pesan *roasting* bernuansa lokal, sambil mencatat aktivitas penyerangan untuk analisis lebih lanjut.
**Core Philosophy:** Keamanan tidak harus kaku. Bangk-Shield menggabungkan deteksi serangan yang serius secara teknis dengan respons yang menghibur, namun tetap berpegang teguh pada tujuan fungsional perlindungan infrastruktur.

### 1.1 Sasaran Audiens & Tujuan Utama

Bot *scanner* otomatis (seperti sqlmap, nuclei, ffuf) tidak memproses humor; mereka hanya mengevaluasi *status code* dan pola respons. Oleh karena itu, sistem ini dirancang dengan segmentasi tujuan berikut:

* **Bot/Scanner Otomatis:** **Deception** — Membuat *scanner* percaya bahwa sebuah endpoint "rentan" agar membuang waktu dan *resource* di jalur palsu. Membutuhkan *response time* realistis, *status code* yang masuk akal, dan *payload* palsu yang meyakinkan.
* **Attacker Manual / Pentester:** **Deterrence + Branding** — Memberikan pesan *roasting* sebagai sinyal tegas bahwa aktivitas mereka telah terdeteksi. Humor lokal menegaskan bahwa ini adalah jebakan, bukan kerentanan sistem.
* **Pemilik Situs (Developer):** **Visibility** — Mengetahui siapa yang mencoba menyerang, kapan, dan menggunakan vektor apa, melalui dasbor log yang dapat diakses secara persisten.

---

## 2. Target Users

* **Developers & Tech Enthusiasts:** Membutuhkan *trap* keamanan ringan tanpa infrastruktur server tambahan untuk melindungi portofolio, blog, atau *side project*.
* **System Administrators / DevSecOps:** Membutuhkan lapisan pertahanan *edge* untuk mendeteksi, mencatat, dan menahan aktivitas *reconnaissance* sebelum menyentuh *origin server*.

---

## 3. Key Features & Requirements

### 3.1 Edge-Native Deployment

Aplikasi berjalan sepenuhnya pada isolat Cloudflare Workers/Pages. Tidak memerlukan manajemen server, kontainer, maupun pemeliharaan infrastruktur tradisional.

### 3.2 Modular Rule Engine & Kompilasi Statis

Seluruh aturan deteksi, bobot skor, pesan *roasting*, dan *payload* palsu disatukan dalam satu sumber kebenaran: `config/rules.json`.

* **Kompilasi Build-Time:** Untuk menghemat siklus CPU di *edge*, `rules.json` tidak di-parsing pada saat *runtime*. Sebuah skrip CI (`scripts/build-rules.js`) akan memvalidasi *JSON schema*, melakukan *linting* ReDoS (mencegah *catastrophic backtracking*), dan mengompilasi pola menjadi artefak `src/rules.compiled.json`.
* **Konteks Evaluasi (Where):** Setiap sinyal serangan mendefinisikan sumber pemindaian eksplisit (`path`, `query`, `body`, `headers`) untuk menekan *false positive*.
* **Combo Bonus:** Sinyal-sinyal lemah dapat digabungkan untuk memicu skor tinggi jika muncul secara bersamaan (misal: *path* tidak dikenal + parameter karakter khusus).
* **Batasan Ukuran Body:** Sistem membatasi pemindaian maksimal 16 KB pertama dari *body request* sebelum mengeksekusi mesin regex.

### 3.3 Multi-Vector Detection & False Positive Mitigation

Deteksi menggunakan skor kumulatif berbasis *threshold*. Evaluasi dihentikan dan disalurkan ke *passthrough* normal apabila:

* **Path Classification:** Request mengarah ke *known-asset path* (mis. `.css`, `.js`, atau *path* yang ada di `whitelist.json`). Daftar ini dimuat sebagai *in-memory Set* hasil kompilasi (maksimal 10.000 entri) untuk *lookup* O(1).
* **Content-Type Sanity:** Pemindaian body hanya diaktifkan untuk tipe konten berbasis teks (`application/json`, `application/x-www-form-urlencoded`, dll.). *File binary* otomatis diabaikan.

### 3.4 Interactive Responses & Dynamic Watermarking

Respons honeypot menampilkan simulasi sistem log, *roasting*, dan waktu tunda respons yang dikalkulasi acak (mis. 120ms - 450ms) agar mengelabui heuristik *scanner*.

* **Transparansi Decoy:** Respons selalu memuat header `X-Bangk-Shield: honeypot-active`.
* **Watermark Kriptografis:** Menyertakan bukti keaslian berupa hash dinamis yang diderivasi dari `hash(IP + User-Agent + Date + Salt)`. Hal ini memastikan bahwa *screenshot* dari penyerang dapat diverifikasi oleh pemilik situs, namun pihak ketiga tidak dapat memalsukan keberhasilan serangan.
* **Manajemen Salt via KV:** Skrip operasional rotasi (`npm run salt:rotate`) menyimpan salt aktif di `wm:salt:current` dan salt sebelumnya di `wm:salt:history` pada Cloudflare KV, memungkinkan verifikasi mundur hingga 5 generasi tanpa menyentuh *env vars* secara manual.

#### 3.4.1 Spesifikasi Format Watermark (Test Vector CI)

Format berikut bersifat **mengikat** — perubahan apapun terhadapnya harus melalui versioning eksplisit (`/v2`, `bs2-`, dst.), bukan menimpa format yang sudah beredar, karena test vector CI dan watermark yang sudah pernah diterbitkan bergantung padanya:

* **Canonical string:** `bangk-shield/v1|<ip>|<ua>|<yyyy-mm-dd>|<salt>`
* **Output:** `bs1-<16 karakter hex pertama dari SHA-256(canonical)>`
* **Bentuk data KV:**
  * `wm:salt:current` → objek `{ "salt": "...", "since": "<ISO date>" }`
  * `wm:salt:history` → array objek `[{ "salt": "...", "since": "...", "until": "..." }, ...]`, maksimal 5 entri
* **Event `salt_fallback`:** dicatat ke Analytics Engine setiap kali salt tidak berhasil diambil dari KV dan sistem jatuh ke fallback (env var atau default dev).

### 3.5 Logging (Best-Effort Analytics)

* **Penyimpanan:** Memanfaatkan *Workers Analytics Engine* untuk agregasi log *time-series* (timestamp, IP hash, *path*, vektor, skor, metode).
* **Mitigasi Kuota & Write Failure:** Karena API Analytics Engine bersifat *fire-and-forget*, kegagalan penulisan (kuota habis/insiden) ditangkap secara *synchronous* tanpa mengganggu respons ke klien. Sistem memelihara *counter* metrik *dropped events* secara *in-memory* yang dapat dipantau.
* **Sampling:** Aktivitas *recon* berbobot sangat rendah di-*sampling* sebelum ditulis ke Analytics Engine untuk menghemat kuota harian paket gratis.

### 3.6 Rate Limiting & Circuit Breaker

Melindungi kuota eksekusi CPU *Worker* dari serangan *spamming* membabi buta:

* **Mekanisme KV Counter:** Menghitung jumlah *trigger* honeypot per IP (TTL 60 detik).
* **Circuit Breaker:** Jika sebuah IP melampaui ambang batas *trigger* beruntun (mis. 5 kali/menit), respons honeypot akan dijatuhkan ke mode statis minimal (tanpa komputasi *delay* atau evaluasi payload lanjutan).

### 3.7 Endpoint Admin yang Aman

Dasbor analitik ringan (HTML statis *server-side rendered*) untuk meninjau data Analytics Engine.

* **Zero-Static Token:** Endpoint ini tidak mengandalkan token manual.
* **Autentikasi Integrasi:** Diwajibkan menggunakan **Cloudflare Access** untuk validasi sesi admin.
* **Obfuscation Path:** URL menuju dasbor menggunakan segmen acak yang disuntikkan melalui *Environment Variables* saat *deploy* (`ADMIN_PATH`), meminimalisir kemungkinan enumerasi path oleh pihak eksternal. Tanpa integrasi Cloudflare Access, endpoint dinonaktifkan sepenuhnya secara *default*.
* **Circuit Breaker Dua Level (rujukan awal, belum diimplementasikan di Beta):** Level 1 — >5 *trigger*/menit → respons honeypot minimal. Level 2 — *sustained* selama M menit → status *known-attacker*, block 24 jam.

---

## 4. Proposed Architecture & File Structure

```text
Bangk-Shield/
├── README.md                 # Dokumentasi setup, spesifikasi watermark, disclaimer honeypot
├── wrangler.toml              # Konfigurasi Workers, binding KV & Analytics Engine, Env Vars
├── package.json                # Dependensi proyek & build scripts
├── config/
│   ├── whitelist.json          # Exact path & prefix yang melewati pemeriksaan (known-asset)
│   ├── rules.json               # Pola deteksi, threshold kumulatif, roast, fake payload
│   └── rules.schema.json         # JSON Schema untuk validasi format file aturan
├── scripts/
│   ├── build-rules.js            # CI Pipeline: Validasi, ReDoS linting, kompilasi ke artefak statis
│   └── rotate-salt.js             # Rotasi salt watermark tanpa redeploy
└── src/
    ├── index.js              # Entry point, routing, evaluasi path, dan fail-open handler
    ├── rules.compiled.json   # Artefak build (regex diserialisasi)
    ├── scanner.js            # Modul eksekusi Regex, evaluasi skor kumulatif
    ├── ratelimit.js          # Pengelola KV Counter & perlindungan Circuit Breaker
    ├── watermark.js          # Generator & verifikator derivasi hash
    └── logger.js             # Abstraksi best-effort Analytics Engine

```

---

## 5. Non-Functional Requirements (NFR)

* **Latency Budget (Performance):** Pengukuran ditargetkan berdasarkan nilai persentil (p95). Toleransi maksimal penambahan latensi pada trafik sah (*known-asset*) adalah **≤ 5ms** di atas *baseline*, sedangkan trafik yang melewati *scoring engine* ditargetkan **≤ 25ms** tambahan.
* **Fail-Open by Design (Runtime Resilience):** Apabila modul mesin deteksi mengalami kegagalan proses di eksekusi *runtime*, sistem secara otomatis mundur ke mode *passthrough* (melayani trafik secara normal) dan mencetak log *engine_error*. Operasional situs asal tidak boleh terhenti oleh kegagalan alat keamanan.
* **Fail-Closed by Pipeline (CI/CD):** Jika modifikasi pada `rules.json` gagal melewati validasi *schema* atau *linter* ReDoS saat proses kompilasi awal, *deployment* harus dihentikan sepenuhnya.
* **CPU Time Compliance:** Logika evaluasi (pemotongan body 16 KB dan siklus komputasi artefak regex) harus diverifikasi lolos di bawah **5ms CPU time** pada *micro-benchmark* CI (*cold-start* memori ≤ 10ms) untuk memastikan aplikasi aman dijalankan pada Cloudflare Workers Free Tier.

---

## 6. Acceptance Criteria

* **Whitelist Passthrough:** Permintaan HTTP yang mengarah ke aset statis atau path di dalam *whitelist* merespons secara identik dengan *origin* asli tanpa pemicu *honeypot*, dengan latensi berada pada batas *budget* (p95 + 5ms).
* **Attack Detection:** Serangan valid (contoh: payload `UNION SELECT` pada *body* POST menuju *path* tidak dikenal) memicu respons *honeypot* lengkap berserta pengiriman header `X-Bangk-Shield: honeypot-active`.
* **Watermark Verifiability:** Nilai hash *watermark* pada respons dapat direkonstruksi ulang dan divalidasi menggunakan spesifikasi parameter *hash* dan *salt* KV yang aktif (atau rotasi sebelumnya), sesuai format §3.4.1.
* **Circuit Breaker Engagement:** Pengiriman 10 *request* *honeypot* pemicu dari IP yang sama dalam kurun 1 menit akan memaksa sistem mengaktifkan respons honeypot mode statis minimal.
* **Best-Effort Logging:** Modul logging tidak memengaruhi siklus penyelesaian respons meskipun fungsi *Analytics Engine* disimulasikan gagal (*mock error throw*).
* **Admin Security:** Akses menuju URL endpoint admin tanpa *cookie* sesi Cloudflare Access akan ditolak tanpa memberikan konfirmasi visual bahwa endpoint tersebut ada.

---

## 7. Status Implementasi (Beta)

Bagian ini melacak kesenjangan antara PRD dan kode yang sudah berjalan — lihat `README.md` §8–9 untuk detail changelog dan known limitations lengkap.

| Requirement | Status di Beta |
|---|---|
| §3.1–3.6 (engine inti, scoring, watermark, logging, circuit breaker level 1) | ✅ Terimplementasi & diuji |
| §3.4.1 format watermark & bentuk data KV | ✅ Terimplementasi sesuai spesifikasi |
| §3.6/3.7 circuit breaker level 2 (known-attacker 24 jam) | ❌ Belum |
| §3.7 admin dashboard + Cloudflare Access | ❌ Belum ada kode sama sekali |
| §5 NFR latensi (p95 ≤5ms / ≤25ms) & CPU time ≤5ms | ⚠️ Belum diverifikasi kuantitatif, baru fungsional |
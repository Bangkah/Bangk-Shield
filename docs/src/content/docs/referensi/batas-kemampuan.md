---
title: Batas Kemampuan & Catatan Implementasi
description: Fitur yang belum ada, selisih antara dokumentasi dan kode, serta risiko operasional.
---

Halaman ini sengaja dibuat eksplisit agar Anda tidak mengandalkan fitur yang belum ada.
Status proyek adalah **beta**, dan beberapa bagian PRD belum diimplementasikan.

## Fitur yang belum tersedia

| Fitur | Status | Dampak |
| --- | --- | --- |
| Admin dashboard HTML | Belum ada kode | Tidak ada UI untuk meninjau event |
| Integrasi Cloudflare Access | Belum ada | Tidak ada autentikasi dashboard |
| Circuit breaker level 2 (block 24 jam) | Belum ada | Hanya ada counter 60 detik |
| Counter metrik dropped events | Belum ada | Kegagalan logging tidak terukur |
| Micro-benchmark NFR | Belum ada | Target latency/CPU belum diverifikasi |
| Test suite otomatis | Tidak ada di repo | Regresi harus diuji manual |
| Skrip `rotate-salt.cjs` | Tidak ada | `npm run salt:rotate` gagal |

## Selisih dokumentasi dan kode

Beberapa klaim di `README.md` dan `PRD.md` belum tercermin di kode saat ini.

### 1. Validasi JSON Schema tidak dijalankan

README dan PRD menyebut validasi memakai Ajv terhadap `config/rules.schema.json`. Faktanya:

- `ajv` ada di `dependencies`, tetapi tidak diimpor di mana pun.
- `scripts/build-rules.cjs` melakukan validasi manual, bukan schema validation.
- File schema aktual bernama `config/rules.scema.json` (typo) dan tidak dibaca.

Validasi manual tetap menangkap field wajib, regex tidak valid, dan nilai di luar rentang,
tetapi tidak menegakkan `additionalProperties: false` seperti schema.

### 2. Lint huruf kapital tidak ada

README menyatakan build gagal jika pattern mengandung huruf kapital literal. Pemeriksaan itu
tidak ada di `build-rules.cjs`.

Selain itu, klaim tersebut tidak lagi relevan karena `compileRules()` memakai flag default `i`,
sehingga pattern kapital tetap cocok dengan context yang sudah lowercase.

### 3. Sinyal `%27` tidak pernah cocok

Sinyal SQLi ke-4 adalah:

```json
{ "pattern": "(%27)|(\\-\\-\\s)", "where": ["query", "body"], "score": 25 }
```

`%27` adalah tanda kutip ter-encode. Context sudah di-decode sebelum evaluasi, sehingga `%27`
sudah berubah menjadi `'` dan cabang tersebut tidak pernah match. Bagian `\-\-\s` masih berfungsi
untuk komentar SQL yang diikuti spasi.

### 4. Flag `dropped` selalu `false`

```js
blobs: [event.ip || '', event.path || '', event.vector || '', String(Boolean(dropped))]
```

Event yang di-drop karena sampling sudah `return` lebih awal. Saat `writeDataPoint()` dipanggil,
`dropped` selalu `false`. Field ini belum bisa dipakai untuk mengukur sampling.

### 5. Event circuit breaker dan salt fallback sering hilang

Keduanya dikirim dengan `score: 0`. Logger menganggap `score < 30` sebagai event skor rendah dan
hanya menulis 20%. Akibatnya, sekitar 80% event blokir dan fallback tidak tercatat.

### 6. `resolveSaltCandidates()` belum dipakai

Fungsi tersedia dan diekspor, tetapi tidak dipanggil oleh engine, dashboard, atau skrip mana pun.

### 7. `headers` hanya berisi User-Agent

Context `headers` diisi dari `User-Agent` saja. Sinyal yang menargetkan header lain tidak akan
pernah cocok, meskipun `where` menerima nilai `headers`.

### 8. Perbedaan `src/index.js` dan `publish/index.ts`

| Aspek | Worker | Library |
| --- | --- | --- |
| Tanpa origin | Placeholder 200 | `null` |
| Loop guard pada known-asset | Ya, lewat `passthrough()` | Tidak diset |
| Fallback error | Memakai `env.ORIGIN_URL` | Juga, **bukan** `options.originUrl` |
| Cek KV | Memanggil fungsi, fungsi menangani KV kosong | Dicek eksplisit |

Jika memakai mode library, tangani `null` dan pastikan `env.ORIGIN_URL` atau `env.ASSETS`
tersedia untuk jalur error.

### 9. Ambang circuit breaker

Dokumentasi menyebut “≥ 5 trigger/menit”. Implementasinya memeriksa counter **sebelum**
menambah strike, sehingga blokir efektif mulai pada trigger **keenam** dalam window tersebut.

### 10. TTL counter diperbarui setiap strike

Window bukan 60 detik tetap. Setiap strike menulis ulang key dengan TTL baru, sehingga efeknya
adalah “5 strike tanpa jeda 60 detik”.

## Risiko operasional

### False positive dan shared IP

Deteksi berbasis regex dapat memicu false positive pada konten sah, misalnya artikel yang
membahas `union select` atau dokumentasi yang memuat `<script>`. Karena circuit breaker bekerja
per IP publik, pengguna di balik NAT/CGNAT bisa ikut terblokir.

Mitigasi:

- Nonaktifkan circuit breaker jika situs Anda banyak diakses dari IP bersama.
- Tambahkan path sensitif ke whitelist.
- Naikkan threshold atau sesuaikan skor sinyal.
- Tinjau ulang pola regex yang terlalu luas.

### Race condition KV

`recordStrike()` melakukan `get` lalu `put`, bukan operasi atomic. Di bawah burst concurrent
tinggi, hitungan bisa meleset. Untuk presisi tinggi diperlukan Durable Objects.

### Logging bergantung pada binding

Tanpa `BANGK_ANALYTICS`, tidak ada log sama sekali. Tidak ada fallback `console.log`, sehingga
`wrangler tail` hanya menampilkan error, bukan event serangan.

### ID namespace KV ada di repository

`wrangler.toml` saat ini memuat `id` namespace KV secara langsung. ID ini bukan secret, tetapi
jika repository publik, siapa pun dapat melihat nama namespace. Ganti dengan namespace milik
Anda dan pertimbangkan memindahkannya ke konfigurasi environment.

### Tidak ada header keamanan tambahan

Response honeypot tidak menyetel `Cache-Control`, `Content-Security-Policy`, atau header
keamanan lain. Jika response ini melewati CDN, pertimbangkan untuk menambahkan `Cache-Control:
no-store`.

### Delay menambah latensi

Delay honeypot adalah bagian dari desain, tetapi pada serangan volumetrik ia bisa memperpanjang
waktu eksekusi Worker. Circuit breaker membantu, tetapi tidak menghilangkan seluruh beban.

## Checklist sebelum produksi

- [ ] `ORIGIN_URL` atau binding `ASSETS` sudah benar; trafik normal sampai ke origin.
- [ ] Namespace KV sudah dibuat dan `id` di `wrangler.toml` sudah diganti.
- [ ] Binding `BANGK_ANALYTICS` aktif dan dataset dapat di-query.
- [ ] Salt produksi disimpan di KV `wm:salt:current`, bukan `WATERMARK_SALT`.
- [ ] `CIRCUIT_BREAKER_ENABLED` diputuskan sesuai profil trafik (NAT/CGNAT?).
- [ ] Whitelist path dan prefix sudah disesuaikan; tidak ada prefix terlalu luas.
- [ ] `config/rules.json` sudah diuji dengan `npm run build:rules` dan skenario manual.
- [ ] Status code dan fake payload sudah sesuai selera.
- [ ] Rotasi salt memiliki prosedur manual sampai `rotate-salt.cjs` tersedia.
- [ ] Log Analytics dipantau; event circuit breaker/salt fallback diingat ter-sampling.
- [ ] `npm run tail` dipantau setelah deploy pertama.

## Rekomendasi perbaikan

1. Tambahkan `scripts/rotate-salt.cjs` sesuai bentuk data PRD.
2. Integrasikan validasi Ajv dengan `config/rules.schema.json` (perbaiki nama file).
3. Hapus atau perbaiki sinyal `%27`.
4. Perbaiki semantik `dropped` di logger, atau hapus field tersebut.
5. Kecualikan `circuit_breaker_block` dan `salt_fallback` dari sampling.
6. Tambahkan test suite untuk watermark test vector dan scoring.
7. Ukur latency/CPU dengan micro-benchmark.
8. Samakan perilaku `src/index.js` dan `publish/index.ts`.

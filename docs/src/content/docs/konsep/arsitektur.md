---
title: Arsitektur & Alur Request
description: Urutan evaluasi setiap request, modul yang terlibat, dan prinsip fail-open.
---

Bangk-Shield adalah satu Worker yang mengorkestrasi beberapa modul kecil. Semua keputusan
deteksi terjadi di memori; I/O ke KV hanya dilakukan untuk request yang sudah terdeteksi
sebagai kandidat serangan.

## Dua entry point

| File | Dipakai oleh | Perilaku passthrough |
| --- | --- | --- |
| `src/index.js` | `wrangler.toml` (`main`) | Memakai `passthrough()` dari `src/utils.js` |
| `publish/index.ts` | Package npm (`main: dist/index.js`) | Memakai `options.originUrl` atau mengembalikan `null` |

Keduanya memakai engine yang sama, tetapi berbeda pada cara meneruskan trafik dan penanganan
binding. Perbedaan detail ada di [API Programmatic](/referensi/api/).

## Alur request (`src/index.js`)

```text
Request masuk
   │
   ├─ 1. Known-asset check ──────────────► passthrough()
   │      ekstensi statis / exact path /
   │      prefix / IP whitelist
   │
   ├─ 2. Context extraction
   │      path, query, headers (UA), body
   │      di-decode + lowercase
   │      body dibaca maks. 16 KB jika teks
   │
   ├─ 3. Scoring (in-memory)
   │      semua vector dievaluasi
   │      skor tertinggi + combo bonus
   │
   ├─ 4. score < threshold? ─────────────► passthrough()
   │
   ├─ 5. Circuit breaker (KV)
   │      IP diblokir? ──────────────────► 403 statis
   │
   ├─ 6. recordStrike (KV)
   ├─ 7. delay acak (deception)
   ├─ 8. resolveSalt + generateWatermark
   ├─ 9. log event (Analytics Engine)
   │
   └─ 10. Response honeypot (roast + fake payload)
```

### 1. Known-asset check

`isKnownAsset()` di `src/utils.js` mengembalikan `true` jika salah satu kondisi berikut terpenuhi:

- Path berakhiran ekstensi statis: `.js`, `.css`, `.svg`, `.png`, `.ico`, `.jpg`, `.woff`, `.woff2`.
- Path persis ada di `whitelist.paths`.
- Path diawali salah satu `whitelist.prefixes`.
- IP klien ada di `whitelist.ips`.

Pemeriksaan ini dilakukan **sebelum** decoding dan lowercasing, memakai `url.pathname` mentah.
Detail ada di [Whitelist](/konfigurasi/whitelist/).

### 2. Context extraction

Empat field dibentuk untuk mesin regex:

| Field | Sumber | Transformasi |
| --- | --- | --- |
| `path` | `url.pathname` | `safeDecode()` lalu `toLowerCase()` |
| `query` | `url.search` | `safeDecode()` lalu `toLowerCase()` |
| `headers` | Hanya header `User-Agent` | `toLowerCase()` |
| `body` | Body request | `safeDecode()` lalu `toLowerCase()` |

Body hanya dibaca jika `Content-Type` mengandung `json`, `form`, atau `text`. Pembacaan dibatasi
`body_scan_limit_bytes` (default 16.384 byte). `request.clone()` dipakai agar body asli tetap utuh
untuk diteruskan ke origin.

`safeDecode()` membungkus `decodeURIComponent()` dengan `try/catch`; input malformed tidak pernah
melempar error ke atas.

### 3. Scoring

`evaluateThreat()` menjalankan setiap vector yang `enabled`, menjumlahkan skor sinyal yang cocok,
menambahkan `combo_bonus`, lalu memilih vector dengan skor tertinggi. Detail algoritma ada di
[Rule Engine](/konsep/rule-engine/).

### 4. Threshold

Request dianggap serangan jika `evaluation.isAttack` bernilai `true` **dan**
`evaluation.score >= global.score_threshold` (default 50). Jika tidak, request diteruskan ke origin
tanpa menyentuh KV.

### 5. Circuit breaker

Untuk kandidat serangan, Worker membaca counter KV `strike:<ip>`. Jika sudah mencapai ambang,
response `403` statis dikirim tanpa delay, watermark, atau payload. Detail ada di
[Circuit Breaker](/konsep/circuit-breaker/).

### 6–10. Deception dan observability

- `recordStrike()` menambah counter KV dengan TTL 60 detik.
- Delay acak diambil dari `fake_payload.delay_ms` vector yang terdeteksi.
- `resolveSalt()` mengambil salt dari KV, lalu environment, lalu default dev.
- `generateWatermark()` menghitung SHA-256 dari IP + User-Agent + tanggal UTC + salt.
- Event dikirim lewat `ctx.waitUntil(logEventBestEffort(...))` agar tidak menahan response.
- Body response memakai template teks dengan roast acak dan fake payload JSON.

## Prinsip fail-open dan fail-closed

| Lapisan | Prinsip | Konsekuensi |
| --- | --- | --- |
| Runtime Worker | **Fail-open** | Error apa pun → `console.error` → `passthroughSafe()` |
| Circuit breaker | **Fail-open** | KV error dianggap tidak diblokir |
| Logger | **Best-effort** | Kegagalan tulis tidak melempar error ke pemanggil |
| Build pipeline | **Fail-closed** | Rules tidak valid → artefak tidak ditulis → deploy berhenti |

Fail-open berarti kegagalan alat keamanan tidak boleh menghentikan situs asli. Fail-closed pada
build berarti aturan yang rusak tidak boleh sampai ke edge.

## Biaya dan latency

- Scoring berjalan sepenuhnya di memori setelah regex dikompilasi saat cold start.
- Request normal tidak melakukan panggilan KV sama sekali.
- Request serangan melakukan 2 operasi KV (baca + tulis strike) ditambah operasi baca salt.
- Delay honeypot sengaja ditambahkan; ini bukan overhead tak terduga, melainkan bagian dari
  strategi deception.

:::note[NFR belum diukur]
Target latency PRD (p95 ≤ 5 ms untuk trafik sah, ≤ 25 ms untuk scoring, CPU ≤ 5 ms) belum
diverifikasi dengan micro-benchmark. Verifikasi yang ada baru fungsional. Lihat
[Batas Kemampuan](/referensi/batas-kemampuan/).
:::

## Error handling

Blok `try/catch` utama membungkus seluruh alur. Jika terjadi error:

1. Error dicetak ke console dengan prefix `[BANGK-SHIELD ERROR]`.
2. Event `engine_error` dicoba dikirim ke Analytics Engine.
3. `passthroughSafe()` dipanggil; jika passthrough juga gagal, response `500` dikembalikan.

Loop-guard header `x-bangk-shield-forwarded` mencegah Worker memanggil dirinya sendiri saat
meneruskan request ke origin.

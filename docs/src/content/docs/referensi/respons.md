---
title: Format Respons
description: Header, status code, template body honeypot, dan response circuit breaker.
---

Bangk-Shield mengembalikan beberapa jenis response tergantung jalur yang dilalui request.

## Ringkasan

| Situasi | Status | Header penanda | Body |
| --- | ---: | --- | --- |
| Honeypot terpicu | `default_fake_status` (default 200) | `X-Bangk-Shield: honeypot-active` | Template teks + roast + fake payload |
| Circuit breaker | 403 | `X-Bangk-Shield: honeypot-active-cb` | `Blocked by Circuit Breaker` |
| Request normal | Sesuai origin | — | Diteruskan dari origin |
| Tanpa origin/asset | 200 | — | Teks placeholder |
| Forwarding loop | 508 | — | `Bangk-Shield: forwarding loop detected.` |
| Error + passthrough gagal | 500 | — | `Internal Server Error` |

## Response honeypot

### Header

```http
Content-Type: text/plain; charset=utf-8
X-Bangk-Shield: honeypot-active
X-Bangk-Shield-Watermark: bs1-0123456789abcdef
```

- `X-Bangk-Shield` memberi tahu bahwa response ini berasal dari honeypot.
- `X-Bangk-Shield-Watermark` berisi hash 16 karakter hex dengan prefix `bs1-`.

Tidak ada header `Cache-Control`, `CSP`, atau `CORS` yang diset secara eksplisit. Jika response
ini bisa di-cache oleh CDN atau browser, tambahkan header yang sesuai.

### Body

Template ada di `formatHoneypotResponse()`:

```text
============================================================
[BANGK-SHIELD VIRTUAL LAB - SECURITY SYSTEM]
============================================================
Target URL   : <url>
Client IP    : <ip>
Attack Vector: <vector>
Threat Score : <score>
User-Agent   : <ua>
Watermark    : <watermark>
------------------------------------------------------------
<roast>

[SIMULATED SERVER RESPONSE]:
<fake payload JSON>
============================================================
```

Nilai yang di-echo:

| Field | Sumber | Sanitasi |
| --- | --- | --- |
| Target URL | `request.url` | Karakter kontrol dibuang, maks. 500 karakter |
| Client IP | `cf-connecting-ip` | Tidak disanitasi |
| Attack Vector | `evaluation.attackType` | — |
| Threat Score | `evaluation.score` | — |
| User-Agent | Header `User-Agent` | Karakter kontrol dibuang, maks. 500 karakter |
| Watermark | `generateWatermark()` | — |
| Roast | Item acak dari `vector.roast` | — |
| Fake payload | `JSON.stringify(..., null, 2)` | — |

`sanitizeForEcho()` membuang karakter `\x00`–`\x1F` dan `\x7F` (termasuk CR/LF), memangkas
spasi di ujung, lalu menambahkan `...[truncated]` jika melebihi batas.

### Contoh lengkap

```http
HTTP/1.1 200 OK
Content-Type: text/plain; charset=utf-8
X-Bangk-Shield: honeypot-active
X-Bangk-Shield-Watermark: bs1-9f2c41ab77d0e315

============================================================
[BANGK-SHIELD VIRTUAL LAB - SECURITY SYSTEM]
============================================================
Target URL   : https://example.com/search?id=1%27%20union%20select%201--
Client IP    : 203.0.113.7
Attack Vector: sqli
Threat Score : 60
User-Agent   : sqlmap/1.7
Watermark    : bs1-9f2c41ab77d0e315
------------------------------------------------------------
Union select nyasar ke lapak yang salah, bang. Di sini nggak ada tabel users buat di-dump.

[SIMULATED SERVER RESPONSE]:
{
  "error": "MySQL 1064",
  "detail": "syntax error near 'FROM users'",
  "rows_returned": 0
}
============================================================
```

## Response circuit breaker

```http
HTTP/1.1 403 Forbidden
X-Bangk-Shield: honeypot-active-cb
Content-Type: text/plain; charset=utf-8

Blocked by Circuit Breaker
```

Response ini tidak menyertakan watermark, roast, atau fake payload.

## Response passthrough

`passthrough()` memilih tujuan berdasarkan environment:

1. `env.ASSETS` → `env.ASSETS.fetch(request)`.
2. `env.ORIGIN_URL` → request dibangun ulang ke host origin, ditambah header
   `x-bangk-shield-forwarded: 1`.
3. Tidak ada keduanya → response placeholder 200.

Placeholder:

```text
Bangk-Shield aktif, tapi belum ada ORIGIN_URL atau ASSETS binding yang dikonfigurasi
untuk meneruskan trafik legit ini. Isi env var ORIGIN_URL di wrangler.toml.
```

## Response error

Jika terjadi exception di alur utama:

1. `console.error('[BANGK-SHIELD ERROR] Failing open:', error)`.
2. Event `engine_error` dikirim best-effort.
3. `passthroughSafe()` mencoba meneruskan request.
4. Jika passthrough juga gagal, `500 Internal Server Error`.

## Status code palsu

`default_fake_status` per vector dapat diubah di `config/rules.json`. Semua vector saat ini
memakai `200` agar scanner menganggap request berhasil. Jika Anda ingin variasi yang lebih
realistis, misalnya `500` untuk error database palsu atau `404` untuk recon, ubah nilai tersebut
per vector.

:::caution[Jangan memakai status 5xx untuk semua vektor]
Scanner sering memperlakukan 5xx sebagai error infrastruktur dan mungkin berhenti. Status 200
dengan body yang tampak valid biasanya lebih efektif untuk deception.
:::

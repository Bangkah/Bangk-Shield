---
title: Mulai Cepat
description: Jalankan Bangk-Shield secara lokal dan uji deteksi dengan beberapa perintah curl.
---

Panduan ini mengasumsikan Anda sudah menyelesaikan [Instalasi](/mulai/instalasi/).

## Jalankan dev server

```bash
npm run dev
```

`predev` otomatis menjalankan `npm run build:rules` lebih dulu, sehingga artefak
`src/rules.compiled.json` selalu sinkron dengan `config/rules.json`.

Wrangler akan menampilkan URL lokal, biasanya `http://localhost:8787`.

:::note[Passthrough lokal]
Di dev server, `env.ASSETS` tidak tersedia dan `ORIGIN_URL` default-nya kosong. Request yang
bukan serangan akan dibalas teks placeholder `Bangk-Shield aktif, tapi belum ada ORIGIN_URL…`
dengan status 200. Isi `ORIGIN_URL` di `wrangler.toml` jika ingin meneruskan ke origin nyata.
:::

## Uji dengan curl

### LFI di path — harus kena honeypot

```bash
curl -i "http://localhost:8787/etc/passwd"
```

Skor: `lfi:0` = 50, sama dengan threshold default 50. Response berisi header
`X-Bangk-Shield: honeypot-active` dan `X-Bangk-Shield-Watermark: bs1-…`.

### Recon sendirian — harus lolos

```bash
curl -i "http://localhost:8787/.env"
```

Skor: `recon:0` = 25, di bawah threshold. Request diteruskan (atau placeholder muncul).

### Recon combo — harus kena honeypot

```bash
curl -i "http://localhost:8787/.env/wp-admin"
```

Skor: `recon:0` (25) + `recon:2` (20) + combo bonus (20) = **65**.

### SQLi di query, URL-encoded

```bash
curl -i "http://localhost:8787/search?id=1%27%20union%20select%201--"
```

Query di-decode sebelum dicocokkan, sehingga `union select` terdeteksi.
Skor: `sqli:0` = 60.

### Trafik biasa — harus lolos

```bash
curl -i "http://localhost:8787/"
```

Tidak ada sinyal yang cocok, jadi request diteruskan normal.

## Ringkasan ekspektasi

| Request | Skor | Hasil |
| --- | ---: | --- |
| `/etc/passwd` | 50 | Honeypot LFI |
| `/.env` | 25 | Lolos |
| `/.env/wp-admin` | 65 | Honeypot recon |
| `/search?id=1' union select 1--` | 60 | Honeypot SQLi |
| `/` | 0 | Lolos |

Pembahasan lengkap setiap skenario, termasuk XSS dan circuit breaker, ada di
[Skenario Pengujian](/pengembangan/skenario-pengujian/).

## Inspeksi response

```bash
curl -i "http://localhost:8787/etc/passwd"
```

Yang perlu diperiksa:

- Status code — default `200` (nilai `default_fake_status` per vektor).
- Header `X-Bangk-Shield` — `honeypot-active` untuk honeypot, `honeypot-active-cb` untuk blokir circuit breaker.
- Header `X-Bangk-Shield-Watermark` — hash `bs1-` diikuti 16 karakter hex.
- Body — template teks berisi URL, IP, vektor, skor, User-Agent, roast, dan fake payload JSON.

Contoh body:

```text
============================================================
[BANGK-SHIELD VIRTUAL LAB - SECURITY SYSTEM]
============================================================
Target URL   : http://localhost:8787/etc/passwd
Client IP    : Unknown IP
Attack Vector: lfi
Threat Score : 50
User-Agent   : curl/8.x
Watermark    : bs1-0123456789abcdef
------------------------------------------------------------
etc/passwd yang dicari cuma ada di komputer situ, bang.

[SIMULATED SERVER RESPONSE]:
{
  "error": "fopen_failed",
  "reason": "path traversal outside webroot"
}
============================================================
```

:::tip[Lihat log Worker]
Jalankan `npm run tail` di terminal terpisah untuk memantau log Wrangler secara real-time.
Ingat bahwa event serangan hanya tersimpan jika binding `BANGK_ANALYTICS` tersedia.
:::

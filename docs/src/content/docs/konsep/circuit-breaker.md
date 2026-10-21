---
title: Circuit Breaker
description: Membatasi IP yang memicu honeypot berulang, cara kerja counter KV, dan risikonya.
---

Circuit breaker melindungi kuota CPU Worker dari scanner agresif yang memicu honeypot
berkali-kali. Setelah ambang tertentu, IP tersebut menerima response `403` statis yang murah,
tanpa delay, watermark, atau komputasi payload.

Implementasinya ada di `src/ratelimit.js` dan memakai Workers KV.

## Konstanta

| Konstanta | Nilai | Arti |
| --- | ---: | --- |
| `STRIKE_TTL_SECONDS` | 60 | TTL counter di KV |
| `STRIKE_THRESHOLD` | 5 | Jumlah strike sebelum diblokir |

## Kapan dicek

Circuit breaker **hanya** dicek setelah request melewati scoring dan dianggap sebagai kandidat
serangan. Request normal tidak melakukan panggilan KV sama sekali.

Urutannya:

1. Scoring selesai dan `score >= threshold`.
2. Cek `strike:<ip>` di KV.
3. Jika `>= 5`, kirim `403` dan catat event `circuit_breaker_block`.
4. Jika belum, lanjut ke honeypot dan `recordStrike()` menambah counter.

## Perhitungan strike

```js
const strikes = await kv.get(`strike:${ip}`);
return { isBlocked: Boolean(strikes) && parseInt(strikes, 10) >= STRIKE_THRESHOLD };
```

```js
const current = currentRaw ? parseInt(currentRaw, 10) : 0;
await kv.put(key, String(current + 1), { expirationTtl: STRIKE_TTL_SECONDS });
```

Karena pengecekan dilakukan **sebelum** penambahan, blokir mulai berlaku pada trigger **keenam**:

| Trigger ke- | Counter sebelum cek | Hasil | Counter setelah |
| ---: | ---: | --- | ---: |
| 1 | 0 | Honeypot | 1 |
| 2 | 1 | Honeypot | 2 |
| 3 | 2 | Honeypot | 3 |
| 4 | 3 | Honeypot | 4 |
| 5 | 4 | Honeypot | 5 |
| 6 | 5 | **403** | 5 (tidak bertambah) |
| 7+ | 5 | **403** | 5 |

:::note[TTL diperbarui setiap strike]
`recordStrike()` menulis ulang key dengan `expirationTtl: 60` setiap kali. Window-nya bukan
fixed window 60 detik, melainkan “5 strike tanpa jeda 60 detik”. Jika serangan berhenti,
counter hilang setelah 60 detik sejak strike terakhir.
:::

## Response blokir

```http
HTTP/1.1 403 Forbidden
X-Bangk-Shield: honeypot-active-cb
Content-Type: text/plain; charset=utf-8

Blocked by Circuit Breaker
```

Response ini sengaja sesederhana mungkin agar tidak membebani CPU.

## Konfigurasi

Circuit breaker aktif secara default. Untuk menonaktifkannya:

```toml
[vars]
CIRCUIT_BREAKER_ENABLED = "false"
```

Di `src/index.js`, nilai apa pun selain string `"false"` dianggap aktif:

```js
const circuitBreakerEnabled = env.CIRCUIT_BREAKER_ENABLED !== 'false';
```

:::caution[Risiko shared IP]
Circuit breaker bekerja per IP publik. Jika situs Anda diakses lewat NAT kantor, warnet, atau
CGNAT ISP, satu pengguna yang memicu lima false positive bisa membuat semua pengguna lain di
belakang IP yang sama ikut terblokir.

Pertimbangkan untuk:

- Menonaktifkan circuit breaker (`CIRCUIT_BREAKER_ENABLED = "false"`).
- Menaikkan `STRIKE_THRESHOLD` di `src/ratelimit.js`.
- Memperpendek `STRIKE_TTL_SECONDS`.
- Menambahkan pengecualian IP tepercaya lewat `whitelist.ips`.
:::

## Fail-open

Jika KV tidak tersedia atau terjadi error:

- `checkCircuitBreaker()` mengembalikan `{ isBlocked: false }`.
- `recordStrike()` menelan error tanpa melempar.

Artinya kegagalan KV tidak pernah memblokir trafik. Konsekuensinya, saat KV bermasalah,
perlindungan circuit breaker juga tidak aktif.

## Keterbatasan

- **Bukan atomic.** `get` lalu `put` bukan operasi atomik. Di bawah burst concurrent yang sangat
  tinggi, beberapa request bisa membaca nilai yang sama dan hitungan strike meleset.
- **Bukan rate limiter presisi.** Tujuannya anti-abuse ringan, bukan pembatasan request per detik.
- **Hanya satu level.** PRD mendefinisikan level kedua berupa blokir known-attacker selama 24 jam;
  itu belum diimplementasikan.
- **Counter per IP, bukan per kombinasi IP + vektor.** Semua vektor berbagi counter yang sama.
- **`cf-connecting-ip` bisa absen** di lingkungan non-Cloudflare. Saat itu semua klien memakai
  kunci `strike:Unknown IP` dan saling memengaruhi.

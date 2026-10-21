---
title: Logging
description: Event yang dikirim ke Workers Analytics Engine, skema data, dan sampling.
---

Bangk-Shield mencatat event ke **Workers Analytics Engine** secara best-effort. Penulisan
dilakukan lewat `ctx.waitUntil()`, sehingga kegagalan logging tidak menahan atau menggagalkan
response ke klien.

## Binding

```toml
[[analytics_engine_datasets]]
binding = "BANGK_ANALYTICS"
dataset = "bangk_shield_events"
```

Jika binding tidak ada, `logEventBestEffort()` langsung return. **Tidak ada fallback ke
`console.log` atau penyimpanan lain.** Tanpa binding ini, tidak ada event yang tersimpan.

## Event yang dikirim

| Event (`vector`) | Kapan | `score` |
| --- | --- | ---: |
| `sqli`, `rce`, `ssrf`, `lfi`, `xss`, `recon` | Honeypot terpicu | Skor aktual |
| `circuit_breaker_block` | IP diblokir circuit breaker | 0 |
| `salt_fallback` | Salt tidak berasal dari KV | 0 |
| `engine_error` | Exception di alur utama | Tidak diisi |

## Skema data point

```js
env.BANGK_ANALYTICS.writeDataPoint({
  blobs: [event.ip || '', event.path || '', event.vector || '', String(Boolean(dropped))],
  doubles: [typeof event.score === 'number' ? event.score : 0],
  indexes: [event.vector || 'unknown'],
});
```

| Field | Isi |
| --- | --- |
| `blob1` | IP klien |
| `blob2` | Path request |
| `blob3` | Vektor / jenis event |
| `blob4` | Flag `dropped` |
| `double1` | Skor |
| `index1` | Vektor (dipakai sebagai index) |

:::note[`blob4` selalu `"false"`]
Event yang di-drop karena sampling sudah `return` lebih awal, sehingga saat `writeDataPoint()`
dipanggil nilainya selalu `String(false)`. Field ini belum mencerminkan sampling yang sebenarnya.
:::

## Sampling

```js
const SAMPLING_SCORE_THRESHOLD = 30;
const SAMPLING_RATE = 0.2;
```

Aturannya:

- Event dengan `score < 30` hanya ditulis dengan probabilitas 20%.
- Event dengan `score >= 30` selalu ditulis.
- Event tanpa `score` (misalnya `engine_error`) selalu ditulis.

Karena threshold deteksi default adalah 50, serangan yang benar-benar memicu honeypot selalu
tercatat. Yang ter-sampling adalah event ber skor rendah.

:::caution[Event circuit breaker dan salt fallback ikut ter-sampling]
Keduanya dikirim dengan `score: 0`, sehingga termasuk kategori skor rendah dan sekitar 80%
diantaranya tidak tercatat. Jika Anda mengandalkan kedua event ini untuk audit, turunkan
`SAMPLING_SCORE_THRESHOLD` atau kirim skor yang lebih tinggi.
:::

## Query contoh

```sql
SELECT
  blob3 AS vector,
  count() AS events,
  avg(double1) AS avg_score
FROM bangk_shield_events
WHERE timestamp > NOW() - INTERVAL '24' HOUR
GROUP BY vector
ORDER BY events DESC
```

Top path yang paling sering diserang:

```sql
SELECT blob2 AS path, count() AS hits
FROM bangk_shield_events
WHERE timestamp > NOW() - INTERVAL '24' HOUR
GROUP BY path
ORDER BY hits DESC
LIMIT 20
```

Top IP:

```sql
SELECT blob1 AS ip, count() AS hits
FROM bangk_shield_events
WHERE timestamp > NOW() - INTERVAL '24' HOUR
GROUP BY ip
ORDER BY hits DESC
LIMIT 20
```

## Best-effort dan kuota

`writeDataPoint()` bersifat fire-and-forget. Jika kuota harian habis atau terjadi insiden,
error ditangkap dan dicetak ke console, tetapi tidak dilempar ke pemanggil.

```js
try {
  env.BANGK_ANALYTICS.writeDataPoint({ /* ... */ });
} catch (err) {
  console.error('[BANGK-SHIELD LOGGER] Analytics write failed:', err);
}
```

PRD menyebut adanya counter in-memory untuk metrik dropped events. Counter itu belum
diimplementasikan.

## Melihat log mentah

```bash
npm run tail
```

Perintah ini menampilkan `console.log`, `console.error`, dan error runtime dari Worker.

:::tip[Membedakan sampling dan error]
Event yang tidak muncul di Analytics Engine belum tentu gagal dikirim; bisa jadi ia ter-sampling.
Untuk memastikan, bandingkan dengan respons yang diterima klien dan dengan output `wrangler tail`.
:::

---
title: Konfigurasi wrangler.toml
description: Routing, binding KV, Analytics Engine, dan environment variable untuk Worker.
---

`wrangler.toml` mengatur cara Worker di-deploy dan sumber daya Cloudflare yang dipakai.

## Konfigurasi dasar

```toml
name = "bangk-shield"
main = "src/index.js"
compatibility_date = "2026-01-01"
```

| Field | Fungsi |
| --- | --- |
| `name` | Nama Worker di dashboard Cloudflare |
| `main` | Entry point Worker; mengarah ke `src/index.js` |
| `compatibility_date` | Tanggal kompatibilitas runtime Workers |

## Routing

### Opsi A — di depan zona Cloudflare

```toml
routes = [
  { pattern = "yourdomain.com/*", zone_name = "yourdomain.com" }
]
```

Semua request ke domain tersebut melewati Worker sebelum mencapai origin. Contoh konkret
untuk situs di Cloudflare Pages ada di
[Integrasi dengan Cloudflare Pages](/mulai/integrasi-cloudflare-pages/).

### Opsi B — subdomain workers.dev

Biarkan `routes` kosong. Setelah deploy, Worker tersedia di
`https://bangk-shield.<subdomain>.workers.dev`.

:::note[Contoh deployment proyek ini]
Worker dipasang di `bangk-shield.bangkah.tech/*` dengan
`ORIGIN_URL = "https://bangk-shield-docs.pages.dev"`. Hostname publik dipegang Worker,
sedangkan project Pages `bangk-shield-docs` hanya menjadi origin. Jangan memakai
`bangkah.tech/*` atau `*.bangkah.tech/*`. Lihat
[Deploy di Subdomain bangkah.tech](/mulai/integrasi-cloudflare-pages/).
:::

## Aset statis

Jika Worker juga menyajikan aset statis:

```toml
[assets]
directory = "./public"
binding = "ASSETS"
```

`passthrough()` memprioritaskan `env.ASSETS` jika tersedia. Jika tidak, ia memakai `ORIGIN_URL`.

:::caution[Jangan aktifkan keduanya tanpa alasan]
Jika `[assets]` aktif, trafik legit akan dilayani dari aset, bukan dari origin. Pilih salah satu
model: **Worker sebagai penjaga di depan origin** (`ORIGIN_URL`) atau **Worker yang juga
menyajikan situs** (`ASSETS`).
:::

## Workers KV

```toml
[[kv_namespaces]]
binding = "BANGK_KV"
id = "09533093da544735b0efb0a9f8e47f81"
```

Dipakai untuk:

- `strike:<ip>` — counter circuit breaker.
- `wm:salt:current` — salt watermark aktif.
- `wm:salt:history` — riwayat salt.

Buat namespace baru dengan:

```bash
npm run kv:create
```

:::note[ID namespace bukan secret]
ID namespace KV bukan kredensial rahasia, tetapi sebaiknya tetap tidak di-hardcode jika
repository bersifat publik. Ganti dengan nilai milik Anda setelah `kv:create`.
:::

## Analytics Engine

```toml
[[analytics_engine_datasets]]
binding = "BANGK_ANALYTICS"
dataset = "bangk_shield_events"
```

Tanpa binding ini, logging tidak berfungsi sama sekali. Lihat [Logging](/konsep/logging/).

## Environment variable

```toml
[vars]
ORIGIN_URL = "https://origin-anda.example.com"
WATERMARK_SALT = "dev-only-change-me"
CIRCUIT_BREAKER_ENABLED = "true"
```

| Variabel | Default di repo | Fungsi |
| --- | --- | --- |
| `ORIGIN_URL` | `""` | URL origin untuk `passthrough()`. Wajib untuk produksi jika tidak memakai `ASSETS`. |
| `WATERMARK_SALT` | `"dev-only-change-me"` | Fallback salt jika KV tidak tersedia. |
| `CIRCUIT_BREAKER_ENABLED` | `"true"` | `"false"` menonaktifkan circuit breaker. |
| `ADMIN_PATH` | dikomentari | Placeholder dashboard; belum diimplementasikan. |

:::danger[Jangan pakai `WATERMARK_SALT` sebagai salt produksi]
Salt produksi harus berada di KV agar bisa dirotasi tanpa redeploy. Setiap kali fallback
digunakan, engine mencatat event `salt_fallback`.
:::

## Variabel rahasia

Untuk nilai sensitif, gunakan secret Wrangler, bukan `[vars]`:

```bash
npx wrangler secret put NAMA_SECRET
```

Saat ini engine tidak membutuhkan secret wajib di luar konfigurasi di atas.

## Contoh lengkap

```toml
name = "bangk-shield"
main = "src/index.js"
compatibility_date = "2026-01-01"

routes = [
  { pattern = "example.com/*", zone_name = "example.com" }
]

[[kv_namespaces]]
binding = "BANGK_KV"
id = "id-namespace-anda"

[[analytics_engine_datasets]]
binding = "BANGK_ANALYTICS"
dataset = "bangk_shield_events"

[vars]
ORIGIN_URL = "https://origin.example.com"
WATERMARK_SALT = "dev-only-change-me"
CIRCUIT_BREAKER_ENABLED = "true"
```

## Perintah operasional

| Perintah | Fungsi |
| --- | --- |
| `npm run dev` | Jalankan Worker lokal dengan rules terbaru |
| `npm run deploy` | Build rules lalu deploy |
| `npm run tail` | Stream log Worker |
| `npm run kv:create` | Buat namespace KV |
| `npm run salt:rotate` | **Gagal** — skrip belum ada |

## Kompatibilitas versi

| Komponen | Versi di repo |
| --- | --- |
| Wrangler | `^3.90.0` (terpasang 3.114.17 saat dokumentasi ini dibuat) |
| `@cloudflare/workers-types` | `^4.20260702.1` |
| Node.js | `>=18` |

Wrangler 4 juga dapat dipakai, tetapi sintaks perintah KV sedikit berbeda
(`wrangler kv key get` vs `wrangler kv:key get`).

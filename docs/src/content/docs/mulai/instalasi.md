---
title: Instalasi
description: Prasyarat, clone, dependensi, binding KV, dan variabel environment untuk Bangk-Shield.
---

## Prasyarat

| Kebutuhan | Versi / catatan |
| --- | --- |
| Node.js | `>=18` untuk Worker (lihat `engines` di `package.json`) |
| npm | Disertakan bersama Node.js |
| Akun Cloudflare | Tier gratis cukup untuk KV dan Analytics Engine dasar |
| Wrangler | Terpasang sebagai devDependency proyek |

:::note[Untuk situs dokumentasi ini]
Situs dokumentasi memakai Astro + Starlight dan membutuhkan **Node.js >= 22.22.0**.
Itu terpisah dari kebutuhan runtime Worker.
:::

## 1. Clone dan install

```bash
git clone https://github.com/Bangkah/Bangk-Shield.git
cd Bangk-Shield
npm install
```

## 2. Login ke Cloudflare

```bash
npx wrangler login
```

Perintah ini membuka browser untuk otorisasi akun Cloudflare yang akan dipakai deploy.

## 3. Buat namespace KV

KV dipakai untuk dua hal:

- **Circuit breaker** — key `strike:<ip>`.
- **Salt watermark** — key `wm:salt:current` dan `wm:salt:history`.

```bash
npm run kv:create
```

Salin nilai `id` dari output perintah tersebut ke `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "BANGK_KV"
id = "id-namespace-anda"
```

:::caution[Tanpa KV]
Kedua fitur di atas akan fail-open: circuit breaker tidak memblokir apa pun dan salt jatuh
ke fallback environment variable. Aplikasi tetap berjalan, tetapi tidak disarankan untuk
deploy produksi.
:::

## 4. Siapkan Analytics Engine

Aktifkan Analytics Engine di dashboard Cloudflare, lalu pastikan binding berikut ada di
`wrangler.toml`:

```toml
[[analytics_engine_datasets]]
binding = "BANGK_ANALYTICS"
dataset = "bangk_shield_events"
```

Tanpa binding ini, `src/logger.js` langsung return dan **tidak ada event yang tersimpan**.
Tidak ada fallback ke `console.log`.

## 5. Isi environment variable

Minimal isi `ORIGIN_URL` dengan alamat origin asli yang akan dilindungi:

```toml
[vars]
ORIGIN_URL = "https://origin-anda.example.com"
WATERMARK_SALT = "dev-only-change-me"
CIRCUIT_BREAKER_ENABLED = "true"
```

| Variabel | Wajib | Default | Fungsi |
| --- | --- | --- | --- |
| `ORIGIN_URL` | Untuk produksi | `""` | Tujuan `passthrough()` untuk trafik sah. |
| `WATERMARK_SALT` | Tidak | `""` | Fallback salt jika KV tidak tersedia. Jangan diandalkan di produksi. |
| `CIRCUIT_BREAKER_ENABLED` | Tidak | `"true"` | Set `"false"` untuk menonaktifkan circuit breaker. |

Penjelasan lengkap ada di [Konfigurasi wrangler.toml](/konfigurasi/wrangler/).

## 6. Build rules

`src/index.js` membaca artefak `src/rules.compiled.json`, bukan `config/rules.json` langsung.
Artefak ini dihasilkan oleh:

```bash
npm run build:rules
```

Perintah ini otomatis dipanggil lewat `predev`, `prebuild`, dan `predeploy`, sehingga Anda
biasanya tidak perlu menjalankannya manual. Detail tahapannya ada di
[Build Pipeline](/konfigurasi/build-pipeline/).

## 7. Verifikasi hasil instalasi

```bash
npm run dev
```

Dev server Wrangler biasanya berjalan di `http://localhost:8787`. Panduan uji coba ada di
[Mulai Cepat](/mulai/mulai-cepat/).

:::danger[Skrip rotasi salt belum tersedia]
`package.json` mendefinisikan `npm run salt:rotate` yang mengarah ke `scripts/rotate-salt.cjs`,
tetapi file tersebut **tidak ada di repository**. Menjalankan perintah itu akan gagal.
Sementara ini, isi key `wm:salt:current` secara manual lewat Wrangler KV CLI, atau tambahkan
skripnya sendiri. Lihat [Watermark](/konsep/watermark/#rotasi-salt).
:::

---
title: Deploy
description: Deploy Worker Bangk-Shield dan situs dokumentasi ke Cloudflare Pages dengan subdomain sendiri.
---

Ada dua hal yang di-deploy secara terpisah:

1. **Worker Bangk-Shield** — engine honeypot itu sendiri.
2. **Situs dokumentasi ini** — Astro Starlight statis di subdomain `bangk-shield.bangkah.tech`.

Keduanya bisa berada di satu repository, tetapi merupakan dua project Cloudflare yang berbeda.

## Deploy Worker

### 1. Siapkan konfigurasi

Pastikan `wrangler.toml` sudah berisi:

- `id` namespace KV dari `npm run kv:create`.
- Binding `BANGK_ANALYTICS`.
- `ORIGIN_URL` yang menunjuk origin asli, atau binding `[assets]` jika Worker juga menyajikan aset statis.

### 2. Pilih cara routing

**Opsi A — di depan zona Cloudflare Anda:**

```toml
routes = [
  { pattern = "yourdomain.com/*", zone_name = "yourdomain.com" }
]
```

**Opsi B — subdomain `workers.dev` untuk pengujian:**

Biarkan `routes` kosong. Cloudflare akan memberikan URL `bangk-shield.<subdomain>.workers.dev`.

Contoh lengkap Worker di depan situs Cloudflare Pages, termasuk migrasi nameserver dan
pengaturan DNS, ada di [Integrasi dengan Cloudflare Pages](/mulai/integrasi-cloudflare-pages/).

### 3. Deploy

```bash
npm run deploy
```

`predeploy` otomatis menjalankan `npm run build:rules`, jadi artefak rule selalu diperbarui.
Jika build rules gagal, deploy dibatalkan.

### 4. Pantau log

```bash
npm run tail
```

Gunakan ini untuk melihat error runtime dan kegagalan penulisan Analytics Engine.

:::caution[Rotasi salt]
`npm run salt:rotate` saat ini gagal karena `scripts/rotate-salt.cjs` tidak ada di repository.
Lihat [Watermark § Rotasi salt](/konsep/watermark/#rotasi-salt) untuk cara manual sementara.
:::

## Deploy situs dokumentasi

Dokumentasi berada di folder `docs/` dan di-deploy sebagai **Cloudflare Pages project**
terpisah dengan nama `bangk-shield-docs`.

### Struktur yang dipakai

```text
Bangk-Shield/
├── docs/
│   ├── astro.config.mjs
│   ├── package.json
│   ├── public/
│   └── src/
│       ├── assets/
│       ├── content/docs/
│       └── styles/
└── .github/workflows/deploy-docs.yml
```

### 1. Buat project Pages

Sekali saja, dari root repository:

```bash
npx wrangler pages project create bangk-shield-docs --production-branch main
```

### 2. Deploy manual (opsional)

```bash
npm run docs:build
npx wrangler pages deploy docs/dist --project-name bangk-shield-docs --branch main
```

Atau langsung:

```bash
npm run docs:deploy
```

### 3. Deploy otomatis lewat GitHub Actions

Workflow `.github/workflows/deploy-docs.yml` berjalan setiap ada perubahan di `docs/`
atau pada file workflow itu sendiri. Pull request ke `main` hanya membangun dokumentasi;
deploy produksi dijalankan setelah perubahan masuk ke `main`.

Tambahkan dua repository secret berikut di repository Bangk-Shield:

| Secret | Isi |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Token dengan permission **Account > Cloudflare Pages > Edit** |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID dari dashboard Cloudflare |

Jika salah satu secret belum diisi, workflow tetap menyelesaikan build dan melewati deploy
dengan peringatan. Setelah secret tersedia, push berikutnya ke `main` akan otomatis
membangun dan men-deploy dokumentasi.

### 4. Pasang subdomain lewat Worker

Dokumentasi dipublikasikan di `bangk-shield.bangkah.tech`, tetapi **hostname itu dipegang
Worker**, bukan custom domain Pages. Project Pages tetap di `bangk-shield-docs.pages.dev`
sebagai origin.

1. Pastikan origin sudah live:

   ```bash
   curl -I https://bangk-shield-docs.pages.dev/
   ```

2. Di **DNS → Records**, tambahkan:

   | Tipe | Nama | Target | Proxy |
   | --- | --- | --- | --- |
   | CNAME | `bangk-shield` | `bangk-shield-docs.pages.dev` | Proxied |

3. Jangan menambahkan `bangk-shield.bangkah.tech` sebagai custom domain di project
   `bangk-shield-docs`. Satu hostname hanya boleh dimiliki satu layanan.
4. Isi `wrangler.toml`:

   ```toml
   routes = [
     { pattern = "bangk-shield.bangkah.tech/*", zone_name = "bangkah.tech" }
   ]

   [vars]
   ORIGIN_URL = "https://bangk-shield-docs.pages.dev"
   ```

5. Deploy Worker:

   ```bash
   npm run deploy
   ```

Jangan memakai route `bangkah.tech/*` atau `*.bangkah.tech/*`. Apex disiapkan untuk index
project lain, dan wildcard akan menangkap semua subdomain project. Panduan lengkap ada di
[Deploy di Subdomain bangkah.tech](/mulai/integrasi-cloudflare-pages/).

:::tip[HTTPS]
Cloudflare menerbitkan sertifikat universal untuk `bangkah.tech` dan subdomain tingkat
pertama seperti `bangk-shield.bangkah.tech`. Tidak perlu mengunggah sertifikat manual.
:::

### 5. Verifikasi

```bash
curl -I https://bangk-shield.bangkah.tech/
curl -i https://bangk-shield.bangkah.tech/etc/passwd
```

Pastikan halaman dokumentasi merespons `200` tanpa header honeypot, sedangkan path serangan
mendapat `X-Bangk-Shield: honeypot-active`. Jika masih `522` atau `404`, tunggu beberapa
menit sampai propagasi DNS dan deployment selesai.

## Variabel build dokumentasi

| Item | Nilai |
| --- | --- |
| Root directory | `docs` |
| Build command | `npm ci && npm run build` |
| Output directory | `dist` |
| Node.js | `22` atau lebih baru |

Nilai `site` di `docs/astro.config.mjs` sudah diarahkan ke
`https://bangk-shield.bangkah.tech`, sehingga canonical URL dan sitemap konsisten.

## Checklist setelah deploy

- [ ] Worker merespons request serangan dengan header `X-Bangk-Shield: honeypot-active`.
- [ ] Trafik normal sampai ke origin (bukan halaman placeholder).
- [ ] KV `strike:<ip>` terisi setelah beberapa trigger.
- [ ] Event muncul di dataset `bangk_shield_events`.
- [ ] `bangk-shield.bangkah.tech` dapat diakses dengan HTTPS.
- [ ] Workflow GitHub Actions hijau dan deployment baru muncul di tab Deployments.

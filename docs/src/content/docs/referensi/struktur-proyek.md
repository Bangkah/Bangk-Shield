---
title: Struktur Proyek
description: Peta direktori dan tanggung jawab setiap file di repository Bangk-Shield.
---

```text
Bangk-Shield/
├── README.md
├── PRD.md
├── package.json
├── tsconfig.json
├── wrangler.toml
├── .gitignore
│
├── config/
│   ├── rules.json              # Sumber kebenaran aturan deteksi
│   ├── rules.scema.json        # JSON Schema (nama file typo, belum dipakai)
│   └── whitelist.json          # Path/prefix/IP yang dilewatkan
│
├── scripts/
│   └── build-rules.cjs         # Validasi + kompilasi rules
│
├── src/
│   ├── index.js                # Entry point Worker
│   ├── rules.compiled.json     # Artefak build (jangan diedit)
│   ├── scanner.js              # Kompilasi regex + evaluasi skor
│   ├── ratelimit.js            # Circuit breaker berbasis KV
│   ├── watermark.js            # Derivasi hash + resolusi salt
│   ├── logger.js               # Logging Analytics Engine
│   └── utils.js                # Helper passthrough, decode, sanitasi
│
├── publish/
│   └── index.ts                # Entry point package npm
│
├── docs/                       # Situs dokumentasi (Astro Starlight)
│   ├── astro.config.mjs
│   ├── package.json
│   ├── tsconfig.json
│   ├── public/
│   │   └── favicon.svg
│   └── src/
│       ├── assets/logo.svg
│       ├── content.config.ts
│       ├── content/docs/       # Semua halaman dokumentasi
│       └── styles/custom.css
│
├── .github/
│   └── workflows/
│       └── deploy-docs.yml     # Deploy dokumentasi ke Cloudflare Pages
│
├── dist/                       # Output build npm package (ignored)
└── .wrangler/                  # State lokal Wrangler (ignored)
```

## Tanggung jawab file

### Root

| File | Fungsi |
| --- | --- |
| `README.md` | Dokumentasi utama proyek dan changelog |
| `PRD.md` | Product Requirements Document versi Beta |
| `package.json` | Script Worker, package npm, dan dependency |
| `wrangler.toml` | Konfigurasi deploy Worker dan binding Cloudflare |
| `tsconfig.json` | Konfigurasi TypeScript untuk `publish/` dan `src/` |

### `config/`

| File | Fungsi |
| --- | --- |
| `rules.json` | Threshold, sinyal, skor, combo bonus, roast, fake payload |
| `rules.scema.json` | Skema JSON untuk validasi (belum dibaca oleh build) |
| `whitelist.json` | Exact path, prefix, dan IP yang dilewatkan |

:::note[Typo nama schema]
Nama file yang ada adalah `rules.scema.json`, bukan `rules.schema.json` seperti yang disebut
README. Build pipeline belum membacanya, jadi typo ini belum berdampak fungsional.
:::

### `scripts/`

| File | Fungsi |
| --- | --- |
| `build-rules.cjs` | Membaca, memvalidasi, dan mengompilasi rules ke `src/rules.compiled.json` |

:::danger[`rotate-salt.cjs` tidak ada]
`package.json` mendefinisikan `salt:rotate` yang menunjuk ke `scripts/rotate-salt.cjs`,
tetapi file tersebut tidak ada di repository. Perintah `npm run salt:rotate` akan gagal.
:::

### `src/`

| File | Fungsi |
| --- | --- |
| `index.js` | Orkestrasi request: whitelist, scoring, circuit breaker, response |
| `scanner.js` | `compileRules()` dan `evaluateThreat()` |
| `ratelimit.js` | `checkCircuitBreaker()` dan `recordStrike()` |
| `watermark.js` | `resolveSalt()`, `resolveSaltCandidates()`, `generateWatermark()` |
| `logger.js` | `logEventBestEffort()` dengan sampling |
| `utils.js` | Decode, whitelist, baca body, sanitasi, passthrough, template |
| `rules.compiled.json` | Artefak build; jangan diedit manual |

### `publish/`

| File | Fungsi |
| --- | --- |
| `index.ts` | Fungsi `bangkShield()` untuk konsumsi package npm |

### `docs/`

| File | Fungsi |
| --- | --- |
| `astro.config.mjs` | Konfigurasi Starlight, sidebar, dan URL situs |
| `src/content/docs/` | Konten dokumentasi berbahasa Indonesia |
| `src/styles/custom.css` | Tema warna dan penyesuaian tampilan |
| `public/favicon.svg` | Ikon situs |

## Mana yang di-track git?

`.gitignore` mengabaikan:

```text
node_modules/
.wrangler/
dist/
build/
.env
.dev.vars
.npmrc
```

`src/rules.compiled.json` **tidak** di-ignore, sehingga artefak build ikut ter-commit. Ini
memudahkan deploy yang tidak menjalankan `predeploy`, tetapi berarti artefak harus diperbarui
setiap kali `config/rules.json` berubah.

## Dua build yang berbeda

| Build | Perintah | Output | Dipakai untuk |
| --- | --- | --- | --- |
| Worker | `npm run deploy` | Tidak menghasilkan folder build; Wrangler membundel `src/index.js` | Honeypot |
| Package npm | `npm run build` | `dist/index.js`, `dist/index.d.ts` | Library |
| Dokumentasi | `npm run docs:build` | `docs/dist/` | Cloudflare Pages |

Jangan tertukar: `dist/` di root adalah output package, sedangkan `docs/dist/` adalah output
situs dokumentasi.

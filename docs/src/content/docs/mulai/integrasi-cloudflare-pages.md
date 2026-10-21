---
title: Deploy di Subdomain bangkah.tech
description: Menempatkan Bangk-Shield di bangk-shield.bangkah.tech dengan Worker di depan dokumentasi Cloudflare Pages.
---

`bangkah.tech` adalah domain induk untuk kumpulan project. Bangk-Shield tidak ditempatkan di
apex, melainkan di subdomain `bangk-shield.bangkah.tech`. Situs pribadi di
`mdhiyaulatha.tech` terpisah dan tidak disentuh oleh konfigurasi ini.

## Arsitektur yang dipakai

```text
bangk-shield.bangkah.tech
        │
        ▼
Cloudflare edge — zona bangkah.tech
        │
        ▼
Worker bangk-shield  (route bangk-shield.bangkah.tech/*)
        │
        ├─ trafik normal ──► https://bangk-shield-docs.pages.dev
        └─ serangan ──────► respons honeypot
```

| Bagian | Nilai |
| --- | --- |
| Hostname publik | `https://bangk-shield.bangkah.tech` |
| Worker route | `bangk-shield.bangkah.tech/*` |
| Origin Worker | `https://bangk-shield-docs.pages.dev` |
| Apex `bangkah.tech` | Dikosongkan untuk index project lain |

Worker memegang hostname publik. Project Pages `bangk-shield-docs` **tidak** memakai custom
domain; ia hanya menjadi origin yang di-fetch Worker. Ini menghindari konflik satu hostname
dipakai dua layanan.

## Prasyarat

- Zona `bangkah.tech` sudah **Active** di Cloudflare.
- Dokumentasi sudah di-deploy ke project Pages `bangk-shield-docs`.
- Worker `bangk-shield` sudah bisa di-deploy dari repository ini.
- Wrangler sudah login (`npx wrangler login`).

## 1. Tambahkan DNS untuk subdomain

Di **DNS → Records**, tambahkan satu record:

| Tipe | Nama | Target | Proxy |
| --- | --- | --- | --- |
| CNAME | `bangk-shield` | `bangk-shield-docs.pages.dev` | **Proxied** |

Record harus proxied (awan oranye). Record DNS-only tidak akan melewati Worker.

Alternatif yang sama sahnya: `AAAA` → Nama `bangk-shield` → Content `100::` → Proxied.
Target DNS tidak pernah dihubungi langsung selama route Worker aktif, karena Worker yang
mengambil origin dari `ORIGIN_URL`.

:::caution[Jangan buat record apex untuk Bangk-Shield]
Jangan tambahkan `bangkah.tech` atau `www.bangkah.tech` ke project ini. Apex disiapkan untuk
index project lain. Jangan juga memakai wildcard `*.bangkah.tech`.
:::

## 2. Pastikan dokumentasi live di Pages

Deploy dokumentasi lebih dulu dan cek origin-nya:

```bash
npm run docs:build
npx wrangler pages deploy docs/dist --project-name bangk-shield-docs --branch main
```

Atau lewat workflow `.github/workflows/deploy-docs.yml`. Verifikasi:

```bash
curl -I https://bangk-shield-docs.pages.dev/
```

Harus `200`. Origin ini akan menjadi tujuan `ORIGIN_URL`.

## 3. Konfigurasi Worker

Isi `wrangler.toml`:

```toml
routes = [
  { pattern = "bangk-shield.bangkah.tech/*", zone_name = "bangkah.tech" }
]

[vars]
ORIGIN_URL = "https://bangk-shield-docs.pages.dev"
```

`passthrough()` hanya mengambil scheme, hostname, dan port dari `ORIGIN_URL`
(`src/utils.js:114-119`). Path dan query tetap diambil dari request asli, jadi jangan
menambahkan path di nilai tersebut.

Untuk pengujian sebelum mengarahkan subdomain, biarkan `routes` dikomentari, deploy, lalu uji
di `https://bangk-shield.<subdomain>.workers.dev`. Setelah trafik normal dan honeypot bekerja,
aktifkan route dan deploy ulang:

```bash
npm run deploy
```

:::danger[Jangan menunjuk ORIGIN_URL ke hostname zona sendiri]
Jika `ORIGIN_URL` diisi `https://bangk-shield.bangkah.tech`, Worker akan memanggil dirinya
sendiri lewat route yang sama. Cloudflare melarang fetch ke hostname zona sendiri yang
dilayani Worker, dan `passthrough()` juga membalas `508` jika mendeteksi loop.
:::

## 4. Verifikasi

```bash
# Origin Pages langsung
curl -I https://bangk-shield-docs.pages.dev/

# Dokumentasi lewat Worker (trafik normal)
curl -I https://bangk-shield.bangkah.tech/
curl -I https://bangk-shield.bangkah.tech/mulai/pendahuluan/

# Harus honeypot, bukan 404 dokumentasi
curl -i https://bangk-shield.bangkah.tech/etc/passwd

# Recon combo, skor 65
curl -i https://bangk-shield.bangkah.tech/.env/wp-admin
```

Yang perlu terlihat pada request serangan:

- Header `X-Bangk-Shield: honeypot-active`.
- Header `X-Bangk-Shield-Watermark: bs1-...`.
- Body berisi roast dan fake payload.

Pada request dokumentasi normal, tidak boleh ada header `X-Bangk-Shield`, dan aset
`/_astro/*.css` serta `/_astro/*.js` harus termuat. Ekstensi statis selalu lolos pemeriksaan
([Known-asset check](/konsep/arsitektur/#1-known-asset-check)).

Jika circuit breaker aktif, pengujian berulang dari IP yang sama bisa berakhir dengan
`403 Blocked by Circuit Breaker`. Untuk pengujian awal, set
`CIRCUIT_BREAKER_ENABLED = "false"` lalu deploy ulang.

## Mengapa Pages tidak memakai custom domain?

Cloudflare tidak mendukung satu hostname dipakai sebagai custom domain Pages sekaligus route
Worker. Jika Worker sudah menempel di `bangk-shield.bangkah.tech`, penambahan custom domain
Pages untuk hostname yang sama akan ditolak. Pilih satu pemilik:

- **Worker memegang subdomain** — Pages tetap di `pages.dev` sebagai origin. Ini yang dipakai.
- **Pages memegang subdomain** — tidak ada Worker di depan dokumentasi.

Kalau ingin dokumentasi tanpa Worker, hapus route lalu pasang
`bangk-shield.bangkah.tech` sebagai custom domain project `bangk-shield-docs`.

## Apex dan project lain

`bangkah.tech` adalah wadah project, jadi jangan pasang route Bangk-Shield di apex:

- **Jangan** memakai `bangkah.tech/*` untuk Worker ini.
- **Jangan** memakai `*.bangkah.tech/*`; wildcard akan menangkap semua subdomain project,
  termasuk dokumentasi dan project berikutnya.
- Setiap project baru sebaiknya mendapat subdomain sendiri, misalnya
  `project-lain.bangkah.tech`, dengan route atau custom domain terpisah.
- Saat index project di apex siap, deploy sebagai project Cloudflare terpisah dan pasang
  `bangkah.tech` di sana. Jangan arahkan apex ke Worker Bangk-Shield.

## Batas yang perlu disadari

- **Bypass langsung ke `bangk-shield-docs.pages.dev`.** Worker bukan access control; siapa pun
  yang tahu origin bisa melewatinya. Untuk menutup bypass, gunakan Cloudflare Access atau
  header bersama yang divalidasi di sisi Pages.
- **Dokumentasi adalah situs statis.** Honeypot tetap bekerja untuk request mencurigakan,
  tetapi tidak ada aplikasi dinamis di belakangnya.
- **Aset statis tidak diperiksa.** Path berakhiran `.js`, `.css`, `.svg`, `.png`, `.ico`,
  `.jpg`, `.woff`, atau `.woff2` langsung diteruskan. Lihat
  [Batas Kemampuan](/referensi/batas-kemampuan/).
- **False positive tetap mungkin.** Uji halaman dokumentasi utama sebelum mengumumkan URL.

## Rollback

1. Hapus route `bangk-shield.bangkah.tech/*` dari `wrangler.toml`, lalu deploy.
2. Jika dokumentasi ingin tetap tampil, pasang `bangk-shield.bangkah.tech` sebagai custom
   domain project `bangk-shield-docs`.
3. Tunggu CNAME otomatis dan sertifikat TLS aktif.

## Troubleshooting

| Gejala | Kemungkinan penyebab |
| --- | --- |
| `wrangler deploy` gagal saat membuat route | Zona `bangkah.tech` belum Active |
| Subdomain tidak resolve | Record `bangk-shield` belum ada atau tidak proxied |
| Situs menampilkan halaman placeholder Bangk-Shield | `ORIGIN_URL` kosong atau salah |
| `522`/`523` | Origin `bangk-shield-docs.pages.dev` belum live |
| Honeypot tidak aktif | Route belum terpasang atau DNS record DNS-only |
| `508 forwarding loop detected` | `ORIGIN_URL` menunjuk hostname zona sendiri |
| Project lain ikut terkena honeypot | Ada route wildcard `*.bangkah.tech/*` |

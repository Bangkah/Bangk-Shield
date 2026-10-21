---
title: Whitelist
description: Melewati pemeriksaan untuk aset statis, path tertentu, prefix, dan IP tepercaya.
---

`config/whitelist.json` menentukan trafik yang langsung diteruskan ke origin tanpa evaluasi
rule engine.

## Struktur

```json
{
  "paths": ["/robots.txt", "/sitemap.xml", "/favicon.ico", "/api/health"],
  "prefixes": ["/assets/", "/static/"],
  "ips": []
}
```

| Field | Tipe | Keterangan |
| --- | --- | --- |
| `paths` | array string | Path persis yang dilewatkan |
| `prefixes` | array string | Awalan path yang dilewatkan |
| `ips` | array string | Alamat IP klien yang selalu dilewatkan |

## Urutan pemeriksaan

`isKnownAsset()` mengecek dengan urutan:

1. **Ekstensi statis** — path berakhiran `.js`, `.css`, `.svg`, `.png`, `.ico`, `.jpg`,
   `.woff`, atau `.woff2`.
2. **Exact path** — `knownAssetExact.has(path)`.
3. **Prefix** — `knownAssetPrefixes.some((p) => path.startsWith(p))`.
4. **IP** — `whitelistIps.includes(clientIP)`.

Jika salah satu benar, request langsung diteruskan.

## Detail penting

- **Case-sensitive.** `path` diambil dari `url.pathname` mentah, tanpa `toLowerCase()`.
  `/ASSETS/app.js` tidak cocok dengan prefix `/assets/`, tetapi tetap cocok lewat aturan
  ekstensi `.js`.
- **Belum di-decode.** Pemeriksaan memakai path mentah. `/assets/%2e%2e/secret` tidak akan
  dianggap sebagai prefix `/assets/` setelah decoding, karena decoding tidak dilakukan di sini.
- **Query string tidak diperiksa.** Hanya pathname.
- **Trailing slash berpengaruh.** `/api/health` dan `/api/health/` adalah dua path berbeda.
- **IP diambil dari `cf-connecting-ip`.** Di luar Cloudflare, nilainya bisa `Unknown IP`.
- **Whitelist dikompilasi sekali** menjadi `Set` saat cold start, sehingga lookup exact path O(1).

:::caution[Hati-hati memasukkan prefix luas]
Prefix seperti `/api/` atau `/` akan melewati seluruh pemeriksaan untuk path terkait, termasuk
request berbahaya. Masukkan hanya direktori statis yang benar-benar tidak memerlukan evaluasi.
:::

:::caution[Ekstensi statis selalu lolos]
Daftar ekstensi statis bersifat hardcoded di `src/utils.js`. Request ke
`/uploads/shell.php.jpg` akan lolos dari pemeriksaan karena berakhiran `.jpg`, meskipun origin
Anda mungkin memperlakukannya berbeda. Jika ini berisiko, tinjau ulang daftar tersebut.
:::

## Contoh penggunaan

### Mengecualikan endpoint monitoring

```json
{
  "paths": ["/health", "/ready", "/metrics"],
  "prefixes": ["/assets/", "/static/", "/images/"],
  "ips": []
}
```

### Mengecualikan IP kantor atau monitoring

```json
{
  "ips": ["203.0.113.10", "198.51.100.24"]
}
```

IP harus persis sama dengan nilai `cf-connecting-ip`; CIDR range tidak didukung.

### Mengizinkan seluruh aset publik

```json
{
  "prefixes": ["/assets/", "/static/", "/media/", "/fonts/"]
}
```

## Hubungan dengan circuit breaker

IP yang ada di `whitelist.ips` tidak akan pernah mencapai tahap scoring maupun circuit breaker.
Ini bisa dipakai sebagai escape hatch ketika ada pengguna sah di balik IP yang sama dan sering
memicu false positive.

Namun, whitelist IP bersifat statis. Jika IP tersebut berpindah atau disewa ulang, entri lama
harus dihapus manual.

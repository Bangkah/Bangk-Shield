---
title: Build Pipeline
description: Apa yang sebenarnya dilakukan scripts/build-rules.cjs, validasinya, dan output artefaknya.
---

`src/index.js` tidak pernah membaca `config/rules.json` secara langsung. Ia membaca artefak
`src/rules.compiled.json` yang dihasilkan oleh:

```bash
npm run build:rules
```

Script ini dipanggil otomatis lewat hook di `package.json`:

| Hook | Perintah induk |
| --- | --- |
| `prebuild` | `npm run build` (paket npm) |
| `predev` | `npm run dev` (Wrangler) |
| `predeploy` | `npm run deploy` |

Jika build gagal, proses induk tidak dijalankan. Inilah **fail-closed by pipeline**.

## Tahapan build

Implementasi aktual di `scripts/build-rules.cjs`:

1. Baca dan parse `config/rules.json`.
2. Validasi `global.score_threshold` dan `global.body_scan_limit_bytes`.
3. Pastikan `vectors` berupa array non-kosong.
4. Untuk setiap vector:
   - Validasi `id` string dan tidak duplikat.
   - Pastikan `signals` array non-kosong.
   - Validasi setiap sinyal: field wajib, regex valid, heuristik ReDoS, `where`, `score`.
   - Validasi referensi `combo_bonus`.
   - Beri warning jika `roast` kosong.
5. Hitung skor maksimum teoretis per vector dan beri warning jika di bawah threshold.
6. Tulis `src/rules.compiled.json`.

## Validasi yang menggagalkan build

| Pemeriksaan | Pesan |
| --- | --- |
| JSON tidak valid | `config/rules.json tidak terbaca / JSON tidak valid` |
| `score_threshold` bukan angka > 0 | `global.score_threshold harus angka > 0` |
| `vectors` kosong / bukan array | `rules.vectors harus array non-kosong` |
| `id` tidak ada / bukan string | `wajib punya id string` |
| `id` duplikat | `id duplikat` |
| `signals` kosong | `signals harus array non-kosong` |
| Field sinyal hilang | `kehilangan field "..."` |
| Regex tidak valid | `pattern regex tidak valid` |
| Terindikasi ReDoS | `dicurigai ReDoS (...)` |
| `where` kosong / tidak dikenal | `where harus array non-kosong...` |
| `score` di luar 1–100 | `score harus angka 1-100` |
| Referensi combo tidak ada | `combo_bonus mereferensikan "..." yang tidak ada` |
| `combo.add` tidak valid | `combo_bonus.add harus angka > 0` |

## Warning (build tetap jalan)

- `body_scan_limit_bytes` di luar 1024–65536.
- `roast` kosong.
- Skor maksimum vector di bawah threshold, sehingga vector tidak akan pernah trigger.

## Lint ReDoS

Linter bersifat heuristik dan tidak membutuhkan dependency eksternal:

```js
const nestedQuantifier = /(?<!\\)[+*{][^)\\]*[+*{][^)\\]*\)(?<!\\)[+*{]/;
const ambiguousAlt = /\([^)]*[+*][^)]*\|[^)]*\)(?<!\\)[+*{]/;
```

Yang ditangkap:

- **Nested quantifier** — misalnya `(a+)+`.
- **Alternasi ambigu dengan quantifier** — misalnya `(a|a?)*`.

Ini bukan pembuktian lengkap. Untuk coverage lebih baik, pertimbangkan menambahkan `safe-regex`
sebagai devDependency.

## Bentuk artefak

```json
{
  "_meta": {
    "built_at": "2026-10-21T00:00:00.000Z",
    "source": "config/rules.json",
    "version": 1
  },
  "global": {
    "score_threshold": 50,
    "body_scan_limit_bytes": 16384
  },
  "vectors": [
    {
      "id": "sqli",
      "enabled": true,
      "signals": [
        {
          "pattern": "union\\s+select",
          "flags": "i",
          "where": ["path", "query", "body"],
          "score": 60
        }
      ],
      "combo_bonus": [],
      "roast": ["..."],
      "default_fake_status": 200,
      "fake_payload": {
        "delay_ms": [150, 400],
        "body": { "error": "MySQL 1064" }
      }
    }
  ]
}
```

Perhatikan bahwa builder menambahkan `flags` default `"i"` dan mengisi nilai default untuk
`enabled`, `combo_bonus`, `roast`, `default_fake_status`, dan `fake_payload`.

## Status implementasi vs dokumentasi

PRD dan README menyebut beberapa hal yang **belum ada** di script saat ini:

| Klaim dokumen | Kondisi kode |
| --- | --- |
| Validasi JSON Schema memakai Ajv | Tidak ada. `ajv` terpasang di dependencies tetapi tidak diimpor. |
| Lint huruf kapital literal | Tidak ada. Tidak diperlukan selama flag default `i`. |
| File `config/rules.schema.json` | File aktual bernama `config/rules.scema.json` (typo) dan tidak dibaca script. |
| `scripts/rotate-salt.js` | Tidak ada. `package.json` menunjuk `rotate-salt.cjs` yang juga tidak ada. |

Lihat [Batas Kemampuan](/referensi/batas-kemampuan/) untuk daftar lengkap.

## Menjalankan build secara manual

```bash
node scripts/build-rules.cjs
```

Contoh output sukses:

```text
[build-rules] Membaca config/rules.json ...
[build-rules] OK: 6 vector (6 enabled) -> src/rules.compiled.json
[build-rules] threshold=50, body_limit=16384 bytes, 0 warning
```

Jika ada error, script keluar dengan kode non-zero dan artefak **tidak ditulis**.

:::tip[Verifikasi sebelum commit]
Jalankan `npm run build:rules` sebelum commit jika Anda mengubah `config/rules.json`. Artefak
`src/rules.compiled.json` ikut di-track oleh git pada repo ini.
:::

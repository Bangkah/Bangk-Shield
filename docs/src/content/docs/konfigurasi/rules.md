---
title: Referensi rules.json
description: Struktur lengkap config/rules.json — global, vector, signal, combo bonus, roast, dan fake payload.
---

`config/rules.json` adalah **sumber kebenaran** untuk seluruh deteksi. File ini tidak dibaca
saat runtime; ia dikompilasi menjadi `src/rules.compiled.json` oleh build pipeline.

:::danger[Jangan edit artefak]
`src/rules.compiled.json` dihasilkan otomatis dan akan tertimpa setiap kali `npm run build:rules`
dijalankan. Selalu edit `config/rules.json`.
:::

## Struktur tingkat atas

```json
{
  "global": {
    "body_scan_limit_bytes": 16384,
    "score_threshold": 50
  },
  "vectors": []
}
```

### `global`

| Field | Tipe | Wajib | Batas | Fungsi |
| --- | --- | --- | --- | --- |
| `body_scan_limit_bytes` | integer | Ya (menurut schema) | 512–65536 | Maksimum byte body yang dipindai |
| `score_threshold` | integer | Ya | > 0 | Ambang skor untuk memicu honeypot |

Build akan gagal jika `score_threshold` bukan angka > 0. Nilai `body_scan_limit_bytes` di luar
rentang 1024–65536 hanya menghasilkan **warning**, bukan error.

## Struktur vector

```json
{
  "id": "sqli",
  "enabled": true,
  "default_fake_status": 200,
  "signals": [],
  "combo_bonus": [],
  "roast": [],
  "fake_payload": {}
}
```

| Field | Tipe | Wajib | Default | Keterangan |
| --- | --- | --- | --- | --- |
| `id` | string | Ya | — | Unik; huruf kecil, angka, `_` |
| `enabled` | boolean | Tidak | `true` | `false` = vector dilewati saat kompilasi |
| `default_fake_status` | integer | Tidak | `200` | Status HTTP response honeypot |
| `signals` | array | Ya | — | Minimal satu sinyal |
| `combo_bonus` | array | Tidak | `[]` | Bonus skor untuk kombinasi sinyal |
| `roast` | array string | Ya (menurut schema) | `[]` | Dipilih acak saat honeypot terpicu |
| `fake_payload` | object | Ya (menurut schema) | default build | Delay dan body palsu |

Build memberi **warning** jika `roast` kosong. Saat runtime, `getRandomItem()` mengembalikan
`"No roast found."` untuk array kosong.

`fake_payload` default yang dipakai builder jika tidak diisi:

```json
{
  "delay_ms": [120, 450],
  "body": { "status": "blocked" }
}
```

## Signal

```json
{
  "pattern": "union\\s+select",
  "flags": "i",
  "where": ["path", "query", "body"],
  "score": 60
}
```

| Field | Tipe | Wajib | Keterangan |
| --- | --- | --- | --- |
| `pattern` | string | Ya | Regex JavaScript, ditulis dalam bentuk JSON-escaped |
| `flags` | string | Tidak | Default `"i"`. Jangan gunakan `"g"` (stateful) |
| `where` | array | Ya | Kombinasi `path`, `query`, `body`, `headers` |
| `score` | integer | Ya | 1–100 |

Build akan gagal jika:

- `pattern` bukan regex valid.
- `pattern` terdeteksi berpotensi ReDoS.
- `where` kosong atau berisi nilai yang tidak dikenal.
- `score` di luar 1–100.

### Field `where`

| Nilai | Yang diperiksa |
| --- | --- |
| `path` | Pathname, sudah di-decode dan lowercase |
| `query` | Query string, sudah di-decode dan lowercase |
| `body` | Body teks, sudah di-decode dan lowercase |
| `headers` | Hanya User-Agent, sudah lowercase |

Sinyal dihitung **sekali** meskipun cocok di beberapa field sekaligus.

## Combo bonus

```json
{
  "combo_bonus": [
    { "if_all": ["lfi:0", "lfi:3"], "add": 15 }
  ]
}
```

| Field | Tipe | Wajib | Keterangan |
| --- | --- | --- | --- |
| `if_all` | array string | Ya | Referensi `<vector-id>:<index-sinyal>`; minimal 2 |
| `add` | integer | Ya | Tambahan skor, harus > 0 |

Build akan gagal jika referensi menunjuk sinyal yang tidak ada. Bonus hanya berlaku dalam
vector yang sama.

## Fake payload

```json
{
  "delay_ms": [150, 400],
  "body": {
    "error": "MySQL 1064",
    "detail": "syntax error near 'FROM users'",
    "rows_returned": 0
  }
}
```

- `delay_ms` — array dua angka `[min, max]`; delay dipilih acak dalam rentang tersebut.
- `body` — objek apa pun; di-serialize dengan indentasi 2 spasi dan ditempel ke response teks.

`default_fake_status` menentukan status HTTP. Banyak vektor memakai `200` agar scanner mengira
request berhasil.

## Vector yang tersedia saat ini

### `sqli`

| # | Pattern | Where | Skor |
| ---: | --- | --- | ---: |
| 0 | `union\s+select` | path, query, body | 60 |
| 1 | `\bor\s+1\s*=\s*1\b` | path, query, body | 55 |
| 2 | `sleep\(\|benchmark\(\|waitfor\s+delay` | path, query, body | 55 |
| 3 | `information_schema\|xp_cmdshell` | path, query, body | 55 |
| 4 | `(%27)\|(\-\-\s)` | query, body | 25 |

Sinyal #4 mengandung `%27` yang tidak akan pernah cocok karena context sudah di-decode.
Lihat [Rule Engine § Decoding](/konsep/rule-engine/#decoding-dan-implikasi-sinyal).

### `rce`

| # | Pattern | Where | Skor |
| ---: | --- | --- | ---: |
| 0 | `\b(exec\|system\|passthru\|eval\|shell_exec)\s*\(` | path, query, body | 60 |
| 1 | `/bin/(bash\|sh)\b` | path, query, body | 55 |
| 2 | `\b(wget\|curl)\s+https?://` | query, body | 50 |
| 3 | `(;\|\|\|&&)\s*(cat\|ls\|whoami\|id\|uname)\b` | path, query, body | 55 |
| 4 | `base64_decode\(` | query, body | 30 |

### `ssrf`

| # | Pattern | Where | Skor |
| ---: | --- | --- | ---: |
| 0 | `169\.254\.169\.254` | path, query, body | 60 |
| 1 | `metadata\.google\.internal` | path, query, body | 60 |
| 2 | `\b(file\|gopher\|dict)://` | query, body | 55 |
| 3 | `\b(localhost\|127\.0\.0\.1)[:/]` | query, body | 30 |

### `lfi`

| # | Pattern | Where | Skor |
| ---: | --- | --- | ---: |
| 0 | `etc/passwd\|boot\.ini\|win\.ini` | path, query, body | 50 |
| 1 | `php://(filter\|input)` | path, query, body | 50 |
| 2 | `/proc/self/environ` | path, query, body | 50 |
| 3 | `(\.\./){2,}` | path, query, body | 35 |

Combo: `lfi:0` + `lfi:3` → **+15**.

### `xss`

| # | Pattern | Where | Skor |
| ---: | --- | --- | ---: |
| 0 | `<\s*script[^>]*>` | path, query, body | 35 |
| 1 | `on(error\|load)\s*=\s*["']` | path, query, body | 30 |
| 2 | `document\.cookie` | path, query, body | 30 |
| 3 | `javascript:` | path, query, body | 25 |

Combo: `xss:0` + `xss:2` → **+15**.

### `recon`

| # | Pattern | Where | Skor |
| ---: | --- | --- | ---: |
| 0 | `\.env(\b\|$)` | path | 25 |
| 1 | `\.git/config` | path | 25 |
| 2 | `wp-admin\|phpmyadmin` | path | 20 |
| 3 | `backup\.zip\|config\.php\.bak\|\.htpasswd` | path | 25 |
| 4 | `server-status` | path | 20 |

Combo: `recon:0` + `recon:2` → **+20**.

## Cara menambah aturan

1. Edit `config/rules.json`.
2. Pastikan JSON valid dan setiap regex dapat dikompilasi.
3. Jalankan:

   ```bash
   npm run build:rules
   ```

4. Perhatikan warning “skor maksimum < threshold” — artinya vector tidak akan pernah trigger.
5. Uji dengan `npm run dev` dan [Skenario Pengujian](/pengembangan/skenario-pengujian/).

:::tip[Threshold dan desain skor]
Jika Anda ingin vector hanya trigger saat beberapa sinyal muncul bersamaan, beri skor per sinyal
di bawah threshold dan gunakan `combo_bonus` untuk melewatinya. Contohnya `xss`: sinyal 25–35
tidak cukup sendirian, tetapi kombinasi dua sinyal plus bonus menghasilkan 80.
:::

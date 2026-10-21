---
title: Watermark
description: Spesifikasi hash watermark, bentuk data salt di KV, rotasi, dan cara memverifikasinya.
---

Setiap response honeypot menyertakan header `X-Bangk-Shield-Watermark`. Nilainya adalah hash
yang dapat direkonstruksi ulang oleh pemilik situs untuk membuktikan bahwa screenshot atau
response tersebut benar-benar berasal dari Bangk-Shield — bukan dari server yang benar-benar rentan.

## Format

Spesifikasi ini bersifat mengikat. Perubahan harus memakai versi baru (`/v2`, `bs2-`), bukan
menimpa format yang sudah beredar.

```text
Canonical : bangk-shield/v1|<ip>|<ua>|<yyyy-mm-dd>|<salt>
Output    : bs1-<16 karakter hex pertama dari SHA-256(canonical)>
```

| Komponen | Sumber |
| --- | --- |
| `ip` | Header `cf-connecting-ip`, fallback `Unknown IP` |
| `ua` | Header `User-Agent` **apa adanya** (belum di-lowercase), fallback `Unknown Scanner` |
| `yyyy-mm-dd` | Tanggal UTC dari `new Date().toISOString().split('T')[0]` |
| `salt` | Dari KV, environment, atau default dev |

:::caution[Gunakan nilai mentah]
Watermark memakai User-Agent mentah. Context deteksi memakai User-Agent yang sudah di-lowercase.
Saat memverifikasi, gunakan string User-Agent persis seperti yang dikirim klien, bukan versi lowercase.
:::

## Implementasi

```js
export async function generateWatermark(ip, ua, salt) {
  const dateStr = new Date().toISOString().split('T')[0];
  const canonical = `bangk-shield/v1|${ip}|${ua}|${dateStr}|${salt}`;

  const data = new TextEncoder().encode(canonical);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return `bs1-${hashHex.slice(0, 16)}`;
}
```

## Resolusi salt

`resolveSalt(env)` mencoba sumber berikut secara berurutan:

1. **KV** — key `wm:salt:current`.
2. **Environment** — `env.WATERMARK_SALT`.
3. **Default dev** — `default-dev-salt`.

Fungsi mengembalikan `{ salt, source }`, dengan `source` bernilai `kv`, `env`, atau `default`.
Jika `source` bukan `kv`, `index.js` mencatat event `salt_fallback` ke Analytics Engine.

```js
export async function resolveSalt(env) {
  if (env && env.BANGK_KV) {
    try {
      const kvRaw = await env.BANGK_KV.get('wm:salt:current');
      const kvSalt = kvRaw ? extractSaltValue(kvRaw) : null;
      if (kvSalt) return { salt: kvSalt, source: 'kv' };
    } catch (_) {
      // lanjut ke fallback
    }
  }
  if (env && env.WATERMARK_SALT) {
    return { salt: env.WATERMARK_SALT, source: 'env' };
  }
  return { salt: DEFAULT_DEV_SALT, source: 'default' };
}
```

:::danger[Jangan andalkan `WATERMARK_SALT` di produksi]
Environment variable bersifat statis dan tidak bisa dirotasi tanpa deploy ulang. Salt produksi
harus berasal dari KV.
:::

## Bentuk data di KV

Sesuai PRD Beta §3.4.1:

```text
wm:salt:current -> { "salt": "...", "since": "<ISO date>" }
wm:salt:history -> [{ "salt": "...", "since": "...", "until": "..." }, ...]
```

- `wm:salt:current` menyimpan salt aktif.
- `wm:salt:history` menyimpan maksimal 5 entri salt sebelumnya.
- Kode toleran terhadap bentuk lama berupa string polos, untuk keperluan migrasi.

`extractSaltValue()` menangani tiga bentuk:

| Bentuk | Perlakuan |
| --- | --- |
| Objek `{ salt, since }` | Ambil properti `salt` |
| Objek `{ salt, since, until }` | Ambil properti `salt` |
| String polos | Pakai string itu sebagai salt |
| String JSON berisi objek `{ salt }` | Parse lalu ambil `salt` |

## Rotasi salt

Idealnya rotasi dilakukan dengan:

```bash
npm run salt:rotate
```

Perintah itu memindahkan salt aktif ke `wm:salt:history` dan membuat salt baru. Namun
**`scripts/rotate-salt.cjs` tidak ada di repository saat ini**, sehingga perintah tersebut gagal.

### Rotasi manual sementara

Dengan Wrangler 3:

```bash
# Lihat salt aktif
npx wrangler kv:key get "wm:salt:current" --binding=BANGK_KV --remote

# Tulis salt baru (contoh)
npx wrangler kv:key put "wm:salt:current" "{\"salt\":\"$(openssl rand -hex 32)\",\"since\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" --binding=BANGK_KV --remote
```

Di PowerShell:

```powershell
$salt = -join ((48..57) + (97..102) | Get-Random -Count 64 | ForEach-Object { [char]$_ })
$value = "{`"salt`":`"$salt`",`"since`":`"$((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))`"}"
npx wrangler kv:key put "wm:salt:current" $value --binding=BANGK_KV --remote
```

Jika memakai salt baru, watermark lama tidak akan valid lagi kecuali salt lama disimpan di
`wm:salt:history` dan verifikasi mencoba seluruh kandidat.

## Verifikasi mundur

`resolveSaltCandidates(env)` mengembalikan salt aktif beserta seluruh salt di history:

```js
import { resolveSaltCandidates, generateWatermark } from './src/watermark.js';

const candidates = await resolveSaltCandidates(env);
const expected = await Promise.all(
  candidates.map((salt) => generateWatermark(ip, ua, salt))
);
const valid = expected.includes(receivedWatermark);
```

Fungsi ini saat ini belum dipakai oleh engine maupun dashboard mana pun, tetapi diekspor untuk
kebutuhan verifikasi di masa depan.

## Contoh verifikasi mandiri

```js
async function verifyWatermark({ ip, ua, date, salt, received }) {
  const canonical = `bangk-shield/v1|${ip}|${ua}|${date}|${salt}`;
  const buffer = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical)
  );
  const hex = Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const expected = `bs1-${hex.slice(0, 16)}`;
  return expected === received;
}
```

## Batasan

- Hash memakai 16 karakter hex pertama (64 bit). Ini cukup untuk verifikasi praktis, bukan
  pengganti tanda tangan kriptografis.
- Salt yang bocor memungkinkan pihak lain memalsukan watermark.
- Verifikasi harus mengetahui IP dan User-Agent asli. Untuk screenshot, IP tidak terlihat;
  verifikasi biasanya dilakukan terhadap log atau data yang dicatat pemilik situs.
- Tanggal memakai UTC, sehingga pergantian hari mengikuti UTC, bukan zona waktu lokal.

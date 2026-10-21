---
title: Modul Internal
description: Referensi fungsi di scanner, ratelimit, watermark, logger, dan utils.
---

Dokumen ini merangkum API internal setiap modul di `src/`.

## `scanner.js`

### `compileRules(vectors)`

```ts
function compileRules(vectors: CompiledVector[]): RuleEngine
```

Mengubah sinyal berbentuk string menjadi `RegExp`. Vector dengan `enabled: false` dilewati.

- **Input:** array vector dari artefak build.
- **Output:** array vector dengan properti `signals[].regex`.
- **Efek samping:** tidak ada; dipanggil sekali saat cold start.

### `evaluateThreat(context, engine)`

```ts
function evaluateThreat(context: Context, engine: RuleEngine): Evaluation
```

Menghitung skor setiap vector, menambahkan combo bonus, dan mengembalikan vector dengan skor
tertinggi.

```ts
interface Context {
  path: string;
  query: string;
  headers: string;
  body: string;
}

interface Evaluation {
  isAttack: boolean;
  score: number;
  attackType: string;
  vectorDef: CompiledVector | null;
}
```

- `isAttack` bernilai `score > 0`.
- `attackType` default `'recon'` jika tidak ada vector yang cocok.
- `vectorDef` bernilai `null` jika tidak ada vector yang cocok.

## `ratelimit.js`

### `checkCircuitBreaker(ip, kv)`

```ts
function checkCircuitBreaker(ip: string, kv: KVNamespace): Promise<{ isBlocked: boolean }>
```

Membaca `strike:<ip>` dari KV dan membandingkannya dengan `STRIKE_THRESHOLD` (5).

- Jika `kv` tidak ada atau error → `{ isBlocked: false }`.
- Tidak menulis apa pun ke KV.

### `recordStrike(ip, kv)`

```ts
function recordStrike(ip: string, kv: KVNamespace): Promise<void>
```

Menambah counter `strike:<ip>` dan menulis ulang dengan `expirationTtl: 60`.

- Error ditelan (fail-open).
- Bukan operasi atomic.

Konstanta internal: `STRIKE_TTL_SECONDS = 60`, `STRIKE_THRESHOLD = 5`.

## `watermark.js`

### `resolveSalt(env)`

```ts
function resolveSalt(env: any): Promise<{ salt: string; source: 'kv' | 'env' | 'default' }>
```

Urutan sumber: KV `wm:salt:current` → `env.WATERMARK_SALT` → `'default-dev-salt'`.

### `resolveSaltCandidates(env)`

```ts
function resolveSaltCandidates(env: any): Promise<string[]>
```

Mengembalikan salt aktif beserta seluruh salt di `wm:salt:history`. Dipakai untuk verifikasi
mundur. Saat ini belum dipanggil oleh engine.

### `generateWatermark(ip, ua, salt)`

```ts
function generateWatermark(ip: string, ua: string, salt: string): Promise<string>
```

Menghasilkan `bs1-<16 hex>` dari SHA-256 canonical string. Tanggal memakai UTC.

### `extractSaltValue(raw)` — private

Mengekstrak nilai salt dari objek PRD (`{ salt, since }`) atau string polos (format lama).
Tidak diekspor.

## `logger.js`

### `logEventBestEffort(env, event)`

```ts
function logEventBestEffort(env: any, event: {
  ip?: string;
  path?: string;
  vector?: string;
  score?: number;
}): Promise<void>
```

- Langsung return jika `env.BANGK_ANALYTICS` tidak ada.
- Sampling event dengan `score < 30` sebesar 20%.
- Menulis data point dengan `blobs`, `doubles`, dan `indexes`.
- Menangkap error penulisan dan mencetaknya ke console.

Konstanta internal: `SAMPLING_SCORE_THRESHOLD = 30`, `SAMPLING_RATE = 0.2`.

## `utils.js`

### `safeDecode(text)`

```ts
function safeDecode(text: string): string
```

Membungkus `decodeURIComponent()`; jika gagal, mengembalikan teks asli.

### `isKnownAsset(path, clientIP, exact, prefixes, ips)`

```ts
function isKnownAsset(
  path: string,
  clientIP: string,
  knownAssetExact: Set<string>,
  knownAssetPrefixes: string[],
  whitelistIps: string[]
): boolean
```

Mengecek ekstensi statis, exact path, prefix, lalu IP. Lihat [Whitelist](/konfigurasi/whitelist/).

### `readBodyLimited(request, maxBytes)`

```ts
function readBodyLimited(request: Request, maxBytes: number): Promise<string>
```

Membaca body lewat `request.clone().body.getReader()` hingga `maxBytes`, lalu mengembalikan
string yang dipotong. Mengembalikan `''` jika tidak ada body atau terjadi error.

### `sanitizeForEcho(value, maxLength)`

```ts
function sanitizeForEcho(value: string, maxLength: number): string
```

Membuang karakter kontrol, memangkas, dan memotong dengan suffix `...[truncated]`.

### `getRandomItem(arr)`

```ts
function getRandomItem<T>(arr: T[]): T | string
```

Memilih elemen acak. Mengembalikan `'No roast found.'` untuk array kosong.

### `passthrough(request, env)`

```ts
function passthrough(request: Request, env: any): Promise<Response>
```

Urutan: loop-guard → `env.ASSETS` → `env.ORIGIN_URL` → placeholder 200.

### `passthroughSafe(request, env)`

```ts
function passthroughSafe(request: Request, env: any): Promise<Response>
```

Membungkus `passthrough()` dengan `try/catch`; jika gagal, mengembalikan `500`.

### `formatHoneypotResponse(data)`

```ts
function formatHoneypotResponse(data: {
  url: string;
  clientIP: string;
  attackType: string;
  score: number;
  userAgent: string;
  roast: string;
  payload: string;
  watermark: string;
}): string
```

Mengembalikan template teks honeypot. Lihat [Format Respons](/referensi/respons/).

## Konstanta penting

| Modul | Konstanta | Nilai |
| --- | --- | ---: |
| `scanner` | flag regex default | `'i'` |
| `ratelimit` | `STRIKE_TTL_SECONDS` | 60 |
| `ratelimit` | `STRIKE_THRESHOLD` | 5 |
| `watermark` | `DEFAULT_DEV_SALT` | `'default-dev-salt'` |
| `watermark` | `WATERMARK_VERSION` | `'v1'` |
| `watermark` | `WATERMARK_PREFIX` | `'bs1-'` |
| `logger` | `SAMPLING_SCORE_THRESHOLD` | 30 |
| `logger` | `SAMPLING_RATE` | 0.2 |
| `utils` | `LOOP_GUARD_HEADER` | `'x-bangk-shield-forwarded'` |
| `utils` | `STATIC_EXTENSIONS` | `.js`, `.css`, `.svg`, `.png`, `.ico`, `.jpg`, `.woff`, `.woff2` |

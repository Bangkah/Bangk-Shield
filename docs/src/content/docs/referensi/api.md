---
title: API Programmatic
description: Memakai Bangk-Shield sebagai fungsi di dalam Worker lain lewat package npm.
---

Selain di-deploy sebagai Worker mandiri, Bangk-Shield dapat diimpor sebagai fungsi. Entry point
package adalah `publish/index.ts`, yang dibangun oleh `tsup` menjadi `dist/index.js` beserta
`dist/index.d.ts`.

## Ekspor

```ts
interface ShieldOptions {
  scoreThreshold?: number;
  originUrl?: string;
}

declare function bangkShield(
  request: Request,
  env: any,
  ctx: ExecutionContext,
  options?: ShieldOptions
): Promise<any>;

export { type ShieldOptions, bangkShield };
```

Package tidak menyediakan default export. Hanya `bangkShield` dan tipe `ShieldOptions`.

## Signature

```ts
bangkShield(request, env, ctx, options?)
```

| Parameter | Tipe | Keterangan |
| --- | --- | --- |
| `request` | `Request` | Request masuk |
| `env` | `any` | Environment Worker (`BANGK_KV`, `BANGK_ANALYTICS`, dll.) |
| `ctx` | `ExecutionContext` | Dipakai untuk `ctx.waitUntil()` logging dan strike |
| `options.scoreThreshold` | `number` | Override threshold; default dari `rules.compiled.json` |
| `options.originUrl` | `string` | Origin tujuan untuk request yang lolos |

## Return value

| Kondisi | Return |
| --- | --- |
| Request known-asset, `originUrl` diisi | `fetch()` ke origin |
| Request known-asset, tanpa `originUrl` | `null` |
| Request bukan serangan, `originUrl` diisi | `fetch()` ke origin |
| Request bukan serangan, tanpa `originUrl` | `null` |
| Serangan diblokir circuit breaker | `Response` 403 |
| Serangan terdeteksi | `Response` honeypot |
| Exception | `passthroughSafe()` (bisa `Response` placeholder/500) |

:::caution[`null` harus ditangani]
Dalam mode library, `null` berarti “request ini bukan urusan Bangk-Shield”. Pemanggil harus
menangani `null`, misalnya dengan melanjutkan ke handler aplikasi. Ini berbeda dari
`src/index.js` yang selalu mengembalikan `Response`.
:::

## Contoh integrasi

```ts
import { bangkShield } from 'bangk-shield';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const shieldResponse = await bangkShield(request, env, ctx, {
      originUrl: env.ORIGIN_URL,
      scoreThreshold: 50,
    });

    if (shieldResponse) {
      return shieldResponse;
    }

    // Request bukan serangan dan tidak ada originUrl:
    // lanjutkan ke handler aplikasi Anda.
    return handleApp(request, env, ctx);
  },
};
```

Jika Worker Anda sudah memiliki routing sendiri, pola ini memungkinkan honeypot dipasang
hanya pada route tertentu:

```ts
if (url.pathname.startsWith('/api/')) {
  const guarded = await bangkShield(request, env, ctx, { originUrl: env.ORIGIN_URL });
  if (guarded) return guarded;
}
```

## Perbedaan dengan `src/index.js`

| Aspek | `src/index.js` (Worker) | `publish/index.ts` (library) |
| --- | --- | --- |
| Passthrough tanpa origin | Placeholder teks 200 | `null` |
| Sumber origin | `env.ASSETS` / `env.ORIGIN_URL` | `options.originUrl` |
| Loop guard | Diset oleh `passthrough()` | Tidak diset pada jalur known-asset/origin |
| Panggilan KV | Selalu memanggil fungsi; fungsi menangani KV kosong | Dicek dengan `env.BANGK_KV &&` |
| Threshold | Konstanta dari artefak | Dapat di-override per pemanggilan |
| Error fallback | `passthroughSafe(request, env)` | Sama, tetapi **tidak** memakai `options.originUrl` |

:::note[Fallback error tidak memakai `options.originUrl`]
Jika terjadi exception, `passthroughSafe()` memakai `env.ASSETS` atau `env.ORIGIN_URL`, bukan
`options.originUrl`. Pastikan salah satu environment tersebut tersedia jika Anda mengandalkan
fail-open ke origin.
:::

## Build package

```bash
npm run build
```

Perintah ini menjalankan `prebuild` (build rules) lalu:

```bash
tsup publish/index.ts --format esm --dts --clean
```

Output di `dist/`:

- `index.js` — bundle ESM.
- `index.d.ts` — deklarasi tipe.

`dist/` di-ignore oleh git, jadi harus dibangun sebelum dipublikasikan.

## Catatan kompatibilitas

- Package bertipe ESM (`"type": "module"`).
- `@cloudflare/workers-types` adalah devDependency; konsumen perlu menyediakan tipe runtime
  Workers sendiri.
- `ajv` tercantum sebagai dependency, tetapi belum dipakai oleh kode runtime maupun build rules.
- `publish/index.ts` mengimpor `../config/whitelist.json` dan `../src/rules.compiled.json`
  secara langsung; keduanya dibundel oleh `tsup`.

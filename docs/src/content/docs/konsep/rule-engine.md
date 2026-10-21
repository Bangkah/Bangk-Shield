---
title: Rule Engine
description: Cara regex dikompilasi, bagaimana skor dihitung, dan bagaimana combo bonus bekerja.
---

Rule engine terdiri dari dua fungsi di `src/scanner.js`:

- `compileRules(vectors)` — mengubah artefak JSON menjadi regex sungguhan, sekali saat cold start.
- `evaluateThreat(context, engine)` — mengevaluasi satu request dan mengembalikan skor tertinggi.

## Kompilasi

```js
export function compileRules(vectors) {
  const engine = [];
  for (const vector of vectors || []) {
    if (!vector.enabled) continue;
    const compiledSignals = vector.signals.map((sig) => ({
      ...sig,
      regex: new RegExp(sig.pattern, sig.flags || 'i'),
    }));
    engine.push({ ...vector, signals: compiledSignals });
  }
  return engine;
}
```

Poin penting:

- Vector dengan `enabled: false` dilewati sepenuhnya.
- Flag default adalah `i` (case-insensitive).
- Kompilasi terjadi di module scope, bukan per request.
- Regex yang tidak valid akan menggagalkan build pipeline sebelum sampai ke edge.

:::caution[Jangan pakai flag `g`]
Objek `RegExp` dipakai ulang lintas request. Flag `g` membuat `lastIndex` bersifat stateful,
sehingga hasil `regex.test()` bisa berganti-ganti antar request. Gunakan flag default `i` saja.
:::

## Evaluasi skor

```js
export function evaluateThreat(context, engine) {
  let highestScore = 0;
  let detectedVector = 'recon';
  let vectorDef = null;

  for (const vector of engine) {
    let vectorScore = 0;
    const triggeredSignals = new Set();

    vector.signals.forEach((sig, index) => {
      let matched = false;
      for (const target of sig.where) {
        if (context[target] && sig.regex.test(context[target])) {
          matched = true;
          break;
        }
      }
      if (matched) {
        vectorScore += sig.score;
        triggeredSignals.add(`${vector.id}:${index}`);
      }
    });

    if (vector.combo_bonus) {
      for (const combo of vector.combo_bonus) {
        const allMatch = combo.if_all.every((ref) => triggeredSignals.has(ref));
        if (allMatch) vectorScore += combo.add;
      }
    }

    if (vectorScore > highestScore) {
      highestScore = vectorScore;
      detectedVector = vector.id;
      vectorDef = vector;
    }
  }

  return { isAttack: highestScore > 0, score: highestScore, attackType: detectedVector, vectorDef };
}
```

### Aturan yang perlu diingat

1. **Setiap sinyal dihitung sekali per vector**, meskipun polanya cocok di beberapa field.
2. **Skor adalah jumlah**, bukan rata-rata. Satu sinyal kuat bisa langsung melewati threshold.
3. **Vector dengan skor tertinggi menang.** Jika seri, vector yang lebih dulu dievaluasi
   (urutan di `rules.compiled.json`) yang dilaporkan, karena perbandingan memakai `>` bukan `>=`.
4. **Combo bonus hanya menambah skor vector yang sama.** Referensi `if_all` berbentuk
   `<vector-id>:<index-sinyal>`, misalnya `lfi:0`.
5. **`isAttack` bernilai `true` jika skor > 0**, bahkan jika masih di bawah threshold.
   Keputusan akhir tetap dilakukan oleh `index.js`.

## Field `where`

`where` menentukan field context mana yang diperiksa untuk sebuah sinyal:

| Nilai | Isi sebenarnya |
| --- | --- |
| `path` | Pathname yang sudah di-decode dan di-lowercase |
| `query` | Query string lengkap, termasuk `?`, sudah di-decode dan di-lowercase |
| `body` | Body teks yang sudah di-decode dan di-lowercase, maksimal 16 KB |
| `headers` | **Hanya** nilai header `User-Agent`, sudah di-lowercase |

:::caution[`headers` bukan seluruh header]
Saat ini `context.headers` diisi hanya dari `User-Agent`. Sinyal yang mengharapkan header lain
(misalnya `Referer` atau `X-Forwarded-For`) tidak akan pernah cocok.
:::

## Skor maksimum vector saat ini

Nilai dihitung dari `config/rules.json` (tanpa memperhitungkan field mana yang cocok):

| Vector | Jumlah sinyal | Skor dasar | Combo | Maksimum teoretis |
| --- | ---: | ---: | ---: | ---: |
| `sqli` | 5 | 250 | — | 250 |
| `rce` | 5 | 250 | — | 250 |
| `ssrf` | 4 | 205 | — | 205 |
| `lfi` | 4 | 185 | +15 | 200 |
| `xss` | 4 | 120 | +15 | 135 |
| `recon` | 5 | 115 | +20 | 135 |

Threshold default **50** berarti:

- `sqli`, `rce`, `ssrf`, dan sebagian besar `lfi` dapat trigger dengan satu sinyal.
- `xss` dan `recon` membutuhkan beberapa sinyal atau combo.
- `lfi` pola `(\.\./){2,}` (35) tidak cukup sendirian; perlu sinyal lain.

## Case sensitivity

Karena context selalu di-lowercase **dan** regex default memakai flag `i`, aturan saat ini
efektif case-insensitive. Menulis `UNION SELECT` tetap akan cocok.

:::note[Selisih dengan README]
README menyebut build pipeline menggagalkan pattern yang mengandung huruf kapital literal.
Pemeriksaan itu tidak ada di `scripts/build-rules.cjs` saat ini, dan tidak diperlukan selama
flag `i` dipakai. Lihat [Batas Kemampuan](/referensi/batas-kemampuan/#selisih-dokumentasi-dan-kode).
:::

## Decoding dan implikasi sinyal

`path`, `query`, dan `body` di-decode sebelum dicocokkan. Artinya pola yang menargetkan bentuk
URL-encoded tidak akan pernah cocok. Contohnya sinyal SQLi:

```json
{ "pattern": "(%27)|(\\-\\-\\s)", "where": ["query", "body"], "score": 25 }
```

`%27` adalah tanda kutip ter-encode. Setelah `safeDecode()`, nilainya sudah menjadi `'`,
sehingga bagian `(%27)` tidak pernah match. Bagian `\-\-\s` tetap berfungsi untuk komentar SQL
yang diikuti spasi.

## Menambah vector baru

1. Tambahkan objek vector di `config/rules.json`.
2. Pastikan `id` unik dan hanya berisi huruf kecil, angka, atau `_`.
3. Isi `signals` minimal satu; setiap sinyal wajib punya `pattern`, `where`, dan `score`.
4. Jika memakai `combo_bonus`, pastikan referensi `if_all` menunjuk sinyal yang ada.
5. Jalankan `npm run build:rules`.
6. Uji dengan `npm run dev`.

Contoh vector minimal:

```json
{
  "id": "scanner_probe",
  "enabled": true,
  "default_fake_status": 200,
  "signals": [
    { "pattern": "\\bnikto\\b", "where": ["headers"], "score": 40 },
    { "pattern": "\\bsqlmap\\b", "where": ["headers"], "score": 40 }
  ],
  "combo_bonus": [
    { "if_all": ["scanner_probe:0", "scanner_probe:1"], "add": 20 }
  ],
  "roast": ["Scanner-nya ketinggalan zaman, bang."],
  "fake_payload": {
    "delay_ms": [150, 400],
    "body": { "error": "not_found" }
  }
}
```

Skema lengkap ada di [Referensi rules.json](/konfigurasi/rules/).

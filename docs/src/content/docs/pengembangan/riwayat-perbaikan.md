---
title: Riwayat Perbaikan
description: Bug penting yang ditemukan dan diperbaiki selama pengembangan Beta.
---

Versi Beta adalah rewrite arsitektur, bukan iterasi kecil. Rule engine dipindah ke build pipeline
terkompilasi, ditambah circuit breaker, watermark kriptografis, dan logging dengan sampling.

Berikut catatan bug penting yang memengaruhi desain saat ini.

## Bug kritis #1 — deteksi path hilang total

**Gejala:** semua serangan yang muncul di pathname — `/etc/passwd`, `/.env`, `/wp-admin` —
tidak pernah terdeteksi.

**Penyebab:** context yang dievaluasi hanya berisi `query`, `headers`, dan `body`. Tidak ada
`path`. Sinyal dengan `where: ["path"]` tidak punya apa pun untuk dicocokkan.

**Perbaikan:** `context.path = safeDecode(path).toLowerCase()` ditambahkan. Divalidasi dengan
lima skenario uji manual.

**Pelajaran:** field context dan `where` harus konsisten. Menambah nilai baru di `where` tanpa
mengisi context akan menghasilkan sinyal yang diam-diam mati.

## Bug kritis #2 — format watermark tidak sesuai PRD

**Gejala:** watermark tidak cocok dengan test vector yang ditetapkan PRD Beta §3.4.1.

**Penyebab:** kode awal menghasilkan canonical `bangk-shield|...` (tanpa `/v1`) dan output
`bs-<hash>` (tanpa `1`).

**Perbaikan:** canonical menjadi `bangk-shield/v1|...` dan output menjadi `bs1-<hash>`.

**Pelajaran:** format yang bersifat kontrak harus diberi versi eksplisit. Perubahan format
berikutnya harus memakai `/v2` dan `bs2-`, bukan menimpa `v1`.

## Bug kritis #3 — bentuk data salt di KV tidak cocok

**Gejala:** watermark menjadi salah secara diam-diam setelah rotasi salt.

**Penyebab:** kode lama memperlakukan nilai KV sebagai string polos. Ketika skrip rotasi mulai
menulis objek `{ salt, since }` sesuai PRD, `resolveSalt()` memakai string JSON utuh sebagai salt
— termasuk kurung kurawal dan nama field — tanpa melempar error.

**Perbaikan:**

- `extractSaltValue()` membaca `salt` dari objek, dan tetap toleran terhadap string polos untuk
  migrasi.
- Skrip rotasi seharusnya menulis bentuk objek.

**Pelajaran:** format data lintas komponen (skrip tulis vs runtime baca) harus diuji bersama,
bukan hanya per modul.

:::warning[Skrip rotasi tidak ada]
Perbaikan ini mengasumsikan `scripts/rotate-salt.cjs` menulis bentuk objek. File tersebut belum
ada di repository. Lihat [Batas Kemampuan](/referensi/batas-kemampuan/).
:::

## Optimasi — urutan circuit breaker dan scoring dibalik

**Gejala:** latensi dan biaya KV meningkat untuk mayoritas trafik yang sebenarnya sah.

**Penyebab:** draft awal memanggil `checkCircuitBreaker()` untuk setiap request non-whitelist.
Panggilan ini membutuhkan `await` ke KV, padahal sebagian besar request tidak akan pernah
memicu honeypot.

**Perbaikan:** scoring dikerjakan lebih dulu karena murni in-memory. KV baru disentuh jika
request lolos sebagai kandidat serangan.

**Dampak:** request normal tidak melakukan I/O KV sama sekali. Request serangan tetap melakukan
pengecekan dan pencatatan strike.

## Lint case-sensitivity di build pipeline

**Klaim README:** build gagal jika pattern mengandung huruf kapital literal karena context
di-lowercase.

**Kondisi aktual:** pemeriksaan itu tidak ada di `scripts/build-rules.cjs`. Selain itu,
`compileRules()` memakai flag default `i`, sehingga pattern kapital tetap cocok. Klaim tersebut
perlu diperbarui. Lihat [Batas Kemampuan](/referensi/batas-kemampuan/#2-lint-huruf-kapital-tidak-ada).

## Logging yang sebelumnya tercecer

Dua event yang sebelumnya tidak tercatat sekarang dikirim ke Analytics Engine:

- **`circuit_breaker_block`** — IP yang diblokir circuit breaker.
- **`salt_fallback`** — salt gagal diambil dari KV dan jatuh ke environment/default.

Kebijakan logging `salt_fallback` sengaja diletakkan di `index.js`, bukan `watermark.js`, karena
modul watermark tidak memiliki akses ke `ctx.waitUntil()`.

:::caution[Keduanya ter-sampling]
Karena dikirim dengan `score: 0`, sekitar 80% event tersebut tidak ditulis oleh logger.
Lihat [Logging § Sampling](/konsep/logging/#sampling).
:::

## Perubahan lain pada Beta

- Rule engine dipindah ke artefak terkompilasi `src/rules.compiled.json`.
- Build pipeline memvalidasi regex dan melakukan lint ReDoS heuristik.
- Ditambahkan circuit breaker berbasis KV.
- Ditambahkan watermark SHA-256 dengan salt dari KV.
- Ditambahkan logging sampling untuk menghemat kuota Analytics Engine.
- Ditambahkan `safeDecode()` agar input malformed tidak melempar error.
- Ditambahkan loop-guard header untuk mencegah forwarding loop.
- Ditambahkan `publish/index.ts` sebagai entry point package npm.

## Bug yang masih diketahui

Daftar lengkap ada di [Batas Kemampuan](/referensi/batas-kemampuan/). Yang paling berdampak:

1. `npm run salt:rotate` gagal karena skrip tidak ada.
2. Sinyal `%27` tidak pernah cocok setelah decoding.
3. Event circuit breaker dan salt fallback sebagian besar hilang karena sampling.
4. Validasi JSON Schema dan lint huruf kapital belum diimplementasikan.
5. Belum ada test suite otomatis untuk scoring dan watermark.

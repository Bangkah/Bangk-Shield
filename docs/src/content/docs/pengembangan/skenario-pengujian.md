---
title: Skenario Pengujian
description: Kumpulan perintah curl dan hasil yang diharapkan berdasarkan rules saat ini.
---

Halaman ini berisi skenario uji manual yang dapat dijalankan setelah `npm run dev`.
Semua skor dihitung dari `config/rules.json` dengan threshold default **50**.

## Persiapan

```bash
npm run dev
```

Dev server berjalan di `http://localhost:8787`. Jika `ORIGIN_URL` kosong, request yang lolos
akan menerima teks placeholder, bukan response origin.

:::tip[Gunakan `curl -i`]
Selalu pakai `curl -i` agar status code dan header `X-Bangk-Shield` terlihat.
:::

## Matriks pengujian

| # | Request | Skor | Hasil yang diharapkan |
| ---: | --- | ---: | --- |
| 1 | `GET /etc/passwd` | 50 | Honeypot `lfi` |
| 2 | `GET /.env` | 25 | Lolos |
| 3 | `GET /.env/wp-admin` | 65 | Honeypot `recon` |
| 4 | `GET /wp-admin` | 20 | Lolos |
| 5 | `GET /?q=union+select` | 60 | Honeypot `sqli` |
| 6 | `GET /?q=%3Cscript%3E` | 35 | Lolos |
| 7 | `GET /?q=%3Cscript%3Edocument.cookie` | 80 | Honeypot `xss` |
| 8 | `GET /?q=../../etc/passwd` | 100 | Honeypot `lfi` |
| 9 | `GET /?q=../../` | 35 | Lolos |
| 10 | `POST /api` JSON `union select` | 60 | Honeypot `sqli` |
| 11 | `GET /?url=http://169.254.169.254/` | 60 | Honeypot `ssrf` |
| 12 | `GET /?cmd=;whoami` | 55 | Honeypot `rce` |
| 13 | `GET /proc/self/environ` | 50 | Honeypot `lfi` |
| 14 | `GET /` dengan UA `sqlmap` | 0 | Lolos (headers belum dipakai) |
| 15 | 6× `GET /etc/passwd` berturut-turut | — | Trigger ke-6 diblokir 403 |
| 16 | `GET /` | 0 | Lolos |

## Perintah lengkap

### 1. LFI di path

```bash
curl -i "http://localhost:8787/etc/passwd"
```

`lfi:0` cocok di path → 50. Response berisi header `X-Bangk-Shield: honeypot-active`.

### 2. Recon sendirian

```bash
curl -i "http://localhost:8787/.env"
```

`recon:0` = 25, di bawah threshold → diteruskan.

### 3. Recon combo

```bash
curl -i "http://localhost:8787/.env/wp-admin"
```

`recon:0` (25) + `recon:2` (20) + combo (20) = **65**.

### 4. Recon lemah

```bash
curl -i "http://localhost:8787/wp-admin"
```

`recon:2` = 20 → lolos.

### 5. SQLi di query

```bash
curl -i "http://localhost:8787/?q=union+select"
```

Query di-decode menjadi `?q=union select` → `sqli:0` = 60.

### 6. XSS sendirian

```bash
curl -i "http://localhost:8787/?q=%3Cscript%3E"
```

`xss:0` = 35 → lolos.

### 7. XSS combo

```bash
curl -i "http://localhost:8787/?q=%3Cscript%3Edocument.cookie"
```

`xss:0` (35) + `xss:2` (30) + combo (15) = **80**.

### 8. LFI combo

```bash
curl -i "http://localhost:8787/?q=../../etc/passwd"
```

`lfi:0` (50) + `lfi:3` (35) + combo (15) = **100**.

### 9. Path traversal sendirian

```bash
curl -i "http://localhost:8787/?q=../../"
```

`lfi:3` = 35 → lolos.

### 10. SQLi di body JSON

```bash
curl -i -X POST "http://localhost:8787/api/search" \
  -H "Content-Type: application/json" \
  -d "{\"q\":\"union select\"}"
```

Body dibaca karena Content-Type JSON → `sqli:0` = 60.

### 11. SSRF metadata

```bash
curl -i "http://localhost:8787/?url=http://169.254.169.254/latest/meta-data"
```

`ssrf:0` = 60.

### 12. RCE command injection

```bash
curl -i "http://localhost:8787/?cmd=;whoami"
```

`rce:3` cocok pada `;whoami` → 55.

### 13. LFI proc environ

```bash
curl -i "http://localhost:8787/proc/self/environ"
```

`lfi:2` = 50.

### 14. User-Agent scanner

```bash
curl -i -A "sqlmap/1.7" "http://localhost:8787/"
```

Tidak ada sinyal yang memeriksa header selain User-Agent, dan vector saat ini tidak memakai
`headers` di `where`. Hasilnya lolos. Ini menunjukkan bahwa **deteksi berbasis User-Agent belum
aktif** meskipun engine mendukung field `headers`.

### 15. Circuit breaker

```bash
for i in 1 2 3 4 5 6; do
  curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8787/etc/passwd"
done
```

Hasil yang diharapkan:

```text
200
200
200
200
200
403
```

Trigger ke-6 diblokir karena counter sudah bernilai 5. Lihat
[Circuit Breaker](/konsep/circuit-breaker/) untuk detail perhitungan.

:::note[Di PowerShell]
Gunakan:

```powershell
1..6 | ForEach-Object {
  curl.exe -s -o NUL -w "%{http_code}`n" "http://localhost:8787/etc/passwd"
}
```
:::

### 16. Trafik normal

```bash
curl -i "http://localhost:8787/"
```

Tidak ada sinyal → diteruskan.

## Uji case sensitivity

```bash
curl -i "http://localhost:8787/?q=UNION+SELECT"
```

Context di-lowercase dan regex memakai flag `i`, sehingga tetap terdeteksi dengan skor 60.

## Uji false positive

```bash
curl -i "http://localhost:8787/?q=how+to+union+select+in+sql"
```

Ini contoh konten sah yang tetap terdeteksi sebagai SQLi (skor 60). Jika situs Anda memuat
artikel atau dokumentasi teknis, pertimbangkan untuk:

- Menyesuaikan skor atau pola.
- Menambahkan path artikel ke whitelist.
- Menaikkan threshold.

## Uji watermark

```bash
curl -i "http://localhost:8787/etc/passwd" | Select-String "X-Bangk-Shield-Watermark"
```

Untuk memverifikasi, hitung ulang hash memakai IP (`Unknown IP` di lokal), User-Agent `curl/x.y`,
tanggal UTC hari ini, dan salt yang aktif. Lihat [Watermark](/konsep/watermark/#contoh-verifikasi-mandiri).

## Inspeksi KV lokal

Wrangler menyimpan KV lokal di folder `.wrangler/`.

```bash
npx wrangler kv:key get "strike:Unknown IP" --binding=BANGK_KV --local
npx wrangler kv:key list --binding=BANGK_KV --local
```

Jika `cf-connecting-ip` tidak tersedia di lokal, semua request memakai key `strike:Unknown IP`.

## Checklist regresi

- [ ] Known-asset (`.css`, `.js`, path whitelist) tidak memicu honeypot.
- [ ] Request normal tidak menulis KV.
- [ ] Setiap vector dapat memicu honeypot dengan skor yang diharapkan.
- [ ] Combo bonus menambah skor sesuai konfigurasi.
- [ ] Threshold berubah sesuai `global.score_threshold`.
- [ ] Watermark berformat `bs1-` + 16 hex.
- [ ] Circuit breaker memblokir trigger ke-6.
- [ ] Header `X-Bangk-Shield` sesuai jenis response.
- [ ] `npm run build:rules` gagal pada rules yang sengaja dirusak.
- [ ] Error runtime tetap fail-open ke origin.

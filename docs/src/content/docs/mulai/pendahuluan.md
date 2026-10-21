---
title: Pendahuluan
description: Apa itu Bangk-Shield, masalah yang dipecahkan, dan untuk siapa alat ini dibuat.
---

**Bangk-Shield** adalah honeypot *application layer* berbasis edge untuk Cloudflare Workers.
Ia mengintersep request yang mencurigakan — SQL injection, remote code execution, SSRF,
local file inclusion, XSS, dan aktivitas reconnaissance — lalu membalas dengan response palsu
yang meyakinkan, sambil mencatat aktivitas tersebut.

Alih-alih memblokir dengan halaman error generik, Bangk-Shield menciptakan ilusi bahwa
penyerang menemukan sesuatu: error database palsu, output shell palsu, atau direktori yang
seolah ada. Tujuannya bukan sekadar menolak, tetapi membuat scanner otomatis membuang waktu
dan resource di jalur yang salah.

## Masalah yang dipecahkan

Situs kecil — portofolio, blog, side project — sering menjadi sasaran scanner otomatis.
WAF tradisional memblokir, tetapi tidak memberi umpan balik yang berguna bagi pemilik situs,
dan sering kali menghasilkan halaman blokir yang langsung memberi tahu penyerang bahwa
mereka terdeteksi.

Bangk-Shield mengambil pendekatan berbeda:

- **Deception** — memberi response yang tampak valid agar bot terus mencoba.
- **Deterrence** — memberi sinyal ke attacker manual bahwa aktivitasnya sudah terdeteksi.
- **Visibility** — mencatat event serangan ke Analytics Engine, bukan `console.log` yang hilang.

## Untuk siapa

- **Developer & tech enthusiast** yang ingin lapisan keamanan ringan tanpa server tambahan.
- **System administrator / DevSecOps** yang ingin mendeteksi dan mencatat reconnaissance
  sebelum menyentuh origin server.

## Yang bukan tujuan proyek ini

Bangk-Shield bukan pengganti WAF penuh, bukan antivirus, dan bukan jaminan keamanan.
Ia tidak memvalidasi input aplikasi Anda, tidak memperbaiki kerentanan, dan tidak mengenkripsi
trafik. Semua request yang dianggap bukan serangan tetap diteruskan ke origin — termasuk
request berbahaya yang lolos di bawah threshold skor.

:::caution[False positive itu mungkin]
Deteksi berbasis regex dan skor selalu punya kemungkinan false positive. Circuit breaker
bekerja per IP, sehingga pengguna sah di balik NAT kantor atau CGNAT ISP bisa ikut terblokir
jika satu orang memicu lima false positive. Baca [Circuit Breaker](/konsep/circuit-breaker/)
dan [Batas Kemampuan](/referensi/batas-kemampuan/) sebelum mengaktifkannya di situs publik.
:::

## Fitur utama

| Fitur | Ringkasan |
| --- | --- |
| Edge-native | Berjalan di isolate Cloudflare Workers, tanpa server atau container. |
| Rule engine terkompilasi | Regex dikompilasi sekali saat cold start, bukan setiap request. |
| Skor kumulatif | Sinyal-sinyal lemah dapat digabung lewat `combo_bonus`. |
| Multi-vektor | SQLi, RCE, SSRF, LFI, XSS, dan recon dalam satu engine. |
| Fake payload | Response JSON palsu yang berbeda per vektor. |
| Delay acak | Meniru latency server asli agar heuristik scanner tidak curiga. |
| Watermark | Hash `bs1-…` yang dapat diverifikasi ulang oleh pemilik situs. |
| Salt via KV | Salt aktif dan riwayatnya disimpan di Workers KV. |
| Circuit breaker | Membatasi IP yang memicu honeypot berulang dalam waktu singkat. |
| Best-effort logging | Event dikirim ke Analytics Engine tanpa menahan response. |
| Fail-open | Error runtime tidak boleh menghentikan situs asli. |

## Arsitektur singkat

```text
Client / Scanner
      │
      ▼
Cloudflare Worker  ──►  Known-asset check ──► passthrough ke origin
      │
      ├──► Context extraction (path, query, headers, body)
      ├──► Scoring (rule engine in-memory)
      ├──► Circuit breaker (KV, hanya untuk kandidat serangan)
      ├──► Delay + watermark + log
      ▼
Response honeypot palsu
```

Penjelasan lengkap ada di [Arsitektur & Alur Request](/konsep/arsitektur/).

## Status proyek

Versi saat ini: **0.1.0-beta**. Proyek sedang dalam tahap beta dan beberapa bagian PRD
belum diimplementasikan. Daftar lengkap gap antara dokumen dan kode ada di
[Batas Kemampuan](/referensi/batas-kemampuan/).

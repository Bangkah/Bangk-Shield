/**
 * Bangk-Shield Core Engine
 * Edge-based application layer honeypot for Cloudflare Workers.
 *
 * File ini adalah KODE INTI. Bagian yang masih perlu dilengkapi oleh developer
 * lain sebelum deploy, DI LUAR file ini:
 *
 *   1. config/scoring.json   -> lihat kontrak bentuknya di komentar evaluateThreat().
 *   2. config/whitelist.json -> lihat kontrak bentuknya di komentar isWhitelisted().
 *   3. src/responses.json    -> lihat kontrak bentuknya di komentar dekat pemakaian `responses`.
 *   4. wrangler.toml         -> perlu `main = "src/index.js"`, format modules (bukan service-worker),
 *                               `compatibility_date` yang sesuai, dan `[vars] ORIGIN_URL` (lihat §passthrough).
 *   5. Bindings di wrangler.toml (opsional tapi disarankan salah satu):
 *        - `env.ASSETS`           -> untuk serve static asset (Cloudflare Pages Functions).
 *        - `env.ORIGIN_URL`       -> URL origin asli untuk trafik legit (WAJIB diisi kalau tidak
 *                                     pakai ASSETS, lihat catatan penting di passthrough()).
 *        - `env.BANGK_ANALYTICS`  -> Workers Analytics Engine binding, dipakai logger.js.
 *        - `env.BANGK_KV`         -> KV namespace binding, fallback logger.js jika Analytics
 *                                     Engine tidak tersedia/tidak diaktifkan.
 *
 * Ringkasan mekanisme inti:
 * - Body request diperiksa untuk SEMUA method yang membawa body (bukan cuma non-GET/HEAD),
 *   dengan batas ukuran, digabung dengan URL.
 * - URL dan body diperiksa dalam bentuk MENTAH *dan* hasil decode (%-encoding dibongkar),
 *   supaya payload yang di-URL-encode (mis. `union%20select`) tetap terdeteksi.
 * - Regex per-vector di-precompile SEKALI saat cold start (bukan setiap request) untuk
 *   efisiensi CPU time.
 * - Whitelist mendukung path DAN IP.
 * - Logging non-blocking via ctx.waitUntil, tidak bergantung pada console.log saja.
 * - Data yang di-echo ke response (URL, User-Agent) disanitasi & dibatasi panjangnya.
 * - Fail-open: error apapun di try/catch utama -> trafik tetap diteruskan (lewat passthrough,
 *   BUKAN fetch(request) mentah -- lihat catatan penting di passthrough()).
 */

import responses from './responses.json';
import { logEvent } from './logger.js';
import scoringRules from '../config/scoring.json';
import whitelist from '../config/whitelist.json';

// Batas maksimal ukuran teks (URL + body, mentah maupun ter-decode) yang diperiksa,
// untuk mencegah DoS pada regex/keyword matching.
const MAX_INSPECT_BYTES = 16 * 1024; // 16 KB
// Batas panjang string yang di-echo balik ke response (mencegah response raksasa / log injection).
const MAX_ECHO_LENGTH = 500;
// Header penanda internal untuk mencegah forwarding loop (lihat passthrough()).
const LOOP_GUARD_HEADER = 'x-bangk-shield-forwarded';

// -----------------------------------------------------------------------------
// Precompiled regex cache -- dibangun SEKALI saat Worker cold start, bukan per
// request, supaya tidak membakar CPU time untuk kompilasi ulang RegExp yang sama.
// Pattern yang gagal dikompilasi (typo di scoring.json) di-skip dengan warning,
// tidak menggagalkan seluruh Worker.
// -----------------------------------------------------------------------------
const compiledPatternCache = buildPatternCache(scoringRules);

function buildPatternCache(rules) {
  const cache = {};
  for (const [vector, config] of Object.entries(rules.vectors || {})) {
    if (!Array.isArray(config.patterns)) continue;
    cache[vector] = [];
    for (const source of config.patterns) {
      try {
        cache[vector].push(new RegExp(source, 'i'));
      } catch (err) {
        console.error(`[BANGK-SHIELD CONFIG ERROR] Pattern invalid untuk vector "${vector}": ${source}`, err);
      }
    }
  }
  return cache;
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const clientIP = request.headers.get('cf-connecting-ip') || 'Unknown IP';
      const userAgent = request.headers.get('user-agent') || 'Unknown Scanner';

      // 1. Whitelist: aset statis, path, dan IP
      if (isWhitelisted(path, clientIP, whitelist)) {
        return passthrough(request, env);
      }

      // 2. Kumpulkan teks yang diperiksa: URL + body (jika ada), mentah + hasil decode
      const bodyText = await readBodyLimited(request, MAX_INSPECT_BYTES);
      const rawText = `${request.url}\n${bodyText}`;
      const decodedText = safeDecode(rawText);
      // Gabungkan mentah & decoded supaya payload ter-encode (%27, %20, dst.) tetap kena.
      const inspectText = `${rawText}\n${decodedText}`.toLowerCase().slice(0, MAX_INSPECT_BYTES);

      // 3. Evaluasi ancaman berbasis skor (keyword + regex precompiled)
      const evaluation = evaluateThreat(inspectText, scoringRules, compiledPatternCache);

      // 4. Jika melewati threshold, aktifkan honeypot
      if (evaluation.isAttack && evaluation.score >= scoringRules.threshold) {
        // Kontrak src/responses.json yang diharapkan:
        // {
        //   "SQLi": { "roast": "...", "payload": "..." },
        //   "LFI":  { "roast": "...", "payload": "..." }
        //   // key HARUS sama persis dengan nama vector di config/scoring.json
        // }
        // Jika key tidak ditemukan (vector baru belum ada roast-nya), fallback generik dipakai.
        const attackDetails = responses[evaluation.attackType] || {
          attackType: evaluation.attackType,
          roast: 'Mencoba celah baru ya? Kreatif juga!',
          payload: 'status: secured',
        };

        const safeUrl = sanitizeForEcho(request.url, MAX_ECHO_LENGTH);
        const safeUA = sanitizeForEcho(userAgent, MAX_ECHO_LENGTH);

        const responseBody = formatHoneypotResponse({
          url: safeUrl,
          clientIP,
          attackType: evaluation.attackType,
          score: evaluation.score,
          userAgent: safeUA,
          roast: attackDetails.roast,
          payload: attackDetails.payload,
        });

        // Logging non-blocking: tidak menunda response ke penyerang/scanner
        ctx.waitUntil(
          logEvent(env, {
            timestamp: new Date().toISOString(),
            ip: clientIP,
            path,
            attackType: evaluation.attackType,
            score: evaluation.score,
            userAgent: safeUA,
          })
        );

        return new Response(responseBody, {
          status: 200,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'X-Bangk-Shield': 'honeypot-active',
            'X-Attack-Vector': evaluation.attackType,
            'X-Attack-Score': evaluation.score.toString(),
          },
        });
      }

      // 5. Bukan serangan -> teruskan ke origin/backend asli
      return passthrough(request, env);
    } catch (error) {
      // Fail-open: kalau Worker error, jangan blokir trafik legit.
      // PENTING: jangan panggil fetch(request) mentah di sini -- lihat catatan di passthrough().
      console.error('[BANGK-SHIELD ERROR] Failing open due to error:', error);
      try {
        return await passthrough(request, env);
      } catch (fallbackError) {
        console.error('[BANGK-SHIELD ERROR] Passthrough juga gagal:', fallbackError);
        return new Response('Internal Server Error', { status: 500 });
      }
    }
  },
};

/**
 * Meneruskan request ke aset/backend asli.
 *
 * CATATAN PENTING (bug yang pernah terjadi & sudah diperbaiki):
 * Memanggil `fetch(request)` mentah -- yaitu fetch ke URL yang SAMA PERSIS dengan
 * request yang sedang diproses Worker ini -- berisiko membuat Worker memanggil
 * dirinya sendiri secara rekursif (terutama di `wrangler dev` lokal tanpa origin
 * terpisah, atau kalau route Worker overlap dengan domain tujuan fetch). Ini
 * menyebabkan infinite loop, request menumpuk, dan akhirnya 500 Internal Server
 * Error setelah CPU/subrequest limit tercapai -- persis seperti yang terlihat di
 * log testing (/etc/passwd dan /.env berulang-ulang selama puluhan detik).
 *
 * Solusinya:
 * 1. Kalau ada `env.ASSETS` (Cloudflare Pages Functions) -> pakai itu.
 * 2. Kalau ada `env.ORIGIN_URL` -> request DIBANGUN ULANG dengan host origin asli
 *    (bukan host Worker), sehingga tidak akan pernah memanggil balik Worker ini.
 * 3. Kalau TIDAK ADA keduanya (mis. saat dev lokal awal, belum ada backend asli) ->
 *    jangan coba fetch sama sekali. Balas dengan placeholder yang jelas, supaya
 *    developer tahu perlu mengisi ORIGIN_URL, bukan mendapat error membingungkan.
 * 4. Loop-guard header (`x-bangk-shield-forwarded`) sebagai lapisan pertahanan kedua:
 *    kalau request yang sudah pernah diforward oleh Worker ini entah bagaimana masuk
 *    lagi ke handler ini, langsung dihentikan alih-alih diforward lagi.
 */
async function passthrough(request, env) {
  if (request.headers.get(LOOP_GUARD_HEADER)) {
    console.error('[BANGK-SHIELD ERROR] Forwarding loop terdeteksi, request dihentikan.');
    return new Response('Bangk-Shield: forwarding loop detected.', { status: 508 });
  }

  if (env && env.ASSETS) {
    return env.ASSETS.fetch(request);
  }

  if (env && env.ORIGIN_URL) {
    const target = new URL(env.ORIGIN_URL);
    const forwardUrl = new URL(request.url);
    forwardUrl.protocol = target.protocol;
    forwardUrl.hostname = target.hostname;
    forwardUrl.port = target.port;

    const forwardedRequest = new Request(forwardUrl.toString(), request);
    forwardedRequest.headers.set(LOOP_GUARD_HEADER, '1');
    return fetch(forwardedRequest);
  }

  // Tidak ada ASSETS maupun ORIGIN_URL yang dikonfigurasi. Sengaja TIDAK fetch(request)
  // di sini untuk menghindari infinite loop -- lihat catatan panjang di atas.
  return new Response(
    'Bangk-Shield aktif, tapi belum ada ORIGIN_URL atau ASSETS binding yang dikonfigurasi ' +
      'untuk meneruskan trafik legit ini. Isi env var ORIGIN_URL di wrangler.toml, ' +
      'arahkan ke backend asli Anda.',
    { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
  );
}

/**
 * Mendekode teks URL-encoded dengan aman. Kalau encoding-nya malformed
 * (mis. persen tunggal tanpa hex valid di belakangnya), jangan gagalkan
 * seluruh request -- kembalikan string aslinya saja.
 */
function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch (_) {
    return text;
  }
}

/**
 * Memeriksa apakah path, ekstensi statis, atau IP masuk whitelist.
 *
 * Kontrak `config/whitelist.json` yang diharapkan:
 * {
 *   "paths": ["/api/health", "/favicon.ico"],   // prefix match, opsional
 *   "ips":   ["203.0.113.10"]                    // exact match, opsional
 * }
 * Kedua field opsional; jika tidak ada, dianggap array kosong sebelum dipakai
 * (kode ini sudah defensif terhadap field yang undefined).
 */
function isWhitelisted(path, clientIP, whitelistConfig) {
  const staticExtensions = ['.js', '.css', '.svg', '.png', '.ico', '.jpg', '.woff', '.woff2'];
  if (staticExtensions.some((ext) => path.endsWith(ext))) {
    return true;
  }
  if (whitelistConfig.paths && whitelistConfig.paths.some((p) => path.startsWith(p))) {
    return true;
  }
  if (whitelistConfig.ips && whitelistConfig.ips.includes(clientIP)) {
    return true;
  }
  return false;
}

/**
 * Membaca body request hingga batas ukuran tertentu, tanpa memuat body raksasa
 * sepenuhnya ke memori. Diperiksa untuk SEMUA method yang membawa body (termasuk
 * GET dengan body non-standar dari client yang longgar) -- bukan cuma method
 * selain GET/HEAD -- untuk proteksi maksimal terhadap body injection.
 */
async function readBodyLimited(request, maxBytes) {
  if (!request.body) {
    return '';
  }

  let reader;
  try {
    reader = request.clone().body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let result = '';

    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      result += decoder.decode(value, { stream: true });
    }
    // Flush sisa buffer decoder (mis. karakter multi-byte yang terpotong di batas chunk)
    result += decoder.decode();
    return result.slice(0, maxBytes);
  } catch (_) {
    // Body tidak terbaca (mis. sudah dikonsumsi) -> anggap kosong, jangan gagalkan request
    return '';
  } finally {
    // Await cancel supaya benar-benar selesai sebelum function ini resolve --
    // mencegah race condition/memory leak di V8 isolate pada trafik tinggi.
    if (reader) {
      try {
        await reader.cancel();
      } catch (_) {
        /* no-op */
      }
    }
  }
}

/**
 * Mengevaluasi ancaman berdasarkan keyword dan regex precompiled per-vector.
 *
 * Kontrak `config/scoring.json` yang diharapkan:
 * {
 *   "threshold": 5,
 *   "vectors": {
 *     "SQLi": {
 *       "weight": 5,
 *       "keywords": ["union select", "' or 1=1", "sleep("],
 *       "patterns": ["(\\%27)|(\\')|(\\-\\-)"]   // opsional, regex source string (tanpa delimiter /)
 *     },
 *     "LFI": {
 *       "weight": 4,
 *       "keywords": ["../", "etc/passwd"],
 *       "patterns": ["(\\.\\./){2,}"]
 *     }
 *     // ... vector lain: RCE, SSRF, XSS, Recon, dst.
 *   }
 * }
 * Catatan untuk yang mengisi `patterns`: hindari nested quantifier seperti (a+)+ atau
 * (a|aa)+ yang rawan catastrophic backtracking (ReDoS). Uji tiap pattern dengan
 * `safe-regex` atau tool sejenis sebelum dimasukkan ke config ini.
 */
function evaluateThreat(inspectText, scoringRules, patternCache) {
  let totalScore = 0;
  let detectedVector = 'Unknown Reconnaissance';
  let highestWeight = 0;

  for (const [vector, config] of Object.entries(scoringRules.vectors)) {
    let matched = false;

    if (config.keywords && config.keywords.some((kw) => inspectText.includes(kw))) {
      matched = true;
    }

    if (!matched && Array.isArray(patternCache[vector])) {
      for (const regex of patternCache[vector]) {
        if (regex.test(inspectText)) {
          matched = true;
          break;
        }
      }
    }

    if (matched) {
      totalScore += config.weight;
      if (config.weight > highestWeight) {
        highestWeight = config.weight;
        detectedVector = vector;
      }
    }
  }

  return {
    isAttack: totalScore > 0,
    score: totalScore,
    attackType: detectedVector,
  };
}

/**
 * Membersihkan string sebelum di-echo balik ke response: buang karakter kontrol
 * (termasuk CR/LF yang bisa dipakai untuk log/response injection) dan batasi panjang.
 */
function sanitizeForEcho(value, maxLength) {
  const stripped = String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .trim();
  return stripped.length > maxLength ? `${stripped.slice(0, maxLength)}...[truncated]` : stripped;
}

/**
 * Format teks respons honeypot agar rapi dan interaktif.
 */
function formatHoneypotResponse(data) {
  return `
============================================================
[BANGK-SHIELD VIRTUAL LAB - SECURITY SYSTEM]
============================================================
Target URL   : ${data.url}
Client IP    : ${data.clientIP}
Attack Vector: ${data.attackType}
Threat Score : ${data.score}
User-Agent   : ${data.userAgent}
Timestamp    : ${new Date().toISOString()}
------------------------------------------------------------
${data.roast}

[SIMULATED SERVER RESPONSE]:
${data.payload}

[LOGGED TO BANGK-SHIELD DASHBOARD]:
Aktivitas tercatat dan dianalisis di edge.
HACKER TIDUR, BESOK NYARI TOOL LAGI!
============================================================
`;
}
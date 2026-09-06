/**
 * Bangk-Shield Core Engine
 * Edge-based application layer honeypot for Cloudflare Workers.
 */

import responses from './responses.json';
import { logEvent } from './logger.js';
import scoringRules from '../config/scoring.json';
import whitelist from '../config/whitelist.json';

const MAX_INSPECT_BYTES = 16 * 1024; // Batas maksimal teks (URL + body) untuk mencegah DoS
const MAX_ECHO_LENGTH = 500;        // Batas panjang string yang di-echo untuk keamanan

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const clientIP = request.headers.get('cf-connecting-ip') || 'Unknown IP';
      const userAgent = request.headers.get('user-agent') || 'Unknown Scanner';

      // 1. Lewati honeypot jika request masuk dalam whitelist (path, ekstensi statis, atau IP)
      if (isWhitelisted(path, clientIP, whitelist)) {
        return passthrough(request, env);
      }

      // 2. Ambil dan batasi ukuran teks dari URL serta body request untuk dianalisis
      const bodyText = await readBodyLimited(request, MAX_INSPECT_BYTES);
      const inspectText = `${request.url}\n${bodyText}`.toLowerCase().slice(0, MAX_INSPECT_BYTES);

      // 3. Evaluasi ancaman berdasarkan sistem skor (mengacu ke config/scoring.json)
      const evaluation = evaluateThreat(inspectText, scoringRules);

      // 4. Jika skor ancaman melewati threshold, aktifkan respons honeypot
      if (evaluation.isAttack && evaluation.score >= scoringRules.threshold) {
        // Ambil pesan roasting & payload dari responses.json (dengan fallback jika tidak ditemukan)
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

        // Catat log secara non-blocking agar tidak memperlambat respons ke penyerang
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

      // 5. Jika aman, teruskan trafik ke backend/origin asli
      return passthrough(request, env);
    } catch (error) {
      // Mekanisme Fail-open: jika terjadi error fatal, pastikan trafik legit tidak terblokir
      console.error('[BANGK-SHIELD ERROR] Failing open due to error:', error);
      return fetch(request);
    }
  },
};

/**
 * Meneruskan request ke aset statis Cloudflare Pages atau fetch normal ke origin.
 */
function passthrough(request, env) {
  if (env && env.ASSETS) {
    return env.ASSETS.fetch(request);
  }
  return fetch(request);
}

/**
 * Memeriksa apakah path, ekstensi file statis, atau IP pengirim masuk dalam daftar whitelist.
 */
function isWhitelisted(path, clientIP, whitelistConfig) {
  const staticExtensions = ['.js', '.css', '.svg', '.png', '.ico', '.jpg', '.woff', '.woff2'];
  if (staticExtensions.some((ext) => path.endsWith(ext))) return true;
  if (whitelistConfig.paths && whitelistConfig.paths.some((p) => path.startsWith(p))) return true;
  if (whitelistConfig.ips && whitelistConfig.ips.includes(clientIP)) return true;
  return false;
}

/**
 * Membaca body request secara aman hingga batas ukuran tertentu (mencegah beban memori berlebih).
 */
async function readBodyLimited(request, maxBytes) {
  if (!request.body || request.method === 'GET' || request.method === 'HEAD') {
    return '';
  }

  try {
    const reader = request.clone().body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let result = '';

    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();

    try { reader.cancel(); } catch (_) {}
    return result.slice(0, maxBytes);
  } catch (_) {
    return '';
  }
}

/**
 * Mengevaluasi tingkat ancaman berdasarkan keyword dan regex yang terdaftar di scoring.json.
 */
function evaluateThreat(inspectText, scoringRules) {
  let totalScore = 0;
  let detectedVector = 'Unknown Reconnaissance';
  let highestWeight = 0;

  for (const [vector, config] of Object.entries(scoringRules.vectors)) {
    let matched = false;

    // Cek kecocokan keyword sederhana (murah dan cepat)
    if (config.keywords && config.keywords.some((kw) => inspectText.includes(kw))) {
      matched = true;
    }

    // Cek kecocokan regex jika keyword tidak ditemukan
    if (!matched && Array.isArray(config.patterns)) {
      for (const patternSource of config.patterns) {
        try {
          const regex = new RegExp(patternSource, 'i');
          if (regex.test(inspectText)) {
            matched = true;
            break;
          }
        } catch (_) {
          continue; // Lewati regex jika format di config tidak valid
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
 * Membersihkan string dari karakter kontrol untuk mencegah response/log injection.
 */
function sanitizeForEcho(value, maxLength) {
  const stripped = String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .trim();
  return stripped.length > maxLength ? `${stripped.slice(0, maxLength)}...[truncated]` : stripped;
}

/**
 * Mengatur format teks balasan honeypot yang akan dikirim ke penyerang.
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
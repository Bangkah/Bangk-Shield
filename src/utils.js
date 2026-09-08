/**
 * Bangk-Shield Utils
 * Helper kecil yang dipakai index.js: known-asset check, pembacaan body
 * dengan batas ukuran, sanitasi teks yang di-echo, passthrough ke origin,
 * dan dekode URL yang aman terhadap input malformed.
 */

const LOOP_GUARD_HEADER = 'x-bangk-shield-forwarded';
const STATIC_EXTENSIONS = ['.js', '.css', '.svg', '.png', '.ico', '.jpg', '.woff', '.woff2'];

/**
 * Mendekode teks URL-encoded dengan aman. Exception apapun dari
 * decodeURIComponent (termasuk kasus "%" tunggal / malformed encoding)
 * tertangkap generik -- fallback ke teks asli, tidak pernah melempar ke atas.
 */
export function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch (_) {
    return text;
  }
}

/**
 * Cek known-asset: ekstensi statis, exact path, prefix path, atau IP -- dari
 * cache in-memory yang dibangun sekali di index.js (bukan re-parsing tiap
 * request).
 */
export function isKnownAsset(path, clientIP, knownAssetExact, knownAssetPrefixes, whitelistIps) {
  if (STATIC_EXTENSIONS.some((ext) => path.endsWith(ext))) return true;
  if (knownAssetExact.has(path)) return true;
  if (knownAssetPrefixes.some((prefix) => path.startsWith(prefix))) return true;
  if (whitelistIps && whitelistIps.includes(clientIP)) return true;
  return false;
}

/**
 * Membaca body request hingga batas ukuran tertentu, tanpa memuat body raksasa
 * sepenuhnya ke memori. `request.clone()` dipakai supaya body ASLI tetap utuh
 * untuk diteruskan ke origin lewat passthrough() setelah pemeriksaan selesai
 * (bukan overhead yang bisa dihindari -- ini kebutuhan desain, lihat README).
 */
export async function readBodyLimited(request, maxBytes) {
  if (!request.body) return '';

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
    result += decoder.decode(); // flush sisa buffer multi-byte
    return result.slice(0, maxBytes);
  } catch (_) {
    return '';
  } finally {
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
 * Membersihkan string sebelum di-echo balik ke response (URL, User-Agent):
 * buang karakter kontrol (termasuk CR/LF yang bisa dipakai untuk response
 * injection) dan batasi panjang.
 */
export function sanitizeForEcho(value, maxLength) {
  const stripped = String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .trim();
  return stripped.length > maxLength ? `${stripped.slice(0, maxLength)}...[truncated]` : stripped;
}

export function getRandomItem(arr) {
  if (!arr || arr.length === 0) return 'No roast found.';
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Meneruskan request ke origin asli.
 *
 * CATATAN PENTING: jangan pernah fetch(request) mentah ke URL yang sama persis
 * dengan request yang sedang diproses -- itu bisa membuat Worker memanggil
 * dirinya sendiri secara rekursif (terutama di `wrangler dev` lokal tanpa
 * origin terpisah), menyebabkan infinite loop dan 500 error. Karena itu:
 *   1. env.ASSETS tersedia -> pakai itu (Cloudflare Pages Functions).
 *   2. env.ORIGIN_URL tersedia -> request DIBANGUN ULANG dengan host origin asli.
 *   3. Tidak ada keduanya -> jangan fetch sama sekali, balas placeholder jelas.
 *   4. Loop-guard header sebagai lapisan pertahanan kedua.
 */
export async function passthrough(request, env) {
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

  return new Response(
    'Bangk-Shield aktif, tapi belum ada ORIGIN_URL atau ASSETS binding yang dikonfigurasi ' +
      'untuk meneruskan trafik legit ini. Isi env var ORIGIN_URL di wrangler.toml.',
    { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
  );
}

export async function passthroughSafe(request, env) {
  try {
    return await passthrough(request, env);
  } catch (_) {
    return new Response('Internal Server Error', { status: 500 });
  }
}

export function formatHoneypotResponse(data) {
  return `
============================================================
[BANGK-SHIELD VIRTUAL LAB - SECURITY SYSTEM]
============================================================
Target URL   : ${data.url}
Client IP    : ${data.clientIP}
Attack Vector: ${data.attackType}
Threat Score : ${data.score}
User-Agent   : ${data.userAgent}
Watermark    : ${data.watermark}
------------------------------------------------------------
${data.roast}

[SIMULATED SERVER RESPONSE]:
${data.payload}
============================================================
`;
}
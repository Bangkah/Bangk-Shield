/**
 * Bangk-Shield Watermark
 * Menghasilkan hash yang bisa diverifikasi ulang oleh pemilik situs, untuk
 * membuktikan sebuah screenshot response honeypot itu asli dari Bangk-Shield.
 *
 * FORMAT (sesuai PRD Beta §3.4.1 -- test vector CI bergantung pada persisnya ini):
 *   Canonical : "bangk-shield/v1|<ip>|<ua>|<yyyy-mm-dd>|<salt>"
 *   Output    : "bs1-<16 hex pertama dari SHA-256(canonical)>"
 *
 * BENTUK DATA SALT DI KV (sesuai PRD Beta §3.4.1, ditulis oleh scripts/rotate-salt.cjs):
 *   wm:salt:current -> objek JSON  { "salt": "...", "since": "<ISO date>" }
 *   wm:salt:history -> array objek [{ "salt": "...", "since": "...", "until": "..." }, ...]
 *
 *   Perbaikan dari draft sebelumnya: kode lama memperlakukan nilai KV sebagai
 *   STRING POLOS (dipakai langsung sebagai salt). Begitu rotate-salt.cjs mulai
 *   menulis objek sesuai PRD Beta, itu akan membuat resolveSalt() memakai string
 *   JSON utuh sebagai salt -> semua watermark salah secara diam-diam. Parsing
 *   di bawah ini TOLERAN terhadap dua bentuk (objek baru & string lama) supaya
 *   aman selama masa migrasi, tapi bentuk objek adalah yang seharusnya dipakai.
 */

const DEFAULT_DEV_SALT = 'default-dev-salt';
const WATERMARK_VERSION = 'v1';
const WATERMARK_PREFIX = 'bs1-';

/**
 * Ekstrak nilai salt dari satu entri KV, toleran terhadap:
 *   - objek { salt, since }               (bentuk PRD Beta, current)
 *   - objek { salt, since, until }         (bentuk PRD Beta, history)
 *   - string polos                         (bentuk lama, untuk kompatibilitas migrasi)
 */
function extractSaltValue(raw) {
  if (typeof raw === 'string') {
    // Coba parse sebagai JSON dulu (bentuk PRD Beta); kalau gagal, anggap string salt polos
    // (bentuk lama, kompatibilitas migrasi).
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && typeof parsed.salt === 'string') {
        return parsed.salt;
      }
      return raw; // JSON valid tapi bukan bentuk yang diharapkan -> anggap salt polos
    } catch (_) {
      return raw; // bukan JSON sama sekali -> string salt polos (bentuk lama)
    }
  }
  if (raw && typeof raw === 'object' && typeof raw.salt === 'string') {
    return raw.salt;
  }
  return null;
}

/**
 * Mengembalikan { salt, source } -- `source` dipakai index.js untuk memutuskan
 * apakah perlu mencatat event "salt_fallback" ke Analytics Engine (modul ini
 * sendiri tidak punya akses `ctx.waitUntil`, jadi kebijakan logging-nya di
 * index.js, bukan di sini).
 */
export async function resolveSalt(env) {
  if (env && env.BANGK_KV) {
    try {
      const kvRaw = await env.BANGK_KV.get('wm:salt:current');
      const kvSalt = kvRaw ? extractSaltValue(kvRaw) : null;
      if (kvSalt) return { salt: kvSalt, source: 'kv' };
    } catch (_) {
      // KV error -> lanjut ke fallback berikutnya, jangan gagalkan request
    }
  }
  if (env && env.WATERMARK_SALT) {
    return { salt: env.WATERMARK_SALT, source: 'env' };
  }
  return { salt: DEFAULT_DEV_SALT, source: 'default' };
}

/**
 * Verifikasi mundur (dipakai admin dashboard nantinya): coba cocokkan watermark
 * terhadap salt aktif DAN riwayat salt (wm:salt:history) supaya watermark lama
 * tetap valid setelah rotasi.
 */
export async function resolveSaltCandidates(env) {
  const current = await resolveSalt(env);
  const candidates = [current.salt];

  if (env && env.BANGK_KV) {
    try {
      const historyRaw = await env.BANGK_KV.get('wm:salt:history');
      if (historyRaw) {
        const history = JSON.parse(historyRaw);
        if (Array.isArray(history)) {
          for (const entry of history) {
            const saltValue = extractSaltValue(entry);
            if (saltValue) candidates.push(saltValue);
          }
        }
      }
    } catch (_) {
      /* riwayat tidak terbaca -> abaikan, tetap pakai salt aktif saja */
    }
  }
  return candidates;
}

export async function generateWatermark(ip, ua, salt) {
  const dateStr = new Date().toISOString().split('T')[0];
  const canonical = `bangk-shield/${WATERMARK_VERSION}|${ip}|${ua}|${dateStr}|${salt}`;

  const data = new TextEncoder().encode(canonical);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return `${WATERMARK_PREFIX}${hashHex.slice(0, 16)}`;
}
/**
 * Bangk-Shield Watermark
 * Menghasilkan hash yang bisa diverifikasi ulang oleh pemilik situs, untuk
 * membuktikan sebuah screenshot response honeypot itu asli dari Bangk-Shield.
 *
 * PENTING (perbaikan dari draft awal): PRD §3.4 menyebut salt dikelola lewat
 * Workers KV (`wm:salt:current`) supaya bisa dirotasi tanpa redeploy. Kode
 * sebelumnya cuma baca `env.WATERMARK_SALT` (env var statis) -- fitur rotasi
 * yang dijanjikan tidak benar-benar tersambung. Di sini urutannya:
 *   1. env.BANGK_KV -> key "wm:salt:current" (sumber utama, bisa dirotasi live)
 *   2. env.WATERMARK_SALT (env var, fallback kalau KV tidak diaktifkan/gagal)
 *   3. 'default-dev-salt' (fallback terakhir untuk dev lokal tanpa setup apapun)
 */

const DEFAULT_DEV_SALT = 'default-dev-salt';

export async function resolveSalt(env) {
  if (env && env.BANGK_KV) {
    try {
      const kvSalt = await env.BANGK_KV.get('wm:salt:current');
      if (kvSalt) return kvSalt;
    } catch (_) {
      // KV error -> lanjut ke fallback berikutnya, jangan gagalkan request
    }
  }
  return (env && env.WATERMARK_SALT) || DEFAULT_DEV_SALT;
}

/**
 * Verifikasi mundur (dipakai admin dashboard nantinya): coba cocokkan watermark
 * terhadap salt aktif DAN riwayat salt (wm:salt:history, array JSON string)
 * supaya watermark lama tetap valid setelah rotasi.
 */
export async function resolveSaltCandidates(env) {
  const candidates = [await resolveSalt(env)];
  if (env && env.BANGK_KV) {
    try {
      const historyRaw = await env.BANGK_KV.get('wm:salt:history');
      if (historyRaw) {
        const history = JSON.parse(historyRaw);
        if (Array.isArray(history)) candidates.push(...history);
      }
    } catch (_) {
      /* riwayat tidak terbaca -> abaikan, tetap pakai salt aktif saja */
    }
  }
  return candidates;
}

export async function generateWatermark(ip, ua, salt) {
  const dateStr = new Date().toISOString().split('T')[0];
  const canonical = `bangk-shield|${ip}|${ua}|${dateStr}|${salt}`;

  const data = new TextEncoder().encode(canonical);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return `bs-${hashHex.slice(0, 16)}`;
}
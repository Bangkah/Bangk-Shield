/**
 * Bangk-Shield Rate Limit & Circuit Breaker
 * Melindungi kuota CPU Worker dari IP yang memicu honeypot berulang-ulang
 * dalam waktu singkat. Berbasis Workers KV -- BUKAN counter atomik presisi
 * (keterbatasan KV), cukup untuk anti-abuse ringan, bukan rate limit ketat.
 *
 * Fail-open: kalau KV tidak tersedia/error, sirkuit dianggap TIDAK terbuka
 * (isBlocked: false) -- rate limit gagal jangan sampai memblokir trafik.
 */

const STRIKE_TTL_SECONDS = 60;
const STRIKE_THRESHOLD = 5;

export async function checkCircuitBreaker(ip, kv) {
  if (!kv) return { isBlocked: false };
  try {
    const strikes = await kv.get(`strike:${ip}`);
    return { isBlocked: Boolean(strikes) && parseInt(strikes, 10) >= STRIKE_THRESHOLD };
  } catch (_) {
    return { isBlocked: false };
  }
}

export async function recordStrike(ip, kv) {
  if (!kv) return;
  try {
    const key = `strike:${ip}`;
    const currentRaw = await kv.get(key);
    const current = currentRaw ? parseInt(currentRaw, 10) : 0;
    await kv.put(key, String(current + 1), { expirationTtl: STRIKE_TTL_SECONDS });
  } catch (_) {
    /* fail-open: gagal mencatat strike tidak boleh mengganggu response utama */
  }
}
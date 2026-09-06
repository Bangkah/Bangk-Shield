/**
 * Bangk-Shield Logger
 * Abstraksi logging supaya event honeypot tidak hilang begitu saja (console.log
 * di Cloudflare Workers bersifat ephemeral tanpa Logpush/Tail aktif).
 *
 * Prioritas backend (dipakai yang tersedia di `env`, tanpa perlu diubah di index.js):
 * 1. Workers Analytics Engine (binding: env.BANGK_ANALYTICS) - cocok untuk volume tinggi.
 * 2. Workers KV (binding: env.BANGK_KV) - fallback sederhana, cukup untuk MVP kecil.
 * 3. console.log - fallback terakhir jika tidak ada binding sama sekali (mis. saat dev lokal).
 */

export async function logEvent(env, data) {
  try {
    if (env && env.BANGK_ANALYTICS && typeof env.BANGK_ANALYTICS.writeDataPoint === 'function') {
      env.BANGK_ANALYTICS.writeDataPoint({
        blobs: [data.ip, data.path, data.attackType, data.userAgent],
        doubles: [data.score],
        indexes: [data.attackType],
      });
      return;
    }

    if (env && env.BANGK_KV) {
      // Key unik per event supaya tidak saling menimpa: timestamp + random suffix
      const key = `event:${data.timestamp}:${Math.random().toString(36).slice(2, 8)}`;
      await env.BANGK_KV.put(key, JSON.stringify(data), {
        // Simpan 30 hari saja secara default supaya KV tidak membengkak tanpa batas
        expirationTtl: 60 * 60 * 24 * 30,
      });
      return;
    }

    // Fallback terakhir: minimal masih terlihat di `wrangler tail` saat development
    console.log('[BANGK-SHIELD LOG]', JSON.stringify(data));
  } catch (error) {
    // Logging tidak boleh pernah menggagalkan request utama
    console.error('[BANGK-SHIELD LOGGER ERROR]', error);
  }
}
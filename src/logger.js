/**
 * Bangk-Shield Logger (Best-Effort Analytics)
 * Menulis event serangan ke Workers Analytics Engine. API ini fire-and-forget,
 * jadi kegagalan penulisan (kuota habis, dsb.) TIDAK BOLEH mengganggu response
 * ke klien -- selalu dipanggil lewat ctx.waitUntil() oleh index.js.
 *
 * Sampling: event dengan skor rendah (di bawah SAMPLING_SCORE_THRESHOLD)
 * di-sampling sebagian saja untuk menghemat kuota harian paket gratis,
 * sesuai PRD §3.5.
 */

const SAMPLING_SCORE_THRESHOLD = 30;
const SAMPLING_RATE = 0.2; // 20% dari event skor rendah yang benar-benar ditulis

export async function logEventBestEffort(env, event) {
  if (!env || !env.BANGK_ANALYTICS) return;

  const isLowScore = typeof event.score === 'number' && event.score < SAMPLING_SCORE_THRESHOLD;
  const dropped = isLowScore && Math.random() > SAMPLING_RATE;
  if (dropped) return; // dilewati karena sampling, bukan error

  try {
    env.BANGK_ANALYTICS.writeDataPoint({
      blobs: [event.ip || '', event.path || '', event.vector || '', String(Boolean(dropped))],
      doubles: [typeof event.score === 'number' ? event.score : 0],
      indexes: [event.vector || 'unknown'],
    });
  } catch (err) {
    // Fire-and-forget: catat kegagalan di console (terlihat lewat `wrangler tail`),
    // tapi jangan lempar error ke pemanggil.
    console.error('[BANGK-SHIELD LOGGER] Analytics write failed:', err);
  }
}
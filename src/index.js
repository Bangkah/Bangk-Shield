/**
 * Bangk-Shield Core Engine (Beta)
 * Edge-based application layer honeypot for Cloudflare Workers.
 *
 * File ini murni orkestrasi -- logic sesungguhnya ada di modul terpisah
 * sesuai struktur PRD Beta §4:
 *   - src/scanner.js    -> compile rules & evaluasi skor (evaluateThreat)
 *   - src/ratelimit.js  -> circuit breaker berbasis KV
 *   - src/watermark.js  -> derivasi hash watermark + resolusi salt dari KV
 *   - src/logger.js     -> logging best-effort ke Analytics Engine
 *   - src/utils.js      -> whitelist check, baca body, sanitasi, passthrough
 *
 * WAJIB dijalankan sebelum dev/deploy: `npm run build:rules` (menghasilkan
 * src/rules.compiled.json dari config/rules.json -- lihat scripts/build-rules.js).
 * Ini otomatis terpanggil lewat predev/predeploy di package.json.
 */

import compiledRules from './rules.compiled.json';
import whitelist from '../config/whitelist.json';
import { compileRules, evaluateThreat } from './scanner.js';
import { checkCircuitBreaker, recordStrike } from './ratelimit.js';
import { resolveSalt, generateWatermark } from './watermark.js';
import { logEventBestEffort } from './logger.js';
import {
  safeDecode,
  isKnownAsset,
  readBodyLimited,
  sanitizeForEcho,
  getRandomItem,
  passthrough,
  passthroughSafe,
  formatHoneypotResponse,
} from './utils.js';

const MAX_INSPECT_BYTES = compiledRules.global?.body_scan_limit_bytes || 16384;
const SCORE_THRESHOLD = compiledRules.global?.score_threshold || 50;

// ============================================================================
// MODULE SCOPE INITIALIZATION (Compile-Once, saat cold start -- bukan per request)
// ============================================================================
const knownAssetExact = new Set(whitelist.paths || []);
const knownAssetPrefixes = whitelist.prefixes || ['/assets/', '/static/'];
const ruleEngine = compileRules(compiledRules.vectors || []);

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const clientIP = request.headers.get('cf-connecting-ip') || 'Unknown IP';
      const userAgent = request.headers.get('user-agent') || 'Unknown Scanner';

      // 1. Path Classification & Known-Asset Cache
      if (isKnownAsset(path, clientIP, knownAssetExact, knownAssetPrefixes, whitelist.ips)) {
        return passthrough(request, env);
      }

      // 2. Context Extraction & Scoring -- dilakukan SEBELUM circuit breaker (KV).
      //    (Perbaikan urutan dari draft sebelumnya: CB check butuh `await` ke KV dan
      //    dulu dipanggil untuk SETIAP request non-whitelist, termasuk yang ternyata
      //    legit -- menambah latensi+biaya KV ke mayoritas trafik yang tidak bersalah.
      //    Scoring murni in-memory/CPU, tidak ada I/O, jadi dikerjakan dulu; KV baru
      //    disentuh kalau memang terdeteksi sebagai kandidat serangan di langkah 3.)
      //
      //    PENTING: path WAJIB ada di context, karena signal seperti "/etc/passwd"
      //    atau "/.env" ada di pathname, bukan query string. (Bug ini pernah bikin
      //    semua deteksi path-based gagal total di draft sebelumnya -- lihat §Changelog.)
      const context = {
        path: safeDecode(path).toLowerCase(),
        query: safeDecode(url.search).toLowerCase(),
        headers: userAgent.toLowerCase(),
        body: '',
      };

      if (isTextContent(request.headers.get('content-type'))) {
        const bodyRaw = await readBodyLimited(request, MAX_INSPECT_BYTES);
        context.body = safeDecode(bodyRaw).toLowerCase();
      }

      const evaluation = evaluateThreat(context, ruleEngine);

      // Bukan kandidat serangan -> selesai di sini, TIDAK ADA panggilan KV sama sekali.
      if (!evaluation.isAttack || evaluation.score < SCORE_THRESHOLD) {
        return passthrough(request, env);
      }

      // 3. Circuit Breaker (KV) -- baru dicek di sini, HANYA untuk request yang
      //    sudah lolos scoring sebagai kandidat serangan. IP yang sudah terlalu
      //    sering memicu honeypot langsung dapat respons statis murah, tanpa
      //    delay/watermark/payload lanjutan.
      //
      //    Toggle CIRCUIT_BREAKER_ENABLED (env var, default aktif): matikan kalau
      //    situs Anda rawan false-positive dari IP yang dipakai bersama banyak
      //    pengguna (kantor/CGNAT ISP) -- blocking berbasis IP bisa mengenai semua
      //    orang di belakang IP publik yang sama. Lihat README §9 Known Limitations.
      const circuitBreakerEnabled = env.CIRCUIT_BREAKER_ENABLED !== 'false';
      if (circuitBreakerEnabled) {
        const cbStatus = await checkCircuitBreaker(clientIP, env.BANGK_KV);
        if (cbStatus.isBlocked) {
          ctx.waitUntil(
            logEventBestEffort(env, { ip: clientIP, path, vector: 'circuit_breaker_block', score: 0 })
          );
          return new Response('Blocked by Circuit Breaker', {
            status: 403,
            headers: { 'X-Bangk-Shield': 'honeypot-active-cb' },
          });
        }
      }

      // 4. Honeypot Trigger & Deception
      if (circuitBreakerEnabled) {
        ctx.waitUntil(recordStrike(clientIP, env.BANGK_KV));
      }

      // Delay realistis (deception) -- lihat trade-off latency di README §NFR.
      const delayRange = evaluation.vectorDef.fake_payload?.delay_ms || [100, 300];
      const delay = Math.floor(Math.random() * (delayRange[1] - delayRange[0] + 1)) + delayRange[0];
      await new Promise((resolve) => setTimeout(resolve, delay));

      const { salt, source: saltSource } = await resolveSalt(env);
      const watermark = await generateWatermark(clientIP, userAgent, salt);

      // salt_fallback event (PRD Beta §3.4.1): dicatat di sini, bukan di watermark.js,
      // karena modul itu tidak punya akses ctx.waitUntil.
      if (saltSource !== 'kv') {
        ctx.waitUntil(logEventBestEffort(env, { ip: clientIP, path, vector: 'salt_fallback', score: 0 }));
      }

      ctx.waitUntil(
        logEventBestEffort(env, {
          ip: clientIP,
          path,
          vector: evaluation.attackType,
          score: evaluation.score,
        })
      );

      const responseBody = formatHoneypotResponse({
        url: sanitizeForEcho(request.url, 500),
        clientIP,
        attackType: evaluation.attackType,
        score: evaluation.score,
        userAgent: sanitizeForEcho(userAgent, 500),
        roast: getRandomItem(evaluation.vectorDef.roast),
        payload: JSON.stringify(evaluation.vectorDef.fake_payload?.body || { status: 'blocked' }, null, 2),
        watermark,
      });

      return new Response(responseBody, {
        status: evaluation.vectorDef.default_fake_status || 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Bangk-Shield': 'honeypot-active',
          'X-Bangk-Shield-Watermark': watermark,
        },
      });
    } catch (error) {
      console.error('[BANGK-SHIELD ERROR] Failing open:', error);
      try {
        ctx.waitUntil(logEventBestEffort(env, { vector: 'engine_error', path: new URL(request.url).pathname }));
      } catch (_) {
        /* logging pun gagal -> abaikan, fail-open tetap prioritas */
      }
      return passthroughSafe(request, env);
    }
  },
};

function isTextContent(contentType) {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return ct.includes('json') || ct.includes('form') || ct.includes('text');
}
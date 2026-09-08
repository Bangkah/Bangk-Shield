/// <reference types="@cloudflare/workers-types" />
import compiledRules from '../src/rules.compiled.json' with { type: 'json' };
import whitelist from '../config/whitelist.json' with { type: 'json' };
import { compileRules, evaluateThreat } from '../src/scanner.js';
import { checkCircuitBreaker, recordStrike } from '../src/ratelimit.js';
import { resolveSalt, generateWatermark } from '../src/watermark.js';
import { logEventBestEffort } from '../src/logger.js';
import {
  safeDecode,
  isKnownAsset,
  readBodyLimited,
  sanitizeForEcho,
  getRandomItem,
  passthrough,
  passthroughSafe,
  formatHoneypotResponse,
} from '../src/utils.js';

export interface ShieldOptions {
  scoreThreshold?: number;
  originUrl?: string;
}

const MAX_INSPECT_BYTES = (compiledRules as any).global?.body_scan_limit_bytes || 16384;
const DEFAULT_THRESHOLD = (compiledRules as any).global?.score_threshold || 50;
const knownAssetExact = new Set(whitelist.paths || []);
const knownAssetPrefixes = whitelist.prefixes || ['/assets/', '/static/'];
const ruleEngine = compileRules((compiledRules as any).vectors || []);

function isTextContent(contentType: string | null): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return ct.includes('json') || ct.includes('form') || ct.includes('text');
}

export async function bangkShield(
  request: Request,
  env: any,
  ctx: ExecutionContext,
  options: ShieldOptions = {}
) {
  try {
    const url = new URL(request.url);
    const path = url.pathname;
    const clientIP = request.headers.get('cf-connecting-ip') || 'Unknown IP';
    const userAgent = request.headers.get('user-agent') || 'Unknown Scanner';

    // 1. Path Classification & Known-Asset Check
    if (isKnownAsset(path, clientIP, knownAssetExact, knownAssetPrefixes, whitelist.ips)) {
      if (options.originUrl) {
        const targetUrl = new URL(url.pathname + url.search, options.originUrl);
        return fetch(new Request(targetUrl, request));
      }
      return null;
    }

    // 2. Context Extraction & Scoring
    const context: any = {
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
    const threshold = options.scoreThreshold ?? DEFAULT_THRESHOLD;

    if (!evaluation.isAttack || evaluation.score < threshold) {
      if (options.originUrl) {
        const targetUrl = new URL(url.pathname + url.search, options.originUrl);
        return fetch(new Request(targetUrl, request));
      }
      return null;
    }

    // 3. Circuit Breaker (KV)
    const circuitBreakerEnabled = env.CIRCUIT_BREAKER_ENABLED !== 'false';
    if (env.BANGK_KV && circuitBreakerEnabled) {
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
    if (env.BANGK_KV && circuitBreakerEnabled) {
      ctx.waitUntil(recordStrike(clientIP, env.BANGK_KV));
    }

    const delayRange = evaluation.vectorDef.fake_payload?.delay_ms || [100, 300];
    const delay = Math.floor(Math.random() * (delayRange[1] - delayRange[0] + 1)) + delayRange[0];
    await new Promise((resolve) => setTimeout(resolve, delay));

    const { salt, source: saltSource } = await resolveSalt(env);
    const watermark = await generateWatermark(clientIP, userAgent, salt);

    if (saltSource !== 'kv') {
      ctx.waitUntil(
        logEventBestEffort(env, { ip: clientIP, path, vector: 'salt_fallback', score: 0 })
      );
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
    return passthroughSafe(request, env);
  }
}
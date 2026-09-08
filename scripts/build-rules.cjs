#!/usr/bin/env node
/**
 * Bangk-Shield Rules Builder
 * Membaca config/rules.json, memvalidasinya, lalu menulis src/rules.compiled.json
 * yang siap di-import oleh src/index.js (tanpa validasi di runtime).
 *
 * Dijalankan otomatis lewat predev/predeploy. Gagal = deploy tidak jalan
 * (fail-closed di CI/build, fail-open tetap ada di runtime sebagai jaring
 * pengaman -- lihat PRD §5).
 *
 * Usage: node scripts/build-rules.cjs
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_RULES = path.join(ROOT, 'config', 'rules.json');
const OUT_FILE = path.join(ROOT, 'src', 'rules.compiled.json');

const VALID_WHERE = ['path', 'query', 'body', 'headers'];
const REQUIRED_SIGNAL_FIELDS = ['pattern', 'where', 'score'];

let errors = 0;
let warnings = 0;

function fail(msg) {
  errors++;
  console.error(`  [ERROR] ${msg}`);
}
function warn(msg) {
  warnings++;
  console.warn(`  [WARN]  ${msg}`);
}

// ---------------------------------------------------------------------------
// ReDoS heuristic lint (tanpa dependency eksternal).
// Menangkap bentuk paling berbahaya: quantifier bersarang, mis. (a+)+, (\w+)*,
// (x|y+)+. Bukan pembuktian lengkap -- safe-regex tetap disarankan sebagai
// dependency dev untuk coverage lebih baik (lihat README).
// ---------------------------------------------------------------------------
function isReDoSSuspect(pattern) {
  // (?<!\\) memastikan quantifier bukan karakter escaped, mis. \(+)
  const nestedQuantifier = /(?<!\\)[+*{][^)\\]*[+*{][^)\\]*\)(?<!\\)[+*{]/;
  if (nestedQuantifier.test(pattern)) return 'nested quantifier, mis. (a+)+';

  const ambiguousAlt = /\([^)]*[+*][^)]*\|[^)]*\)(?<!\\)[+*{]/;
  if (ambiguousAlt.test(pattern)) return 'quantifier di grup alternasi ambigu, mis. (a|a?)*';

  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log('[build-rules] Membaca config/rules.json ...');
let rules;
try {
  rules = JSON.parse(fs.readFileSync(SRC_RULES, 'utf8'));
} catch (e) {
  fail(`config/rules.json tidak terbaca / JSON tidak valid: ${e.message}`);
  process.exit(1);
}

// --- validasi global ---
const g = rules.global || {};
if (typeof g.score_threshold !== 'number' || g.score_threshold <= 0) {
  fail('global.score_threshold harus angka > 0');
}
if (g.body_scan_limit_bytes && (g.body_scan_limit_bytes < 1024 || g.body_scan_limit_bytes > 65536)) {
  warn(`global.body_scan_limit_bytes=${g.body_scan_limit_bytes} di luar rentang umum 1KB-64KB`);
}
const bodyLimit = g.body_scan_limit_bytes || 16384;
const threshold = g.score_threshold || 50;

// --- validasi per-vector ---
const vectors = rules.vectors;
if (!Array.isArray(vectors) || vectors.length === 0) {
  fail('rules.vectors harus array non-kosong');
  process.exit(1);
}

const seenIds = new Set();
const compiledVectors = [];

for (const vector of vectors) {
  const tag = `[vector:${vector.id || '???'}]`;

  if (!vector.id || typeof vector.id !== 'string') fail(`${tag} wajib punya id string`);
  if (seenIds.has(vector.id)) fail(`${tag} id duplikat`);
  seenIds.add(vector.id);

  if (!Array.isArray(vector.signals) || vector.signals.length === 0) {
    fail(`${tag} signals harus array non-kosong`);
    continue;
  }

  const compiledSignals = [];
  const signalKeyToIndex = new Map();

  vector.signals.forEach((sig, index) => {
    const sigTag = `${tag}[signal:${index}]`;

    for (const field of REQUIRED_SIGNAL_FIELDS) {
      if (!(field in sig)) fail(`${sigTag} kehilangan field "${field}"`);
    }
    if (errors) return;

    // regex harus valid
    try {
      new RegExp(sig.pattern, sig.flags || 'i');
    } catch (e) {
      fail(`${sigTag} pattern regex tidak valid: ${e.message}`);
      return;
    }

    // ReDoS heuristic
    const suspicion = isReDoSSuspect(sig.pattern);
    if (suspicion) fail(`${sigTag} dicurigai ReDoS (${suspicion}): ${sig.pattern}`);

    // where harus valid
    if (!Array.isArray(sig.where) || sig.where.length === 0) {
      fail(`${sigTag} where harus array non-kosong dari [${VALID_WHERE.join(', ')}]`);
      return;
    }
    for (const w of sig.where) {
      if (!VALID_WHERE.includes(w)) fail(`${sigTag} where "${w}" tidak dikenal`);
    }

    if (typeof sig.score !== 'number' || sig.score <= 0 || sig.score > 100) {
      fail(`${sigTag} score harus angka 1-100, dapat ${sig.score}`);
    }

    signalKeyToIndex.set(`${vector.id}:${index}`, index);
    compiledSignals.push({
      pattern: sig.pattern,
      flags: sig.flags || 'i',
      where: sig.where,
      score: sig.score,
    });
  });

  // combo_bonus: referensi if_all harus merujuk signal yang ada
  const compiledCombos = [];
  for (const combo of vector.combo_bonus || []) {
    const refs = combo.if_all || [];
    const resolved = refs.map((ref) => {
      if (!signalKeyToIndex.has(ref)) {
        fail(`${tag} combo_bonus mereferensikan "${ref}" yang tidak ada`);
        return null;
      }
      return signalKeyToIndex.get(ref);
    });
    if (resolved.some((r) => r === null)) continue;
    if (typeof combo.add !== 'number' || combo.add <= 0) {
      fail(`${tag} combo_bonus.add harus angka > 0`);
      continue;
    }
    compiledCombos.push({ if_all: refs, add: combo.add });
  }

  // roast minimal 1
  if (!Array.isArray(vector.roast) || vector.roast.length === 0) {
    warn(`${tag} roast kosong -- response akan memakai roast default`);
  }

  compiledVectors.push({
    id: vector.id,
    enabled: vector.enabled !== false,
    signals: compiledSignals,
    combo_bonus: compiledCombos,
    roast: vector.roast || [],
    default_fake_status: vector.default_fake_status || 200,
    fake_payload: vector.fake_payload || { delay_ms: [120, 450], body: { status: 'blocked' } },
  });
}

// --- ringkasan skor: alarm jika tidak ada kombinasi yang bisa tembus threshold ---
const compilable = compiledVectors.filter((v) => v.enabled && v.signals.length > 0);
if (compilable.length > 0) {
  const maxScores = compilable.map((v) => {
    const base = v.signals.reduce((sum, s) => sum + s.score, 0);
    const bonus = v.combo_bonus.reduce((sum, c) => sum + c.add, 0);
    return { id: v.id, max: base + bonus };
  });
  const hopeless = maxScores.filter((m) => m.max < threshold);
  for (const h of hopeless) {
    warn(`[vector:${h.id}] skor maksimum teoretis ${h.max} < threshold ${threshold} -- vector ini tidak akan pernah trigger`);
  }
}

if (errors > 0) {
  console.error(`\n[build-rules] GAGAL: ${errors} error, ${warnings} warning. Perbaiki config/rules.json.`);
  process.exit(1);
}

// --- tulis artifact ---
const artifact = {
  _meta: {
    built_at: new Date().toISOString(),
    source: 'config/rules.json',
    version: 1,
  },
  global: {
    score_threshold: threshold,
    body_scan_limit_bytes: bodyLimit,
  },
  vectors: compiledVectors,
};

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(artifact, null, 2));

console.log(`[build-rules] OK: ${compiledVectors.length} vector (${compilable.length} enabled) -> src/rules.compiled.json`);
console.log(`[build-rules] threshold=${threshold}, body_limit=${bodyLimit} bytes, ${warnings} warning`);
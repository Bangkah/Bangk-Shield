/**
 * Bangk-Shield Scanner
 * Precompile regex dari rules.compiled.json (SEKALI saat cold start, bukan per
 * request), dan evaluasi skor kumulatif + combo bonus untuk tiap request.
 */

/**
 * Mengubah artefak rules.compiled.json menjadi "rule engine" siap pakai:
 * setiap signal.pattern (string) dikompilasi jadi objek RegExp sungguhan.
 * Vector yang `enabled: false` dilewati.
 */
export function compileRules(vectors) {
  const engine = [];
  for (const vector of vectors || []) {
    if (!vector.enabled) continue;
    const compiledSignals = vector.signals.map((sig) => ({
      ...sig,
      regex: new RegExp(sig.pattern, sig.flags || 'i'),
    }));
    engine.push({ ...vector, signals: compiledSignals });
  }
  return engine;
}

/**
 * Mengevaluasi ancaman berdasarkan context request (path/query/body/headers)
 * terhadap rule engine yang sudah dikompilasi. Vector dengan skor tertinggi
 * (setelah combo bonus) yang dilaporkan sebagai attackType.
 *
 * `context` WAJIB berisi field: path, query, body, headers (string, sudah
 * di-lowercase & di-decode oleh pemanggil) -- lihat index.js.
 */
export function evaluateThreat(context, engine) {
  let highestScore = 0;
  let detectedVector = 'recon';
  let vectorDef = null;

  for (const vector of engine) {
    let vectorScore = 0;
    const triggeredSignals = new Set();

    vector.signals.forEach((sig, index) => {
      let matched = false;
      for (const target of sig.where) {
        if (context[target] && sig.regex.test(context[target])) {
          matched = true;
          break;
        }
      }
      if (matched) {
        vectorScore += sig.score;
        triggeredSignals.add(`${vector.id}:${index}`);
      }
    });

    if (vector.combo_bonus) {
      for (const combo of vector.combo_bonus) {
        const allMatch = combo.if_all.every((reqSig) => triggeredSignals.has(reqSig));
        if (allMatch) vectorScore += combo.add;
      }
    }

    if (vectorScore > highestScore) {
      highestScore = vectorScore;
      detectedVector = vector.id;
      vectorDef = vector;
    }
  }

  return { isAttack: highestScore > 0, score: highestScore, attackType: detectedVector, vectorDef };
}
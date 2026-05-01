/**
 * metrics.js — Pure computation module
 *
 * Three primary metrics, unified across all conditions:
 *
 *   tracker_block_rate  = tracker_requests_blocked / tracker_requests_total
 *                         PRIMARY metric — invisible trackers are the ML story
 *
 *   breakage_score      = weighted composite of js_error_delta, dom_delta,
 *                         load_time_delta, navigation_failure
 *                         Range [0, 1]. 0 = no breakage. 1 = total breakage.
 *
 *   latency_ms          = load_time_ms (wall-clock page load with extension)
 *                         Delta vs baseline = overhead introduced by extension
 *
 * All three flow through every layer: computeRunMetrics → aggregateRuns →
 * computeDeltas → rollupByCategory → headToHead → renderMarkdownReport.
 *
 * No Playwright dependency — this module is pure JS.
 */

// ─── Domain classification ────────────────────────────────────────────────────

let TRACKER_DOMAINS = new Set();
let AD_DOMAINS      = new Set();

export function loadDomainLists(sitesJson) {
  TRACKER_DOMAINS = new Set(sitesJson.known_tracker_domains || []);
  AD_DOMAINS      = new Set(sitesJson.known_ad_domains      || []);
}

export function classifyDomain(hostname) {
  const base = hostname.split('.').slice(-2).join('.');
  if (AD_DOMAINS.has(hostname)      || AD_DOMAINS.has(base))      return 'ad';
  if (TRACKER_DOMAINS.has(hostname) || TRACKER_DOMAINS.has(base)) return 'tracker';
  return 'clean';
}

// ─── breakage_score ───────────────────────────────────────────────────────────

/**
 * Unified breakage scalar [0, 1].
 *
 * Components and weights:
 *   navigation_failure  → 1.0  (hard failure overrides everything)
 *   js_error_increase   → 0.35 (capped at 5 errors → max contribution)
 *   dom_shrink_pct      → 0.30 (DOM shrinking more than 20% = likely breakage)
 *   load_time_increase  → 0.20 (>5s overhead is significant)
 *   unknown_blocks      → 0.15 (unknown blocked requests = potential FP)
 *
 * Used in computeDeltas (condition vs baseline) and rollup aggregation.
 */
export function computeBreakageScore({
  navigationSuccess,
  jsErrorDelta,
  contentLoss,      // (baseline_text - cond_text) / baseline_text  [0,1]
  loadTimeDeltaMs,
  unknownBlocked,
}) {
  if (!navigationSuccess) return 1.0;

  const jsScore      = Math.min(Math.max(jsErrorDelta ?? 0, 0) / 5, 1.0);    // 5+ errors = max
  // content_loss: fraction of readable text removed. >20% is significant.
  const contentScore = Math.min(Math.max((contentLoss ?? 0) / 0.2, 0), 1.0); // 20% loss = max
  const latScore     = Math.min(Math.max((loadTimeDeltaMs ?? 0) / 5000, 0), 1.0); // 5s = max
  const fpScore      = Math.min(Math.max((unknownBlocked ?? 0) / 10, 0), 1.0);    // 10+ = max

  return round(
    jsScore      * 0.35 +
    contentScore * 0.30 +   // replaces raw DOM delta — text loss is the real breakage signal
    latScore     * 0.20 +
    fpScore      * 0.15,
    4
  );
}

// ─── Per-run metrics ──────────────────────────────────────────────────────────

/**
 * Compute metrics from a single PageResult.
 * breakage_score is NOT computed here (needs baseline comparison) — computed
 * later in computeDeltas.
 */
export function computeRunMetrics(result) {
  const reqs        = result.requests || [];
  const total       = reqs.length;
  const blocked     = reqs.filter(r => r.blocked).length;
  const adReqs      = reqs.filter(r => r.isAd);
  const trackerReqs = reqs.filter(r => r.isTracker);
  const adBlocked      = adReqs.filter(r => r.blocked).length;
  const trackerBlocked = trackerReqs.filter(r => r.blocked).length;
  const unknownBlocked = reqs.filter(r => r.blocked && !r.isAd && !r.isTracker).length;

  return {
    url:       result.url,
    label:     result.label,
    category:  result.category,
    condition: result.condition,
    run:       result.run,

    // ── PRIMARY: tracker blocking ──
    tracker_block_rate:       trackerReqs.length > 0 ? trackerBlocked / trackerReqs.length : null,
    tracker_requests_total:   trackerReqs.length,
    tracker_requests_blocked: trackerBlocked,

    // ── Ad blocking ──
    ad_block_rate:       adReqs.length > 0 ? adBlocked / adReqs.length : null,
    ad_requests_total:   adReqs.length,
    ad_requests_blocked: adBlocked,

    // ── Overall block rate ──
    block_rate:        total > 0 ? blocked / total : 0,
    total_requests:    total,
    blocked_requests:  blocked,

    // Unknown blocks (FP proxy — needs manual review)
    unknown_blocked:   unknownBlocked,

    // ── PRIMARY: latency ──
    latency_ms:        result.loadTime_ms     ?? null,
    interactive_ms:    result.interactive_ms  ?? null,

    // ── Breakage components (raw — combined into breakage_score in computeDeltas) ──
    dom_node_count:    result.domNodeCount    ?? null,
    js_error_count:    result.jsErrors?.length ?? 0,

    // ── Content length (for content_loss) ──
    body_text_length: result.bodyTextLength ?? null,

    // ── Pass/fail ──
    navigation_success:       result.navigationSuccess    ?? true,
    anti_adblock_detected:    result.antiAdblockDetected  ?? false,
    countermeasure_triggered: result.countermeasureTriggered ?? false,
  };
}

// ─── Aggregate across N runs (median) ────────────────────────────────────────

export function aggregateRuns(runMetrics) {
  if (!runMetrics.length) return null;
  const base = { ...runMetrics[0] };

  const numericKeys = [
    'tracker_block_rate', 'tracker_requests_total', 'tracker_requests_blocked',
    'ad_block_rate', 'ad_requests_total', 'ad_requests_blocked',
    'block_rate', 'total_requests', 'blocked_requests', 'unknown_blocked',
    'latency_ms', 'interactive_ms', 'dom_node_count', 'js_error_count', 'body_text_length',
  ];

  for (const key of numericKeys) {
    const vals = runMetrics.map(r => r[key]).filter(v => v != null);
    base[key]  = vals.length ? median(vals) : null;
  }

  base.navigation_success       = runMetrics.every(r => r.navigation_success);
  base.anti_adblock_detected    = runMetrics.some(r => r.anti_adblock_detected);
  base.countermeasure_triggered = runMetrics.some(r => r.countermeasure_triggered);
  base.run = 'median';
  return base;
}

// ─── Deltas: condition vs baseline ───────────────────────────────────────────

/**
 * Compute all deltas and the unified breakage_score.
 * This is the authoritative comparison between a condition and baseline.
 */
export function computeDeltas(cond, base) {
  if (!cond || !base) return null;

  const d   = (a, b) => (a != null && b != null) ? round(a - b, 4) : null;
  const pct = (a, b) => (a != null && b != null && b > 0)
    ? round((a - b) / b * 100, 1) : null;

  const jsErrorDelta    = d(cond.js_error_count, base.js_error_count);
  const domDelta        = cond.dom_node_count != null && base.dom_node_count != null
    ? round(Math.abs(cond.dom_node_count - base.dom_node_count), 0) : null;
  const loadTimeDelta   = d(cond.latency_ms, base.latency_ms);

  // content_loss: fraction of page text removed vs baseline
  // (baseline_text - condition_text) / baseline_text
  // Positive = content was removed (bad). Negative = more content (fine).
  const contentLoss = (cond.body_text_length != null && base.body_text_length != null && base.body_text_length > 0)
    ? round((base.body_text_length - cond.body_text_length) / base.body_text_length, 4)
    : null;

  // ── PRIMARY unified breakage_score ──
  const breakageScore = computeBreakageScore({
    navigationSuccess: cond.navigation_success,
    jsErrorDelta,
    contentLoss,
    loadTimeDeltaMs:  loadTimeDelta,
    unknownBlocked:   cond.unknown_blocked,
  });

  return {
    url:       cond.url,
    label:     cond.label,
    category:  cond.category,
    condition: cond.condition,

    // ── PRIMARY METRICS ──
    tracker_block_rate:       cond.tracker_block_rate,
    tracker_block_rate_delta: d(cond.tracker_block_rate, base.tracker_block_rate),
    breakage_score,                                           // unified [0,1]
    latency_ms:               cond.latency_ms,
    latency_delta_ms:         loadTimeDelta,
    latency_delta_pct:        pct(cond.latency_ms, base.latency_ms),

    // ── Secondary ──
    ad_block_rate:            cond.ad_block_rate,
    ad_block_rate_delta:      d(cond.ad_block_rate, base.ad_block_rate),
    block_rate:               cond.block_rate,
    block_rate_delta:         d(cond.block_rate, base.block_rate),

    // ── Breakage components (for debugging) ──
    js_error_delta:   jsErrorDelta,
    dom_delta:        domDelta,
    content_loss:     contentLoss,
    unknown_blocked:  cond.unknown_blocked,

    // ── Pass/fail ──
    navigation_success:       cond.navigation_success,
    anti_adblock_detected:    cond.anti_adblock_detected,
    countermeasure_triggered: cond.countermeasure_triggered,
  };
}

// ─── Category rollup ─────────────────────────────────────────────────────────

/**
 * Aggregate per-site deltas into a per-category summary.
 * Three primary metrics flow through cleanly.
 */
export function rollupByCategory(allDeltas, categoryMap) {
  const results = {};
  const ALL_CONDITIONS = ['adblock-ml', 'ubo-lite', 'ml-off', 'feature-store-off'];

  for (const [category, sites] of Object.entries(categoryMap)) {
    const siteLabels = new Set(sites.map(s => s.label));
    results[category] = {};

    for (const cond of ALL_CONDITIONS) {
      const deltas = allDeltas.filter(d =>
        d.condition === cond && siteLabels.has(d.label)
      );
      if (!deltas.length) continue;

      results[category][cond] = summarizeDeltas(deltas);
    }
  }

  return results;
}

/** Summarize a set of delta objects into category-level stats */
function summarizeDeltas(deltas) {
  return {
    sites_tested: deltas.length,

    // PRIMARY
    avg_tracker_block_rate:       avg(deltas.map(d => d.tracker_block_rate).filter(notNull)),
    avg_tracker_block_rate_delta: avg(deltas.map(d => d.tracker_block_rate_delta).filter(notNull)),
    avg_breakage_score:           avg(deltas.map(d => d.breakage_score).filter(notNull)),
    avg_latency_ms:               avg(deltas.map(d => d.latency_ms).filter(notNull)),
    avg_latency_delta_ms:         avg(deltas.map(d => d.latency_delta_ms).filter(notNull)),

    // Secondary
    avg_ad_block_rate:            avg(deltas.map(d => d.ad_block_rate).filter(notNull)),
    avg_block_rate:               avg(deltas.map(d => d.block_rate).filter(notNull)),
    avg_block_rate_delta:         avg(deltas.map(d => d.block_rate_delta).filter(notNull)),

    // Breakage components
    avg_js_error_delta:           avg(deltas.map(d => d.js_error_delta).filter(notNull)),
    avg_dom_delta:                avg(deltas.map(d => d.dom_delta).filter(notNull)),
    avg_content_loss:             avg(deltas.map(d => d.content_loss).filter(notNull)),
    avg_unknown_blocked:          avg(deltas.map(d => d.unknown_blocked).filter(notNull)),

    // Pass/fail
    navigation_success_rate:     deltas.filter(d => d.navigation_success).length / deltas.length,
    anti_adblock_rate:           deltas.filter(d => d.anti_adblock_detected).length / deltas.length,
    countermeasure_trigger_rate: deltas.filter(d => d.countermeasure_triggered).length / deltas.length,
  };
}

// ─── Head-to-head ─────────────────────────────────────────────────────────────

/**
 * Three-way comparison: ML vs uBO Lite vs ablations.
 * Returns a structured summary of all condition pairs.
 */
export function headToHead(categoryRollup) {
  const categories = Object.keys(categoryRollup);
  const summary    = { categories: {}, overall: {}, ablation: {} };

  for (const cat of categories) {
    const r = categoryRollup[cat];
    const ml  = r['adblock-ml'];
    const ubo = r['ubo-lite'];
    const mlOff = r['ml-off'];
    const fsOff = r['feature-store-off'];

    const catEntry = { ml, ubo, mlOff, fsOff };

    if (ml && ubo) {
      catEntry.vs_ubo = {
        tracker_advantage:  round(((ml.avg_tracker_block_rate ?? 0) - (ubo.avg_tracker_block_rate ?? 0)) * 100, 2),
        breakage_advantage: round((ubo.avg_breakage_score ?? 0) - (ml.avg_breakage_score ?? 0), 4),
        latency_advantage_ms: round((ubo.avg_latency_delta_ms ?? 0) - (ml.avg_latency_delta_ms ?? 0), 0),
      };
    }

    // Ablation: ML on vs ML off
    if (ml && mlOff) {
      catEntry.ablation_ml = {
        tracker_gain: round(((ml.avg_tracker_block_rate ?? 0) - (mlOff.avg_tracker_block_rate ?? 0)) * 100, 2),
        breakage_cost: round((ml.avg_breakage_score ?? 0) - (mlOff.avg_breakage_score ?? 0), 4),
        latency_cost_ms: round((ml.avg_latency_delta_ms ?? 0) - (mlOff.avg_latency_delta_ms ?? 0), 0),
      };
    }

    // Ablation: feature store on vs off
    if (ml && fsOff) {
      catEntry.ablation_fs = {
        tracker_gain: round(((ml.avg_tracker_block_rate ?? 0) - (fsOff.avg_tracker_block_rate ?? 0)) * 100, 2),
        latency_gain_ms: round((fsOff.avg_latency_delta_ms ?? 0) - (ml.avg_latency_delta_ms ?? 0), 0),
      };
    }

    summary.categories[cat] = catEntry;
  }

  // Overall averages
  const withUbo = Object.values(summary.categories).filter(c => c.vs_ubo);
  if (withUbo.length) {
    const ovTrkAdv = avg(withUbo.map(c => c.vs_ubo.tracker_advantage));
    const ovBrkAdv = avg(withUbo.map(c => c.vs_ubo.breakage_advantage));
    const ovLatAdv = avg(withUbo.map(c => c.vs_ubo.latency_advantage_ms));
    summary.overall.vs_ubo = {
      avg_tracker_advantage:    ovTrkAdv,
      avg_breakage_advantage:   ovBrkAdv,
      avg_latency_advantage_ms: ovLatAdv,
    };
    // Task 1: top-level ours_vs_ubo shape for easy CI/dashboard consumption
    summary.ours_vs_ubo = {
      tracker_block_gain: round(ovTrkAdv ?? 0, 2),
      breakage_delta:     round(-(ovBrkAdv ?? 0), 4),   // negative = more breakage than uBO
      latency_delta_ms:   round(-(ovLatAdv ?? 0), 0),   // negative = faster than uBO
    };
  }

  const withAblation = Object.values(summary.categories).filter(c => c.ablation_ml);
  if (withAblation.length) {
    summary.ablation.ml_contribution = {
      avg_tracker_gain:   avg(withAblation.map(c => c.ablation_ml.tracker_gain)),
      avg_breakage_cost:  avg(withAblation.map(c => c.ablation_ml.breakage_cost)),
      avg_latency_cost_ms: avg(withAblation.map(c => c.ablation_ml.latency_cost_ms)),
    };
  }

  const withFs = Object.values(summary.categories).filter(c => c.ablation_fs);
  if (withFs.length) {
    summary.ablation.feature_store_contribution = {
      avg_tracker_gain:   avg(withFs.map(c => c.ablation_fs.tracker_gain)),
      avg_latency_gain_ms: avg(withFs.map(c => c.ablation_fs.latency_gain_ms)),
    };
  }

  return summary;
}

// ─── first_party focused rollup ───────────────────────────────────────────────

/**
 * Dedicated first_party analysis.
 * This is the battlefield — ML should show the most advantage here.
 * Returns a focused object for the report.
 */
export function firstPartyFocus(allDeltas, firstPartySites) {
  const labels = new Set(firstPartySites.map(s => s.label));
  const conditions = ['adblock-ml', 'ubo-lite', 'ml-off', 'feature-store-off'];
  const result = {};

  for (const cond of conditions) {
    const deltas = allDeltas.filter(d => d.condition === cond && labels.has(d.label));
    if (!deltas.length) continue;
    result[cond] = {
      ...summarizeDeltas(deltas),
      per_site: deltas.map(d => ({
        label:              d.label,
        tracker_block_rate: d.tracker_block_rate,
        breakage_score:     d.breakage_score,
        latency_delta_ms:   d.latency_delta_ms,
        content_loss:       d.content_loss,
        navigation_success: d.navigation_success,
        countermeasure_triggered: d.countermeasure_triggered,
      })),
    };
  }

  // Task 4: category_block_gain = ML tracker rate - uBO tracker rate on first_party
  const mlFP  = result['adblock-ml'];
  const uboFP = result['ubo-lite'];
  if (mlFP && uboFP) {
    result.category_block_gain = {
      first_party_tracker_gain: round(
        ((mlFP.avg_tracker_block_rate ?? 0) - (uboFP.avg_tracker_block_rate ?? 0)) * 100, 2
      ),
      first_party_breakage_delta: round(
        (mlFP.avg_breakage_score ?? 0) - (uboFP.avg_breakage_score ?? 0), 4
      ),
    };
  }

  return result;
}

// ─── Markdown report ──────────────────────────────────────────────────────────

export function renderMarkdownReport(h2h, categoryRollup, fpFocus, runDate) {
  const p   = (n) => n != null ? `${(n * 100).toFixed(1)}%` : '—';
  const ms  = (n) => n != null ? `${Math.round(n)}ms` : '—';
  const sc  = (n) => n != null ? n.toFixed(3) : '—';
  const sgn = (n, unit = '%') => {
    if (n == null) return '—';
    return n >= 0 ? `**+${n.toFixed(2)}${unit}**` : `${n.toFixed(2)}${unit}`;
  };

  let md = `# AdBlock ML Benchmark Report\n`;
  md += `**Date:** ${runDate || new Date().toISOString().slice(0, 10)}\n\n`;
  md += `> Primary metrics: **tracker_block_rate** · **breakage_score** · **latency_ms**\n\n`;

  // ── Overall summary ──
  const ov = h2h.overall?.vs_ubo;
  if (ov) {
    md += `## ✦ Overall: AdBlock ML vs uBO Lite\n\n`;
    md += `| Metric | ML advantage | Interpretation |\n`;
    md += `|--------|-------------|----------------|\n`;
    md += `| Tracker block rate | ${sgn(ov.avg_tracker_advantage)} | Higher = more trackers caught |\n`;
    md += `| Breakage score | ${sgn(-(ov.avg_breakage_advantage), '')} | Lower = fewer broken sites |\n`;
    md += `| Latency overhead | ${sgn(-ov.avg_latency_advantage_ms, 'ms')} | Negative = faster |\n\n`;
  }

  // ── first_party focus ── (the battlefield)
  if (fpFocus && Object.keys(fpFocus).length) {
    md += `## ⚔️ First-Party Ads — Battlefield Category\n\n`;
    md += `> ML has maximum advantage here. Lists almost never catch first-party ad injection.\n\n`;
    md += `| Condition | Tracker block rate | Breakage score | Latency delta |\n`;
    md += `|-----------|-------------------|----------------|---------------|\n`;
    for (const [cond, data] of Object.entries(fpFocus)) {
      md += `| ${cond} | ${p(data.avg_tracker_block_rate)} | ${sc(data.avg_breakage_score)} | ${ms(data.avg_latency_delta_ms)} |\n`;
    }
    md += `\n**Per-site breakdown:**\n\n`;
    const mlData = fpFocus['adblock-ml'];
    if (mlData?.per_site) {
      md += `| Site | Tracker block rate | Breakage | Content loss | Latency delta | Nav OK |\n`;
      md += `|------|--------------------|----------|--------------|---------------|--------|\n`;
      mlData.per_site.forEach(s => {
        const cl = s.content_loss != null ? `${(s.content_loss * 100).toFixed(1)}%` : '—';
        const clColor = s.content_loss > 0.10 ? ' ⚠' : '';
        md += `| ${s.label} | ${p(s.tracker_block_rate)} | ${sc(s.breakage_score)} | ${cl}${clColor} | ${ms(s.latency_delta_ms)} | ${s.navigation_success ? '✓' : '✗'} |\n`;
      });
      md += '\n';
    }

    // ── category_block_gain (Task 4) ──
    if (fpFocus.category_block_gain) {
      const cbg = fpFocus.category_block_gain;
      const gain = cbg.first_party_tracker_gain;
      const brkDelta = cbg.first_party_breakage_delta;
      md += `**Category block gain (first_party, ML vs uBO):** `;
      md += gain >= 0
        ? `**+${gain.toFixed(2)}% tracker rate** with ${brkDelta > 0 ? '+' : ''}${brkDelta.toFixed(3)} breakage delta\n\n`
        : `${gain.toFixed(2)}% tracker rate (uBO Lite leads on this category)\n\n`;
    }
  }

  // ── Ablation ──
  const abl = h2h.ablation;
  if (abl?.ml_contribution) {
    md += `## 🔬 Ablation: What is the ML Layer Contributing?\n\n`;
    md += `| Component | Tracker gain | Breakage cost | Latency cost |\n`;
    md += `|-----------|-------------|---------------|-------------|\n`;
    const ml = abl.ml_contribution;
    md += `| ML classifier (on vs off) | ${sgn(ml.avg_tracker_gain)} | ${sc(ml.avg_breakage_cost)} | ${ms(ml.avg_latency_cost_ms)} |\n`;
    if (abl.feature_store_contribution) {
      const fs = abl.feature_store_contribution;
      md += `| Feature store (on vs off) | ${sgn(fs.avg_tracker_gain)} | — | ${ms(-fs.avg_latency_gain_ms)} |\n`;
    }
    md += `\n> If ML tracker gain > 0 and breakage cost near 0 → ML is adding value without harm.\n\n`;
  }

  // ── Adversarial section (Task 5) ──
  const advRollup = Object.entries(categoryRollup).find(([k]) => k === 'adversarial');
  if (advRollup) {
    const [, advData] = advRollup;
    const mlAdv  = advData['adblock-ml'];
    const uboAdv = advData['ubo-lite'];
    md += `## 🔴 Adversarial Test — Did Blocking Trigger Countermeasures?\n\n`;
    md += `> Countermeasure = site deployed a fallback/recovery script after detecting the blocker.\n\n`;
    md += `| Condition | Countermeasure rate | Tracker block rate | Breakage score |\n`;
    md += `|-----------|--------------------|--------------------|----------------|\n`;
    if (mlAdv)  md += `| adblock-ml | ${p(mlAdv.countermeasure_trigger_rate)}  | ${p(mlAdv.avg_tracker_block_rate)} | ${sc(mlAdv.avg_breakage_score)} |\n`;
    if (uboAdv) md += `| ubo-lite   | ${p(uboAdv.countermeasure_trigger_rate)} | ${p(uboAdv.avg_tracker_block_rate)} | ${sc(uboAdv.avg_breakage_score)} |\n`;
    md += `\n> Lower countermeasure rate = our blocker is harder to detect.\n\n`;
  }

  // ── Per-category tables ──
  md += `## Per-Category Breakdown\n\n`;
  for (const [cat, data] of Object.entries(h2h.categories)) {
    const ml  = data.ml;
    const ubo = data.ubo;
    if (!ml) continue;

    md += `### ${cat.replace(/_/g, ' ')}\n\n`;
    md += `| Metric | AdBlock ML | uBO Lite |\n`;
    md += `|--------|-----------|----------|\n`;
    md += `| **Tracker block rate** | **${p(ml.avg_tracker_block_rate)}** | ${p(ubo?.avg_tracker_block_rate)} |\n`;
    md += `| **Breakage score** | **${sc(ml.avg_breakage_score)}** | ${sc(ubo?.avg_breakage_score)} |\n`;
    md += `| **Latency delta** | **${ms(ml.avg_latency_delta_ms)}** | ${ms(ubo?.avg_latency_delta_ms)} |\n`;
    md += `| Ad block rate | ${p(ml.avg_ad_block_rate)} | ${p(ubo?.avg_ad_block_rate)} |\n`;
    md += `| Content loss | ${ml.avg_content_loss != null ? (ml.avg_content_loss*100).toFixed(1)+'%' : '—'} | ${ubo?.avg_content_loss != null ? (ubo.avg_content_loss*100).toFixed(1)+'%' : '—'} |\n`;
    if (ml.countermeasure_trigger_rate != null) {
      md += `| Countermeasure rate | ${p(ml.countermeasure_trigger_rate)} | ${p(ubo?.countermeasure_trigger_rate)} |\n`;
    }
    md += `| Nav success | ${p(ml.navigation_success_rate)} | ${p(ubo?.navigation_success_rate)} |\n\n`;
  }

  md += `---\n*Each site visited 3×, median reported. Breakage score: 0 = no breakage, 1 = broken.*\n`;
  return md;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function median(arr) {
  const sorted = [...arr].filter(v => v != null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function avg(arr) {
  const vals = arr.filter(v => v != null);
  if (!vals.length) return null;
  return round(vals.reduce((a, b) => a + b, 0) / vals.length, 4);
}

function round(n, decimals) {
  return Math.round(n * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

function notNull(v) { return v != null; }

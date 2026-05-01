/**
 * AdBlock ML — Benchmark Runner
 * ==============================
 * Visits each site under five conditions and computes three primary metrics:
 *
 *   tracker_block_rate  — PRIMARY: invisible trackers are the ML story
 *   breakage_score      — unified [0,1] breakage composite
 *   latency_ms          — wall-clock page load time
 *
 * Conditions (run in order, one browser instance each):
 *   baseline            — no extension
 *   adblock-ml          — our extension, all features on
 *   ubo-lite            — uBO Lite for direct comparison
 *   ml-off              — our extension, ML classifier disabled (ablation)
 *   feature-store-off   — our extension, feature store disabled (ablation)
 *
 * Each site is visited RUNS_PER_SITE=3 times per condition; median taken.
 *
 * Usage:
 *   npm install && npx playwright install chromium
 *   node benchmark/runner.js
 *   node benchmark/runner.js --categories first_party,clean
 *   node benchmark/runner.js --site Reddit --runs 1
 *   node benchmark/runner.js --conditions baseline,adblock-ml,ubo-lite
 *   node benchmark/runner.js --dry-run
 *
 * Env:
 *   ADBLOCK_ML_PATH   — path to unpacked extension (default: repo root)
 *   UBO_LITE_PATH     — path to unpacked uBO Lite (ablation skipped if absent)
 *
 * uBO Lite: https://github.com/uBlockOrigin/uBOL-home/releases
 */

import { chromium }                            from 'playwright';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join, resolve, dirname }              from 'path';
import { fileURLToPath }                       from 'url';
import {
  loadDomainLists, classifyDomain,
  computeRunMetrics, aggregateRuns, computeDeltas,
  rollupByCategory, firstPartyFocus, headToHead,
  renderMarkdownReport,
} from './metrics.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const __dir         = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT     = resolve(__dir, '..');
const RESULTS_DIR   = join(__dir, 'results');
const SITES_FILE    = join(__dir, 'sites.json');

const ADBLOCK_ML_PATH = process.env.ADBLOCK_ML_PATH || REPO_ROOT;
const UBO_LITE_PATH   = process.env.UBO_LITE_PATH   || null;

const RUNS_PER_SITE   = 3;
const PAGE_TIMEOUT_MS = 20_000;
const SETTLE_MS       = 3_000;   // extra wait after load for late-injected scripts

// Anti-adblock heuristics
const ANTIBLOCK_SELECTORS = [
  '[class*="adblock"]', '[id*="adblock"]', '[class*="adblocker"]',
  '[class*="ad-block"]', '[id*="ad-block"]',
];
const ANTIBLOCK_PHRASES = [
  'ad blocker detected', 'please disable your ad blocker',
  'adblock detected', 'turn off your adblocker', 'whitelist this site',
];

// ─── CLI ──────────────────────────────────────────────────────────────────────

const argv = Object.fromEntries(
  process.argv.slice(2).flatMap(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [[k, v ?? true]];
  })
);

const filterCategories = argv.categories ? argv.categories.split(',') : null;
const filterSite       = argv.site       ?? null;
const runsN            = argv.runs       ? parseInt(argv.runs) : RUNS_PER_SITE;
const dryRun           = argv['dry-run'] ?? false;

// Determine which conditions to run
const ALL_CONDITIONS = [
  'baseline',
  'adblock-ml',
  ...(UBO_LITE_PATH ? ['ubo-lite'] : []),
  'ml-off',
  'feature-store-off',
];
const conditions = argv.conditions
  ? argv.conditions.split(',')
  : ALL_CONDITIONS;

// ─── Load site data ───────────────────────────────────────────────────────────

const sitesData = JSON.parse(readFileSync(SITES_FILE, 'utf8'));
loadDomainLists(sitesData);
mkdirSync(RESULTS_DIR, { recursive: true });

// ─── Ablation config: how each condition launches our extension ───────────────

/**
 * Each non-baseline condition maps to a set of feature flags passed to
 * the extension via localStorage before page load (injected by the runner).
 * The extension reads these in service-worker.js via a special message.
 *
 * 'adblock-ml'         → all features on (default)
 * 'ubo-lite'           → uBO Lite extension, our ext not loaded
 * 'ml-off'             → ML classifier disabled, lists + dynamic cache only
 * 'feature-store-off'  → feature store disabled, ML still runs without domain history
 */
const ABLATION_FLAGS = {
  'baseline':          null,
  'adblock-ml':        { ml_enabled: true,  feature_store_enabled: true  },
  'ubo-lite':          null,    // different extension entirely
  'ml-off':            { ml_enabled: false, feature_store_enabled: true  },
  'feature-store-off': { ml_enabled: true,  feature_store_enabled: false },
};

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║       AdBlock ML Benchmark Runner            ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`Conditions : ${conditions.join(' · ')}`);
  console.log(`Runs/site  : ${runsN}`);
  if (!UBO_LITE_PATH) console.warn('⚠  UBO_LITE_PATH not set — ubo-lite condition skipped');
  console.log('');

  if (dryRun) { validatePaths(); console.log('Dry run OK'); return; }

  const sites = collectSites();
  console.log(`Sites: ${sites.length} | Total visits: ${sites.length * conditions.length * runsN}\n`);

  const allRunMetrics   = [];
  let   completedVisits = 0;
  const totalVisits     = sites.length * conditions.length * runsN;

  for (const condition of conditions) {
    console.log(`\n${'─'.repeat(56)}`);
    console.log(` CONDITION: ${condition.toUpperCase()}`);
    console.log('─'.repeat(56));

    const extPath = condition === 'ubo-lite'          ? UBO_LITE_PATH
                  : condition === 'baseline'           ? null
                  : ADBLOCK_ML_PATH;

    const browser = await launchBrowser(extPath, condition);

    for (const site of sites) {
      for (let run = 1; run <= runsN; run++) {
        const n = ++completedVisits;
        process.stdout.write(`  [${n}/${totalVisits}] ${site.label} r${run}... `);

        const result  = await visitSite(browser, site, condition, run);
        const metrics = computeRunMetrics(result);
        allRunMetrics.push(metrics);

        const verdict = result.navigationSuccess
          ? `✓  tkr: ${fmt_pct(metrics.tracker_block_rate)}  req: ${result.requests.length}  blk: ${metrics.blocked_requests}`
          : '✗ FAILED';
        console.log(verdict);
      }
    }

    await browser.close();
    console.log(`\n  ✓ ${condition} complete.`);
  }

  // ── Process & write results ──────────────────────────────────────────────

  console.log('\nProcessing results...');
  const report = processResults(allRunMetrics, sites);
  writeResults(report);
  printSummary(report);
}

// ─── Visit one site ───────────────────────────────────────────────────────────

async function visitSite(browser, site, condition, run) {
  const context = await browser.newContext({
    viewport:  { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    locale:    'en-US',
  });

  // Inject ablation flags before any page script runs
  const flags = ABLATION_FLAGS[condition];
  if (flags && condition !== 'ubo-lite') {
    await context.addInitScript((f) => {
      // Extension service worker reads this via chrome.storage.local on next wake
      try { localStorage.setItem('__adblock_ml_flags', JSON.stringify(f)); } catch {}
    }, flags);
  }

  const page     = await context.newPage();
  const requests = [];
  const jsErrors = [];

  // ── Network capture ──────────────────────────────────────────────────────

  page.on('request', (req) => {
    const url = req.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    let hostname = '';
    try { hostname = new URL(url).hostname; } catch {}
    const kind = classifyDomain(hostname);
    requests.push({
      url, hostname,
      type:       req.resourceType(),
      blocked:    false,
      isTracker:  kind === 'tracker',
      isAd:       kind === 'ad',
      startTime:  Date.now(),
      duration_ms: null,
    });
  });

  page.on('response', (res) => {
    const entry = requests.findLast(r => r.url === res.url());
    if (entry) entry.duration_ms = Date.now() - entry.startTime;
  });

  page.on('requestfailed', (req) => {
    const entry = requests.findLast(r => r.url === req.url());
    if (entry) {
      const err = req.failure()?.errorText ?? '';
      // Chrome signals extension blocks as ERR_BLOCKED_BY_CLIENT
      entry.blocked     = err.includes('BLOCKED') || err.includes('ERR_BLOCKED');
      entry.duration_ms = Date.now() - entry.startTime;
    }
  });

  page.on('pageerror', (err) => {
    jsErrors.push(err.message?.slice(0, 200) ?? 'unknown');
  });

  // ── Navigate ─────────────────────────────────────────────────────────────

  let navigationSuccess = true;
  let loadTime_ms       = null;
  let interactive_ms    = null;
  const navStart        = Date.now();

  try {
    const res = await page.goto(site.url, {
      waitUntil: 'domcontentloaded',
      timeout:   site.timeout_ms || PAGE_TIMEOUT_MS,
    });
    interactive_ms = Date.now() - navStart;

    await page.waitForLoadState('load', { timeout: PAGE_TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS);  // late-loaded ad scripts
    loadTime_ms = Date.now() - navStart;

    if (!res || res.status() >= 400) navigationSuccess = false;
  } catch (err) {
    navigationSuccess = false;
    loadTime_ms       = Date.now() - navStart;
  }

  // ── DOM + anti-adblock ───────────────────────────────────────────────────

  let domNodeCount          = null;
  let bodyTextLength        = null;
  let antiAdblockDetected   = false;
  let countermeasureTriggered = false;

  if (navigationSuccess) {
    try { domNodeCount = await page.evaluate(() => document.querySelectorAll('*').length); }
    catch {}

    try { bodyTextLength = await page.evaluate(() => document.body?.innerText?.replace(/\s+/g,' ').trim().length ?? 0); }
    catch {}

    if (site.check_antiblock) {
      antiAdblockDetected = await detectAntiAdblock(page);
    }

    if (site.check_adversarial) {
      // Adversarial sites: check both whether we were detected AND
      // whether the site deployed a countermeasure in response
      antiAdblockDetected   = antiAdblockDetected || await detectAntiAdblock(page);
      countermeasureTriggered = await detectCountermeasure(page, requests);
    }
  }

  await context.close();

  return {
    url: site.url, label: site.label, category: site.category,
    condition, run, requests, domNodeCount, bodyTextLength, jsErrors,
    loadTime_ms, interactive_ms, antiAdblockDetected,
    countermeasureTriggered, navigationSuccess,
  };
}

// ─── Anti-adblock detection ───────────────────────────────────────────────────

async function detectAntiAdblock(page) {
  try {
    for (const sel of ANTIBLOCK_SELECTORS) {
      if (await page.locator(sel).isVisible().catch(() => false)) return true;
    }
    const text = await page.evaluate(
      () => document.body?.innerText?.toLowerCase() ?? ''
    ).catch(() => '');
    return ANTIBLOCK_PHRASES.some(p => text.includes(p));
  } catch { return false; }
}

/**
 * detectCountermeasure — did the site react to our blocker being present?
 *
 * Distinct from detectAntiAdblock (which checks if the *user* sees a wall).
 * This checks whether the site injected fallback scripts, rewrote ad slots,
 * or loaded recovery assets after detecting the blocker.
 *
 * Signals:
 *   - A fallback/recovery script URL was requested after DOMContentLoaded
 *   - Ad slot containers were rewritten with inline content (first-party fallback)
 *   - Known anti-adblock recovery domains appeared in the request log
 *   - window.__adblocker_detected or similar flag was set
 */
async function detectCountermeasure(page, requests) {
  try {
    // Signal 1: known anti-adblock recovery / circumvention domains
    const RECOVERY_PATTERNS = [
      /pagefair\.com/i, /sourcepoint\.com/i, /admiral\.digital/i,
      /adrecover\.com/i, /recover\.js/i, /adblock-detect/i,
      /fundingchoices\.google\.com/i, /connatix\.com/i,
      /yastatic\.net.*adfox/i, /adblocker\.js/i,
    ];
    const hasRecoveryRequest = requests.some(
      r => !r.blocked && RECOVERY_PATTERNS.some(re => re.test(r.url))
    );
    if (hasRecoveryRequest) return true;

    // Signal 2: JS detection flag set in page scope
    const jsFlag = await page.evaluate(() => {
      return !!(
        window.__adblock_detected ||
        window.adblockDetected ||
        window._adb ||
        window.canRunAds === false ||
        window.adsBlocked === true
      );
    }).catch(() => false);
    if (jsFlag) return true;

    // Signal 3: fallback ad container filled with inline/first-party content
    // (ad slot exists in DOM but has text/image content despite blocker)
    const slotFilled = await page.evaluate(() => {
      const slots = document.querySelectorAll(
        '[id*="ad-slot"],[class*="ad-slot"],[data-ad-slot],[id*="dfp"]' 
      );
      for (const slot of slots) {
        const hasContent = slot.children.length > 0 &&
          slot.offsetWidth > 0 && slot.offsetHeight > 0;
        if (hasContent) return true;
      }
      return false;
    }).catch(() => false);
    if (slotFilled) return true;

    return false;
  } catch { return false; }
}

// ─── Process results ──────────────────────────────────────────────────────────

function processResults(allRunMetrics, sites) {
  // Aggregate 3 runs per (url, condition) → median
  const grouped = {};
  for (const m of allRunMetrics) {
    const key = `${m.url}::${m.condition}`;
    (grouped[key] ??= []).push(m);
  }
  const aggregated = Object.values(grouped).map(aggregateRuns).filter(Boolean);

  // Compute deltas vs baseline for every (site, condition) pair
  const allDeltas = [];
  for (const site of sites) {
    const base = aggregated.find(m => m.url === site.url && m.condition === 'baseline');
    if (!base) continue;
    for (const cond of conditions.filter(c => c !== 'baseline')) {
      const cm = aggregated.find(m => m.url === site.url && m.condition === cond);
      if (cm) {
        const d = computeDeltas(cm, base);
        if (d) allDeltas.push(d);
      }
    }
  }

  // Category map
  const catMap = {};
  for (const [cat, catSites] of Object.entries(sitesData.categories)) {
    catMap[cat] = catSites.map(s => ({ ...s, category: cat }));
  }

  const categoryRollup = rollupByCategory(allDeltas, catMap);

  // ── First-party dedicated focus ──
  const fpSites    = (sitesData.categories.first_party || []).map(s => ({ ...s, category: 'first_party' }));
  const fpFocusData = firstPartyFocus(allDeltas, fpSites);

  const h2h = headToHead(categoryRollup);
  const md  = renderMarkdownReport(h2h, categoryRollup, fpFocusData,
    new Date().toISOString().slice(0, 10));

  // Top-level ours_vs_ubo for CI / dashboards — no nesting required
  const oursVsUbo = h2h.ours_vs_ubo ?? null;

  return {
    // ── Primary comparison output (Task 1) ──
    ours_vs_ubo: oursVsUbo,

    meta: {
      run_date:    new Date().toISOString(),
      conditions,
      runs_per_site: runsN,
      sites_tested:  sites.length,
      adblock_ml_version: getVersion(),
    },
    per_site:        aggregated,
    deltas:          allDeltas,
    category_rollup: categoryRollup,
    first_party_focus: fpFocusData,
    head_to_head:    h2h,
    markdownReport:  md,
  };
}

// ─── Write results ────────────────────────────────────────────────────────────

function writeResults(report) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  writeFileSync(join(RESULTS_DIR, `benchmark-${ts}.json`), JSON.stringify(report, null, 2));
  writeFileSync(join(RESULTS_DIR, `benchmark-${ts}.md`),   report.markdownReport);
  writeFileSync(join(RESULTS_DIR, 'latest.json'),           JSON.stringify(report, null, 2));
  writeFileSync(join(RESULTS_DIR, 'latest.md'),             report.markdownReport);

  console.log(`\nResults → benchmark/results/benchmark-${ts}.md`);
}

// ─── Browser launch ───────────────────────────────────────────────────────────

async function launchBrowser(extPath, condition) {
  const args = [
    '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1280,800',
  ];

  if (extPath) {
    const abs = resolve(extPath);
    if (!existsSync(abs)) throw new Error(`Extension not found: ${abs}`);
    args.push(`--load-extension=${abs}`, `--disable-extensions-except=${abs}`);
    console.log(`  ext: ${abs}`);
  }

  return chromium.launch({ headless: false, args });
}

// ─── Site collection ──────────────────────────────────────────────────────────

function collectSites() {
  return Object.entries(sitesData.categories).flatMap(([cat, sites]) => {
    if (filterCategories && !filterCategories.includes(cat)) return [];
    return sites
      .filter(s => !filterSite || s.label === filterSite)
      .map(s => ({ ...s, category: cat }));
  });
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validatePaths() {
  const mlManifest = join(resolve(ADBLOCK_ML_PATH), 'manifest.json');
  if (!existsSync(mlManifest)) {
    console.error(`✗ AdBlock ML manifest not found: ${mlManifest}`); process.exit(1);
  }
  console.log(`✓ AdBlock ML: ${ADBLOCK_ML_PATH}`);
  if (UBO_LITE_PATH) {
    const uboManifest = join(resolve(UBO_LITE_PATH), 'manifest.json');
    if (!existsSync(uboManifest)) {
      console.error(`✗ uBO Lite manifest not found: ${uboManifest}`); process.exit(1);
    }
    console.log(`✓ uBO Lite:    ${UBO_LITE_PATH}`);
  }
}

function getVersion() {
  try { return JSON.parse(readFileSync(join(ADBLOCK_ML_PATH, 'manifest.json'), 'utf8')).version; }
  catch { return 'unknown'; }
}

// ─── Terminal summary ─────────────────────────────────────────────────────────

function printSummary(report) {
  console.log('\n');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║            BENCHMARK RESULTS                 ║');
  console.log('╚══════════════════════════════════════════════╝');

  // ── Machine-readable ours_vs_ubo block ──────────────────────────────────
  if (report.ours_vs_ubo) {
    const o = report.ours_vs_ubo;
    console.log('\n  ours_vs_ubo (CI output):');
    console.log(`    tracker_block_gain : ${o.tracker_block_gain >= 0 ? '+' : ''}${o.tracker_block_gain}%`);
    console.log(`    breakage_delta     : ${o.breakage_delta >= 0 ? '+' : ''}${o.breakage_delta}`);
    console.log(`    latency_delta_ms   : ${o.latency_delta_ms >= 0 ? '+' : ''}${o.latency_delta_ms}ms`);
  }

  const ov = report.head_to_head?.overall?.vs_ubo;
  if (ov) {
    console.log('\n  vs uBO Lite (human):');
    console.log(`    Tracker block rate : ${sgn(ov.avg_tracker_advantage, '%')}`);
    console.log(`    Breakage score     : ${sgn(-ov.avg_breakage_advantage, '')}`);
    console.log(`    Latency overhead   : ${sgn(-ov.avg_latency_advantage_ms, 'ms')}`);
  }

  const abl = report.head_to_head?.ablation;
  if (abl?.ml_contribution) {
    const ml = abl.ml_contribution;
    console.log('\n  ML ablation (on vs off):');
    console.log(`    Tracker gain       : ${sgn(ml.avg_tracker_gain, '%')}`);
    console.log(`    Breakage cost      : ${ml.avg_breakage_cost?.toFixed(3) ?? '—'}`);
    console.log(`    Latency cost       : ${ms(ml.avg_latency_cost_ms)}`);
  }

  if (abl?.feature_store_contribution) {
    const fs = abl.feature_store_contribution;
    console.log('\n  Feature store ablation (on vs off):');
    console.log(`    Tracker gain       : ${sgn(fs.avg_tracker_gain, '%')}`);
    console.log(`    Latency gain       : ${ms(fs.avg_latency_gain_ms)}`);
  }

  // First-party focus
  const fp = report.first_party_focus;
  if (fp && Object.keys(fp).length) {
    console.log('\n  First-party (battlefield):');
    for (const [cond, data] of Object.entries(fp)) {
      if (!data.avg_tracker_block_rate) continue;
      console.log(`    ${cond.padEnd(22)} tkr: ${fmt_pct(data.avg_tracker_block_rate)}  brk: ${data.avg_breakage_score?.toFixed(3) ?? '—'}`);
    }
  }

  console.log('\n  Full report: benchmark/results/latest.md\n');
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmt_pct(n) { return n != null ? `${(n * 100).toFixed(0)}%` : '—'; }
function ms(n)      { return n != null ? `${Math.round(n)}ms` : '—'; }
function sgn(n, unit) {
  if (n == null) return '—';
  return `${n >= 0 ? '+' : ''}${typeof n === 'number' ? n.toFixed(1) : n}${unit}`;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});

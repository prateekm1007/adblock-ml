/**
 * AdBlock ML — Service Worker v4
 *
 * What's new:
 *   - seenRequests dedup Set (scoped per tab, cleared on navigation)
 *   - domainCount stabilization (require 2 hits before logging ML-only)
 *   - tabStartTime 15s gate (only classify fresh page requests)
 *   - isEssentialRequest guard (never touch main_frame / document / stylesheet)
 *   - ml_summary_${tabId} written to session storage after each ML block
 *   - ALLOWLIST_DOMAIN message handler (allow button → reload tab)
 *   - explanation tags derived from feature vector
 */

import { AdFlushClassifier }  from './classifier.js';
import { RequestGraph }       from './request-graph.js';
import { StatsTracker }       from './stats.js';
import { DynamicRuleManager } from './dynamic-rules.js';
import { ListManager }        from './list-manager.js';
import { FeatureStore }       from './feature-store.js';
import { EventLogger }        from './event-logger.js';
import { FeedbackEngine }     from './feedback-engine.js';
import { SyncLayer }          from './sync-layer.js';
import { RuntimeConfig }      from './runtime-config.js';

// ─── Singletons ───────────────────────────────────────────────────────────────

const config       = new RuntimeConfig();
const classifier   = new AdFlushClassifier();
const requestGraph = new RequestGraph();
const stats        = new StatsTracker();
const dynamicRules = new DynamicRuleManager();
const listManager  = new ListManager();
const featureStore = new FeatureStore();
const eventLogger  = new EventLogger();
const feedbackEng  = new FeedbackEngine(eventLogger, dynamicRules);
const syncLayer    = new SyncLayer(eventLogger, classifier);

// ─── Thresholds & constants ───────────────────────────────────────────────────

const ML_THRESHOLD       = 0.78;
const ML_ONLY_THRESHOLD  = 0.75;   // lower bound for ML-only event logging
const HIGH_CONF          = 0.90;   // score >= this → confidence: "High"
const PAGE_WINDOW_MS     = 15_000; // only classify requests in first 15s
const DOMAIN_HIT_MIN     = 2;      // stabilization: require 2 hits before logging
const DOMAIN_HIT_MAX     = 3;      // stop logging after 3 hits (noise filter)
const ML_BUDGET_PER_PAGE = 80;

// Resource types the ML classifier should never touch
const ESSENTIAL_TYPES = new Set([
  'main_frame', 'document', 'stylesheet',
]);

const ML_ELIGIBLE_TYPES = new Set([
  'script', 'xmlhttprequest', 'fetch', 'image', 'sub_frame', 'media',
]);

// ─── Per-tab state ────────────────────────────────────────────────────────────
// All maps keyed by tabId, cleared on navigation

const seenRequests = new Map();   // tabId → Set<requestKey>
const domainCount  = new Map();   // tabId → Map<domain, hitCount>
const tabStartTime = new Map();   // tabId → timestamp (ms)
const mlBudget     = new Map();   // tabId → remaining inference budget
const mlOnlyCount  = new Map();   // tabId → count of ML-only blocks this page

// ─── Init ─────────────────────────────────────────────────────────────────────

async function initialize() {
  console.log('[AdBlockML] Service worker v4 starting');

  await Promise.all([
    config.load(),
    classifier.load(),
    listManager.initialize(),
    stats.load(),
    dynamicRules.initialize(),
    featureStore.open(),
    eventLogger.open(),
  ]);

  syncLayer.start();
  setupWebRequestListeners();
  setupMessageListeners();
  setupTabListeners();

  console.log(`[AdBlockML] Ready | classifier: ${classifier.getModelInfo().type}`);
}

// ─── Navigation — reset all per-tab state ─────────────────────────────────────

function resetTabState(tabId, url) {
  tabStartTime.set(tabId, Date.now());
  domainCount.set(tabId,  new Map());
  seenRequests.set(tabId, new Set());
  mlBudget.set(tabId,     ML_BUDGET_PER_PAGE);
  mlOnlyCount.set(tabId,  0);

  requestGraph.newPage(tabId, url);
  stats.newPage(tabId, url);
}

// ─── Web Request ──────────────────────────────────────────────────────────────

function setupWebRequestListeners() {
  chrome.webRequest.onBeforeRequest.addListener(
    onBeforeRequest,                        // must be synchronous
    { urls: ['<all_urls>'] },
    ['requestBody']
  );

  chrome.webRequest.onCompleted.addListener(
    (d) => requestGraph.markCompleted(d.requestId, d.statusCode),
    { urls: ['<all_urls>'] }
  );

  chrome.webRequest.onErrorOccurred.addListener(
    (d) => requestGraph.markError(d.requestId, d.error),
    { urls: ['<all_urls>'] }
  );

  chrome.webNavigation.onCommitted.addListener(async (details) => {
    if (details.frameId !== 0) return;
    const { tabId, url } = details;
    resetTabState(tabId, url);
    await feedbackEng.onNavigation(tabId, url);
  });

  // Patch 1: SPA navigation — React/Vue/etc. push history without a full
  // page load, so onCommitted never fires. Reset per-tab state so the
  // 15s window and dedup Set start fresh on each logical page view.
  chrome.webNavigation.onHistoryStateUpdated.addListener(({ tabId, frameId }) => {
    if (frameId !== 0) return;
    resetTabState(tabId, '');  // url unknown at this point — graph will update on next request
  });
}

// Synchronous — must not be async
function onBeforeRequest(details) {
  const { requestId, url, type, tabId, initiator, timeStamp } = details;

  requestGraph.recordRequest({
    requestId, url, type, tabId,
    initiator: initiator || '',
    timestamp: timeStamp,
  });

  if (!ML_ELIGIBLE_TYPES.has(type)) return;
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return;

  classifyAsync(url, type, tabId, initiator || '', timeStamp);
}

// ─── Core classify + ML-only logic ────────────────────────────────────────────

async function classifyAsync(url, type, tabId, initiator, timestamp) {
  try {

    // ── Task 2: Essential filter — never touch these ───────────────────────
    const isEssential = ESSENTIAL_TYPES.has(type);
    if (isEssential) return;

    // ── Gate 1: dynamic cache ──────────────────────────────────────────────
    if (await dynamicRules.isBlocked(url)) {
      stats.recordBlock(tabId, url, 'dynamic_cache');
      feedbackEng.recordBlock(tabId, url);
      await eventLogger.log({ url, features: null, prediction: null, decision: 'cache' });
      return;
    }

    // ── Gate 2: feature store safe-domain skip ─────────────────────────────
    if (config.featureStoreEnabled && await featureStore.isCachedSafe(url)) {
      stats.recordAllow(tabId, url, 0);
      return;
    }

    // ── Gate 3: ML disabled (ablation) ────────────────────────────────────
    if (!config.mlEnabled) {
      stats.recordAllow(tabId, url, null);
      return;
    }

    // ── Gate 4: inference budget — explicit init + cap ─────────────────────
    if (!mlBudget.has(tabId)) mlBudget.set(tabId, 0);
    if (mlBudget.get(tabId) >= ML_BUDGET_PER_PAGE) return;
    mlBudget.set(tabId, mlBudget.get(tabId) + 1);

    if (!classifier.isReady()) return;

    // ── Classify — with latency guard ──────────────────────────────────────
    const pageContext  = requestGraph.getPageContext(tabId);
    const features     = classifier.extractFeatures({ url, type, initiator, timestamp, pageContext });
    const inferStart   = performance.now();
    const score        = await classifier.scoreFromFeatures(features);
    const inferMs      = performance.now() - inferStart;

    // Patch 5: if inference exceeded the latency budget, abort all side-effects
    // entirely. The DNR static rules already handled legitimate blocks; slow
    // ML means something is wrong (GC pause, model reload, memory pressure).
    // No logging, no counting, no dynamic rule addition — clean fast exit.
    if (inferMs > 10) {
      console.warn(`[AdBlockML] Slow inference ${inferMs.toFixed(1)}ms — aborting ML path`);
      return;
    }

    if (config.featureStoreEnabled) {
      await featureStore.observe(url, features[7] ?? 0, features[6] > 0, score >= ML_THRESHOLD);
    }

    // ── Check if lists would have caught this ─────────────────────────────
    const listBlocks = await listManager.wouldBlock(url);

    if (score >= ML_THRESHOLD) {
      await dynamicRules.addBlock(url, score);
      stats.recordBlock(tabId, url, 'ml', score);
      feedbackEng.recordBlock(tabId, url);
      await eventLogger.log({ url, features, prediction: score, decision: 'block' });
      console.debug(`[AdBlockML] ML blocked (${score.toFixed(3)}): ${url}`);
    } else {
      stats.recordAllow(tabId, url, score);
      await eventLogger.log({ url, features, prediction: score, decision: 'allow' });
    }

    // ── Task 1: ML-only tracking ───────────────────────────────────────────
    // inferMs guard already applied above — if we reach here, latency is OK
    if (score >= ML_ONLY_THRESHOLD && !listBlocks && !isEssential) {
      await recordMlOnlyHit(url, type, tabId, initiator, score, features);
    }

  } catch (err) {
    console.warn('[AdBlockML] classifyAsync error:', err);
  }
}

// ─── Task 1: ML-only hit tracking with stabilization ─────────────────────────

async function recordMlOnlyHit(url, type, tabId, initiator, score, features) {
  // 15s page window guard
  const pageStart = tabStartTime.get(tabId);
  if (!pageStart || Date.now() - pageStart > PAGE_WINDOW_MS) return;

  // Dedup: sync string key — no async needed, collision risk negligible at
  // this scale (tabId scoping + 15s window means Set stays small)
  const requestKey = `${url}|${tabId}|${initiator}|${type}`;
  const seen = seenRequests.get(tabId) ?? new Set();
  if (seen.has(requestKey)) return;
  seen.add(requestKey);
  seenRequests.set(tabId, seen);

  // Stabilization: require DOMAIN_HIT_MIN hits before treating as real signal
  const domain  = getDomain(url);
  const counts  = domainCount.get(tabId) ?? new Map();
  const hits    = (counts.get(domain) ?? 0) + 1;
  counts.set(domain, hits);
  domainCount.set(tabId, counts);

  if (hits < DOMAIN_HIT_MIN) return;   // not stable yet
  if (hits > DOMAIN_HIT_MAX) return;   // already logged enough for this domain

  // Build the request detail entry (Task 5)
  const confidence    = score >= HIGH_CONF ? 'High' : 'Medium';
  const reason        = deriveExplanationTag(features, url);
  const mlOnlyEntry   = { type: 'ML', confidence, reason, domain };

  // Increment tab ML-only counter
  const count = (mlOnlyCount.get(tabId) ?? 0) + 1;
  mlOnlyCount.set(tabId, count);

  // Task 3: write summary to session storage for popup
  await writeMlSummary(tabId, count, mlOnlyEntry);

  console.debug(`[AdBlockML] ML-only hit #${count} (${confidence}): ${domain} — ${reason}`);
}

// ─── Task 3: session storage pipeline ────────────────────────────────────────

async function writeMlSummary(tabId, mlOnlyTotal, latestEntry) {
  try {
    const key     = `ml_summary_${tabId}`;
    const current = (await chrome.storage.session.get(key))[key] ?? {};
    const entries = current.entries ?? [];

    entries.push({ ...latestEntry, timestamp: Date.now() });
    if (entries.length > 50) entries.shift(); // rolling window

    await chrome.storage.session.set({
      [key]: {
        ml_only_count: mlOnlyTotal,
        tabId,           // Patch 4: embed tabId so popup can validate
        entries,
        timestamp: Date.now(),
      },
    });
  } catch (err) {
    console.warn('[AdBlockML] writeMlSummary error:', err);
  }
}

// ─── Explanation tags (Task 5) ────────────────────────────────────────────────

/**
 * Map the dominant feature signal into a human-readable reason tag.
 * Feature indices match FEATURE_NAMES in classifier.js:
 *   [5]  ad_keyword_count
 *   [6]  has_tracker_param
 *   [7]  path_entropy
 *   [8]  query_entropy
 *   [16] hex_literal_count
 *   [23] is_third_party
 *   [25] late_injection
 */
function deriveExplanationTag(features, url) {
  if (!features) return 'ml_pattern';

  // Score each signal proportionally — highest wins (no arbitrary priority)
  // Feature indices from FEATURE_NAMES in classifier.js
  const u = url.toLowerCase();
  // Base scores: normalised signal strength [0, 1]
  const baseScores = {
    late_injection:     features[25] > 0  ? features[25] * 1.0                    : 0,
    obfuscated_url:     features[16] > 0  ? Math.min(features[16] / 5, 1.0)       : 0,
    high_entropy_path:  features[7]  > 2  ? Math.min((features[7]  - 2) / 3, 1.0) : 0,
    high_entropy_query: features[8]  > 2  ? Math.min((features[8]  - 2) / 3, 1.0) : 0,
    tracker_params:     features[6]  > 0  ? 0.8                                   : 0,
    ad_keyword_match:   features[5]  > 0  ? Math.min(features[5]  / 3, 1.0)       : 0,
    tracking_pixel:     /pixel|beacon|collect|ping/.test(u)  ? 0.7 : 0,
    ad_network:         /pagead|adunit|prebid/.test(u)        ? 0.7 : 0,
    third_party:        features[23] > 0  ? 0.3                                   : 0,
  };

  // Patch 3: per-tag weights capture domain knowledge about which signals
  // are most reliable in practice. late_injection and obfuscated patterns
  // are strong ML-only signals; entropy and third_party are weaker priors.
  const weights = {
    late_injection:     1.2,
    obfuscated_url:     1.1,
    high_entropy_path:  1.0,
    high_entropy_query: 1.0,
    tracker_params:     0.9,
    ad_keyword_match:   0.9,
    tracking_pixel:     0.8,
    ad_network:         0.8,
    third_party:        0.5,
  };

  const scores = {};
  for (const tag of Object.keys(baseScores)) {
    scores[tag] = baseScores[tag] * (weights[tag] ?? 1.0);
  }

  const top = Object.keys(scores).sort((a, b) => scores[b] - scores[a])[0];
  return scores[top] > 0 ? top : 'ml_pattern';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDomain(url) {
  try { return new URL(url).hostname.split('.').slice(-2).join('.'); }
  catch { return url.slice(0, 40); }
}


// ─── Tab lifecycle ─────────────────────────────────────────────────────────────

function setupTabListeners() {
  chrome.tabs.onRemoved.addListener((tabId) => {
    // Clean up all per-tab in-memory state
    seenRequests.delete(tabId);
    domainCount.delete(tabId);
    tabStartTime.delete(tabId);
    mlBudget.delete(tabId);
    mlOnlyCount.delete(tabId);
    requestGraph.pruneTab(tabId);
    feedbackEng.onTabRemoved(tabId);
    // Explicitly remove session storage — prevents unbounded growth on
    // long sessions with many tab opens/closes
    chrome.storage.session.remove(`ml_summary_${tabId}`);
  });
}

// ─── Messages ─────────────────────────────────────────────────────────────────

function setupMessageListeners() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {

      case 'GET_STATS': {
        const tabId = message.tabId ?? sender.tab?.id;
        Promise.all([
          stats.getGlobalStats(),
          tabId ? stats.getTabStats(tabId) : Promise.resolve(null),
          tabId ? chrome.storage.session.get(`ml_summary_${tabId}`) : Promise.resolve({}),
        ]).then(([global, tab, sessionData]) => {
          const mlSummary = sessionData[`ml_summary_${message.tabId ?? sender.tab?.id}`] ?? null;
          sendResponse({
            global, tab, mlSummary,
            classifierInfo:   classifier.getModelInfo(),
            dynamicRuleStats: dynamicRules.getStats(),
            runtimeFlags:     config.get(),
          });
        });
        return true;
      }

      // Task 6: allow a domain — remove block, reload tab
      case 'ALLOWLIST_DOMAIN': {
        const { domain, tabId } = message;
        dynamicRules.removeBlock(`https://${domain}/`).then(async () => {
          // Also add to persistent allowlist so it survives rule TTL
          await dynamicRules.disableSite(domain);
          if (tabId) chrome.tabs.reload(tabId);
          sendResponse({ ok: true });
        });
        return true;
      }

      case 'SET_RUNTIME_FLAGS': {
        config.set(message.flags).then(() => sendResponse({ ok: true }));
        return true;
      }

      case 'GET_RUNTIME_FLAGS': {
        sendResponse(config.get());
        return false;
      }

      case 'RESET_RUNTIME_FLAGS': {
        config.reset().then(() => sendResponse({ ok: true }));
        return true;
      }

      case 'TOGGLE_SITE': {
        const { hostname, enabled } = message;
        (enabled ? dynamicRules.enableSite(hostname) : dynamicRules.disableSite(hostname))
          .then(() => sendResponse({ ok: true }));
        return true;
      }

      case 'REPORT_FEEDBACK': {
        const { url, feedbackType } = message;
        const fn = {
          fp:        () => feedbackEng.reportFalsePositive(url),
          fn:        () => feedbackEng.reportFalseNegative(url),
          confirmed: () => feedbackEng.reportConfirmed(url),
        }[feedbackType];
        if (fn) fn().then(() => sendResponse({ ok: true }));
        else    sendResponse({ ok: false, error: 'unknown feedback type' });
        return true;
      }

      case 'GET_COSMETIC_RULES':
        sendResponse([]);
        return false;

      case 'RUN_BENCHMARK':
        runBenchmark().then(sendResponse);
        return true;

      case 'CLEAR_DYNAMIC_RULES':
        dynamicRules.clearAll().then(() => sendResponse({ ok: true }));
        return true;

      case 'GET_UNSYNCED_COUNT':
        eventLogger.getUnsyncedBatch(1).then(b => sendResponse({ count: b.length }));
        return true;

      default:
        return false;
    }
  });
}

// ─── In-extension benchmark (popup) ──────────────────────────────────────────

async function runBenchmark() {
  const recent = requestGraph.getRecentRequests(200);
  if (!recent.length) return { total: 0, listBlocked: 0, mlOnlyBlocked: 0, mlFalsePositives: 0 };

  let listBlocked = 0, mlOnlyBlocked = 0, mlFalsePositives = 0;

  for (const req of recent) {
    const [listBlock, mlScore] = await Promise.all([
      listManager.wouldBlock(req.url),
      classifier.isReady()
        ? classifier.score({ url: req.url, type: req.type, initiator: req.initiator,
                             timestamp: req.timestamp, pageContext: { requests: recent } })
        : Promise.resolve(0),
    ]);
    if (listBlock) listBlocked++;
    if (mlScore >= ML_THRESHOLD && !listBlock) { mlOnlyBlocked++; mlFalsePositives++; }
  }

  return { total: recent.length, listBlocked, mlOnlyBlocked, mlFalsePositives };
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
initialize().catch(console.error);

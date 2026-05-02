import { AdFlushClassifier }  from './classifier.js';
import { RequestGraph }       from './request-graph.js';
import { StatsTracker }       from './stats.js';
import { DynamicRuleManager } from './dynamic-rules.js';
import { ListManager }        from './list-manager.js';
import { FeatureStore }       from './feature-store.js';
import { EventLogger }        from './event-logger.js';
import { FeedbackEngine }     from './feedback-engine.js';
import { RuntimeConfig }      from './runtime-config.js';

// --- Singletons -----------------------------------------------------------

const config       = new RuntimeConfig();
const classifier   = new AdFlushClassifier();
const requestGraph = new RequestGraph();
const stats        = new StatsTracker();
const dynamicRules = new DynamicRuleManager();
const listManager  = new ListManager();
const featureStore = new FeatureStore();
const eventLogger  = new EventLogger();
const feedbackEng  = new FeedbackEngine(eventLogger, dynamicRules);

let __ready = false;

// --- Thresholds & constants ------------------------------------------------

const ML_THRESHOLD       = 0.50;
const ML_ONLY_THRESHOLD  = 0.45;
const HIGH_CONF          = 0.90;
const PAGE_WINDOW_MS     = 15_000;
const DOMAIN_HIT_MIN     = 2;
const DOMAIN_HIT_MAX     = 3;
const ML_BUDGET_PER_PAGE = 80;

const ESSENTIAL_TYPES = new Set([
  'main_frame', 'document', 'stylesheet',
]);

const ML_ELIGIBLE_TYPES = new Set([
  'script', 'xmlhttprequest', 'fetch', 'image', 'sub_frame', 'media',
]);

// --- Per-tab state ---------------------------------------------------------

const seenRequests = new Map();
const domainCount  = new Map();
const tabStartTime = new Map();
const mlBudget     = new Map();
const mlOnlyCount  = new Map();

// --- Init ------------------------------------------------------------------

async function initialize() {
  console.log('[AdBlockML] Starting initialization...');

  const tasks = [
    config.load(),
    classifier.load(),
    listManager.initialize(),
    stats.load(),
    dynamicRules.initialize(),
    featureStore.open(),
    eventLogger.open().catch(() => {}),
  ];

  const results = await Promise.allSettled(tasks);

  const labels = ['config','classifier','listManager','stats','dynamicRules','featureStore','eventLogger'];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error('[AdBlockML] INIT FAILED -', labels[i], r.reason);
    }
  });

  __ready = true;

  chrome.declarativeNetRequest.getDynamicRules().then(dynamicRuleList => {
    chrome.declarativeNetRequest.getEnabledRulesets().then(rulesets => {
      console.log(
        '[AdBlockML] READY' +
        '\n  classifier    : ' + classifier.getModelInfo().type +
        '\n  rulesets      : ' + JSON.stringify(rulesets) +
        '\n  dynamic rules : ' + dynamicRuleList.length +
        '\n  list domains  : ' + listManager.getDomainCount() +
        '\n  ml.enabled    : ' + config.mlEnabled +
        '\n  featureStore  : ' + config.featureStoreEnabled +
        '\n  ML_THRESHOLD  : ' + ML_THRESHOLD +
        '\n  budget/page   : ' + ML_BUDGET_PER_PAGE
      );
    });
  });
}

// --- Navigation - reset all per-tab state ----------------------------------

function resetTabState(tabId, url) {
  tabStartTime.set(tabId, Date.now());
  domainCount.set(tabId,  new Map());
  seenRequests.set(tabId, new Set());
  mlBudget.set(tabId,     ML_BUDGET_PER_PAGE);
  mlOnlyCount.set(tabId,  0);
  requestGraph.newPage(tabId, url);
  stats.newPage(tabId, url);
}

// --- Web Request -----------------------------------------------------------

function setupWebRequestListeners() {
  chrome.webRequest.onBeforeRequest.addListener(
    onBeforeRequest,
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

  chrome.webNavigation.onHistoryStateUpdated.addListener(({ tabId, frameId }) => {
    if (frameId !== 0) return;
    resetTabState(tabId, '');
  });
}

// Synchronous - must not be async
function onBeforeRequest(details) {
  if (!__ready) return;
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

// --- Core classify ---------------------------------------------------------

async function classifyAsync(url, type, tabId, initiator, timestamp) {
  try {
    const isEssential = ESSENTIAL_TYPES.has(type);
    if (isEssential) return;

    // Gate 1: dynamic cache
    if (await dynamicRules.isBlocked(url)) {
      stats.recordBlock(tabId, url, 'dynamic_cache');
      feedbackEng.recordBlock(tabId, url);
      await eventLogger.log({ url, features: null, prediction: null, decision: 'cache' });
      console.log('[PIPELINE] DYNAMIC-CACHE block:', url.substring(0, 80));
      return;
    }

    // Gate 2: feature store safe-domain skip
    if (config.featureStoreEnabled && await featureStore.isCachedSafe(url)) {
      stats.recordAllow(tabId, url, 0);
      return;
    }

    // Gate 3: ML disabled
    if (!config.mlEnabled) {
      stats.recordAllow(tabId, url, null);
      return;
    }

    // Gate 4: inference budget
    if (!mlBudget.has(tabId)) mlBudget.set(tabId, 0);
    if (mlBudget.get(tabId) >= ML_BUDGET_PER_PAGE) return;
    mlBudget.set(tabId, mlBudget.get(tabId) + 1);

    if (!classifier.isReady()) return;

    // Classify with latency guard
    const pageContext = requestGraph.getPageContext(tabId);
    const features    = classifier.extractFeatures({ url, type, initiator, timestamp, pageContext });
    const inferStart  = performance.now();
    const score       = await classifier.scoreFromFeatures(features, url);
    const inferMs     = performance.now() - inferStart;

    if (inferMs > 10) {
      console.warn('[AdBlockML] Slow inference ' + inferMs.toFixed(1) + 'ms - aborting ML path');
      return;
    }

    if (config.featureStoreEnabled) {
      await featureStore.observe(url, features[7] ?? 0, features[6] > 0, score >= ML_THRESHOLD);
    }

    const listBlocks = await listManager.wouldBlock(url);

    if (score >= ML_THRESHOLD) {
      const isMLOnly = !listBlocks;

      if (isMLOnly) {
        console.log(
          '[ML-ONLY]' +
          ' score=' + score.toFixed(3) +
          ' inferMs=' + inferMs.toFixed(2) + 'ms' +
          ' type=' + type +
          '\n  URL: ' + url.substring(0, 100)
        );
      } else {
        console.log(
          '[ML+LIST]' +
          ' score=' + score.toFixed(3) +
          ' (list would also block)' +
          '\n  URL: ' + url.substring(0, 100)
        );
      }

      await dynamicRules.addBlock(url, score);
      stats.recordBlock(tabId, url, 'ml', score);
      feedbackEng.recordBlock(tabId, url);
      await eventLogger.log({
        url, features, prediction: score,
        decision: isMLOnly ? 'ml_only' : 'ml_confirmed'
      });

      queueDomainForInjection(tabId, url, score);

    } else {
      if (score >= 0.35) {
        console.log(
          '[NEAR-MISS]' +
          ' score=' + score.toFixed(3) +
          ' threshold=' + ML_THRESHOLD +
          ' type=' + type +
          '\n  URL: ' + url.substring(0, 100)
        );
      }

      stats.recordAllow(tabId, url, score);
      await eventLogger.log({ url, features, prediction: score, decision: 'allow' });
    }

    // ML-only hit tracking
    if (score >= ML_ONLY_THRESHOLD && !listBlocks) {
      await recordMlOnlyHit(url, type, tabId, initiator, score, features);
    }

  } catch (err) {
    console.warn('[AdBlockML] classifyAsync error:', err);
  }
}

// --- Cosmetic injection placeholder ----------------------------------------

function queueDomainForInjection(tabId, url, score) {
  // placeholder - cosmetic engine handles this
}

// --- ML-only hit tracking --------------------------------------------------

async function writeRiskSummary(tabId) {
  try {
    const key = 'ml_summary_' + tabId;
    await chrome.storage.session.set({
      [key]: { tabId, timestamp: Date.now() },
    });
  } catch (err) {
    console.warn('[AdBlockML] writeRiskSummary error:', err);
  }
}

async function recordMlOnlyHit(url, type, tabId, initiator, score, features) {
  const pageStart = tabStartTime.get(tabId);
  if (!pageStart || Date.now() - pageStart > PAGE_WINDOW_MS) return;

  const requestKey = url + '|' + tabId + '|' + initiator + '|' + type;
  const seen = seenRequests.get(tabId) ?? new Set();
  if (seen.has(requestKey)) return;
  seen.add(requestKey);
  seenRequests.set(tabId, seen);

  const domain = getDomain(url);
  const counts = domainCount.get(tabId) ?? new Map();
  const hits   = (counts.get(domain) ?? 0) + 1;
  counts.set(domain, hits);
  domainCount.set(tabId, counts);

  if (hits < DOMAIN_HIT_MIN) return;
  if (hits > DOMAIN_HIT_MAX) return;

  const confidence  = score >= HIGH_CONF ? 'High' : 'Medium';
  const reason      = deriveExplanationTag(features, url);
  const mlOnlyEntry = { type: 'ML', confidence, reason, domain };

  const count = (mlOnlyCount.get(tabId) ?? 0) + 1;
  mlOnlyCount.set(tabId, count);

  await writeMlSummary(tabId, count, mlOnlyEntry);
  await writeRiskSummary(tabId);

  console.log('[AdBlockML] ML-only hit #' + count + ' (' + confidence + '): ' + domain + ' - ' + reason);
}

// --- Session storage pipeline ----------------------------------------------

async function writeMlSummary(tabId, mlOnlyTotal, latestEntry) {
  try {
    const key     = 'ml_summary_' + tabId;
    const current = (await chrome.storage.session.get(key))[key] ?? {};
    const entries = current.entries ?? [];

    entries.push({ ...latestEntry, timestamp: Date.now() });
    if (entries.length > 50) entries.shift();

    await chrome.storage.session.set({
      [key]: {
        ml_only_count: mlOnlyTotal,
        tabId,
        entries,
        timestamp: Date.now(),
      },
    });
  } catch (err) {
    console.warn('[AdBlockML] writeMlSummary error:', err);
  }
}

// --- Explanation tags -------------------------------------------------------

function deriveExplanationTag(features, url) {
  if (!features) return 'ml_pattern';

  const u = url.toLowerCase();
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

// --- Helpers ---------------------------------------------------------------

function getDomain(url) {
  try { return new URL(url).hostname.split('.').slice(-2).join('.'); }
  catch { return url.slice(0, 40); }
}

// --- Tab lifecycle ---------------------------------------------------------

function setupTabListeners() {
  chrome.tabs.onRemoved.addListener((tabId) => {
    seenRequests.delete(tabId);
    domainCount.delete(tabId);
    tabStartTime.delete(tabId);
    mlBudget.delete(tabId);
    mlOnlyCount.delete(tabId);
    requestGraph.pruneTab(tabId);
    feedbackEng.onTabRemoved(tabId);
    chrome.storage.session.remove('ml_summary_' + tabId);
  });
}

// --- Messages --------------------------------------------------------------

function setupMessageListeners() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    if (!__ready) {
      sendResponse({
        global: {},
        tab: {},
        mlSummary: null,
        classifierInfo: { type: 'heuristic' },
        dynamicRuleStats: {},
        runtimeFlags: {}
      });
      return true;
    }

    switch (message.type) {

      case 'GET_STATS': {
        const tabId = message.tabId ?? sender.tab?.id;

        Promise.all([
          stats.getGlobalStats(),
          tabId
            ? stats.getTabStats(tabId)
            : Promise.resolve({ blocked: 0, allowed: 0, mlBlocks: 0, recentBlocks: [] })
        ]).then(([global, tab]) => {

          const safeGlobal = {
            totalBlocked: global?.totalBlocked ?? 0,
            totalAllowed: global?.totalAllowed ?? 0,
            dnrBlocked:   global?.dnrBlocked   ?? 0,
            mlBlocked:    global?.mlBlocked     ?? 0,
            dynamicCache: global?.dynamicCacheBlocked ?? 0,
          };

          const safeTab = {
            blocked:      tab?.blocked      ?? 0,
            allowed:      tab?.allowed      ?? 0,
            mlBlocks:     tab?.mlBlocks     ?? 0,
            recentBlocks: tab?.recentBlocks ?? [],
          };

          if (tabId && safeTab.blocked > 0) {
            try {
              chrome.action.setBadgeText({ text: String(safeTab.blocked), tabId });
              chrome.action.setBadgeBackgroundColor({ color: '#ff6b35', tabId });
            } catch (err) {
              console.warn('[AdBlockML] Badge update failed:', err);
            }
          } else if (tabId) {
            try {
              chrome.action.setBadgeText({ text: '', tabId });
            } catch { /* silent */ }
          }

          sendResponse({ global: safeGlobal, tab: safeTab });
        });

        return true;
      }

      default:
        sendResponse({ ok: true });
        return true;
    }
  });
}

// --- Benchmark -------------------------------------------------------------

async function runBenchmark() {
  const recent = requestGraph.getRecentRequests(200);
  if (!recent.length) return { total: 0, listBlocked: 0, mlOnlyBlocked: 0 };

  let listBlocked = 0, mlOnlyBlocked = 0;

  for (const req of recent) {
    const listBlock = await listManager.wouldBlock(req.url);
    const mlScore   = classifier.isReady()
      ? await classifier.score({ url: req.url, type: req.type, initiator: req.initiator,
                                 timestamp: req.timestamp, pageContext: { requests: recent } })
      : 0;

    if (listBlock) listBlocked++;
    if (mlScore >= ML_THRESHOLD && !listBlock) mlOnlyBlocked++;
  }

  return { total: recent.length, listBlocked, mlOnlyBlocked };
}

// --- Boot ------------------------------------------------------------------

setupMessageListeners();
setupTabListeners();
setupWebRequestListeners();

initialize().catch(console.error);

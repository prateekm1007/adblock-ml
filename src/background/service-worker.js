import { AdFlushClassifier }  from './classifier.js';
import { RequestGraph }       from './request-graph.js';
import { StatsTracker }       from './stats.js';
import { DynamicRuleManager } from './dynamic-rules.js';
import { ListManager }        from './list-manager.js';
import { FeatureStore }       from './feature-store.js';
import { EventLogger }        from './event-logger.js';
import { FeedbackEngine }     from './feedback-engine.js';
import { RuntimeConfig }      from './runtime-config.js';
import { PredictiveBlocker }  from './predictor.js';

const config       = new RuntimeConfig();
const classifier   = new AdFlushClassifier();
const requestGraph = new RequestGraph();
const stats        = new StatsTracker();
const dynamicRules = new DynamicRuleManager();
const listManager  = new ListManager();
const featureStore = new FeatureStore();
const eventLogger  = new EventLogger();
const feedbackEng  = new FeedbackEngine(eventLogger, dynamicRules);
const predictor    = new PredictiveBlocker(classifier, dynamicRules);

let __ready = false;

const ML_THRESHOLD = 0.50;
const HIGH_CONF = 0.75;

async function initialize() {
  console.log('[AdBlockML-MV3] Starting initialization...');

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
      console.error('[AdBlockML-MV3] INIT FAILED -', labels[i], r.reason);
    }
  });

  __ready = true;

  chrome.declarativeNetRequest.getDynamicRules().then(dynamicRuleList => {
    chrome.declarativeNetRequest.getEnabledRulesets().then(rulesets => {
      console.log(
        '[AdBlockML-MV3] READY (Predictive Mode)' +
        '\n  classifier    : ' + classifier.getModelInfo().type +
        '\n  rulesets      : ' + JSON.stringify(rulesets) +
        '\n  dynamic rules : ' + dynamicRuleList.length +
        '\n  ML_THRESHOLD  : ' + ML_THRESHOLD +
        '\n  mode          : PREDICTIVE (MV3)'
      );
    });
  });
}

function setupNavigationListeners() {
  chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
    if (details.frameId !== 0) return;
    if (!__ready) return;

    const { url, tabId } = details;
    console.log('[MV3-Predict] Pre-loading rules for:', url);
    await predictor.predictForNavigation(url);
  });

  chrome.webNavigation.onCommitted.addListener(async (details) => {
    if (details.frameId !== 0) return;
    const { tabId, url } = details;
    
    requestGraph.newPage(tabId, url);
    stats.newPage(tabId, url);
    await feedbackEng.onNavigation(tabId, url);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    requestGraph.pruneTab(tabId);
    feedbackEng.onTabRemoved(tabId);
  });
}

function setupObservationListeners() {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (!__ready) return;
      const { requestId, url, type, tabId, initiator, timeStamp } = details;

      requestGraph.recordRequest({
        requestId, url, type, tabId,
        initiator: initiator || '',
        timestamp: timeStamp,
      });

      learnFromRequest(url, type, tabId, initiator, timeStamp);
    },
    { urls: ['<all_urls>'] }
  );

  chrome.webRequest.onCompleted.addListener(
    (d) => requestGraph.markCompleted(d.requestId, d.statusCode),
    { urls: ['<all_urls>'] }
  );

  chrome.webRequest.onErrorOccurred.addListener(
    (d) => {
      requestGraph.markError(d.requestId, d.error);
      if (d.error === 'net::ERR_BLOCKED_BY_CLIENT') {
        stats.recordBlock(d.tabId, d.url, 'dnr');
        predictor.recordOutcome(d.url, true);
      }
    },
    { urls: ['<all_urls>'] }
  );
}

async function learnFromRequest(url, type, tabId, initiator, timestamp) {
  try {
    if (!classifier.isReady()) return;

    const pageContext = requestGraph.getPageContext(tabId);
    const features = classifier.extractFeatures({ url, type, initiator, timestamp, pageContext });
    const score = await classifier.scoreFromFeatures(features, url);

    if (score >= ML_THRESHOLD) {
      await dynamicRules.addBlock(url, score);
      console.log('[Learn] Added DNR rule for future:', url.substring(0, 80), 'score:', score.toFixed(3));
    }

    await eventLogger.log({ url, features, prediction: score, decision: score >= ML_THRESHOLD ? 'block' : 'allow' });

    if (config.featureStoreEnabled) {
      await featureStore.observe(url, features[7] ?? 0, features[6] > 0, score >= ML_THRESHOLD);
    }

  } catch (err) {
    console.warn('[Learn] Error:', err);
  }
}

function setupMessageListeners() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!__ready) {
      sendResponse({ global: {}, tab: {} });
      return true;
    }

    if (message.type === 'GET_STATS') {
      const tabId = message.tabId ?? sender.tab?.id;

      Promise.all([
        stats.getGlobalStats(),
        tabId ? stats.getTabStats(tabId) : Promise.resolve({ blocked: 0, allowed: 0 })
      ]).then(([global, tab]) => {
        const safeGlobal = {
          totalBlocked: global?.totalBlocked ?? 0,
          totalAllowed: global?.totalAllowed ?? 0,
          dnrBlocked:   global?.dnrBlocked   ?? 0,
          mlBlocked:    global?.mlBlocked     ?? 0,
        };

        const safeTab = {
          blocked: tab?.blocked ?? 0,
          allowed: tab?.allowed ?? 0,
        };

        if (tabId && safeTab.blocked > 0) {
          chrome.action.setBadgeText({ text: String(safeTab.blocked), tabId });
          chrome.action.setBadgeBackgroundColor({ color: '#ff6b35', tabId });
        }

        sendResponse({ global: safeGlobal, tab: safeTab });
      });

      return true;
    }

    sendResponse({ ok: true });
    return true;
  });
}

setupMessageListeners();
setupNavigationListeners();
setupObservationListeners();

initialize().catch(console.error);

console.log('[AdBlockML-MV3] Service worker loaded (Predictive Architecture)');

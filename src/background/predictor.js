export class PredictiveBlocker {
  constructor(classifier, dynamicRules) {
    this._classifier = classifier;
    this._dynamicRules = dynamicRules;
    this._domainHistory = new Map();
  }

  async predictForNavigation(url) {
    if (!this._classifier.isReady()) return;

    try {
      const domain = new URL(url).hostname;
      const commonTrackers = this._getCommonTrackers(domain);

      for (const trackerPattern of commonTrackers) {
        await this._dynamicRules.addBlock(trackerPattern, 0.85);
      }

      console.log(`[Predictor] Pre-loaded ${commonTrackers.length} tracker rules for ${domain}`);
    } catch (err) {
      console.warn('[Predictor] Error:', err);
    }
  }

  _getCommonTrackers(forDomain) {
    const baseTrackers = [
      '*://www.google-analytics.com/*',
      '*://www.googletagmanager.com/*',
      '*://*.doubleclick.net/*',
      '*://connect.facebook.net/*',
      '*://www.facebook.com/tr*',
      '*://*.googlesyndication.com/*',
      '*://bat.bing.com/*',
      '*://*.scorecardresearch.com/*',
      '*://*.chartbeat.com/*',
      '*://*.hotjar.com/*',
    ];

    const history = this._domainHistory.get(forDomain);
    if (history?.frequentTrackers) {
      return [...baseTrackers, ...history.frequentTrackers];
    }

    return baseTrackers;
  }

  recordOutcome(url, wasBlocked) {
    try {
      const domain = new URL(url).hostname;
      const history = this._domainHistory.get(domain) || { blocks: 0, allows: 0, frequentTrackers: [] };
      
      if (wasBlocked) {
        history.blocks++;
      } else {
        history.allows++;
      }
      
      history.lastSeen = Date.now();
      this._domainHistory.set(domain, history);
    } catch {}
  }
}

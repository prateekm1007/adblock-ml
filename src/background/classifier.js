// Enhanced MV3 Classifier with Improved Feature Space (Commands 1, 6, 9)

export class AdFlushClassifier {
  constructor() {
    this._ready = false;
    this._modelType = 'heuristic-enhanced';
  }

  async load() {
    console.log('[Classifier] Enhanced heuristic mode (30 ? 40 features)');
    this._ready = true;
  }

  isReady() {
    return this._ready;
  }

  getModelInfo() {
    return { type: this._modelType, version: 'enhanced-v2' };
  }

  extractFeatures({ url, type, initiator, timestamp, pageContext }) {
    const u = url.toLowerCase();
    const features = new Float32Array(40); // Expanded from 30

    // --- Existing Features (0-25) ---------------------------------------
    features[0] = Math.min(url.length / 200, 1.0);

    try {
      const hostname = new URL(url).hostname;
      features[1] = Math.min((hostname.split('.').length - 2) / 3, 1.0);
    } catch {}

    try {
      features[2] = Math.min((new URL(url).pathname.split('/').length - 1) / 5, 1.0);
    } catch {}

    try {
      features[3] = Math.min((new URL(url).search.split('&').length - 1) / 5, 1.0);
    } catch {}

    features[4] = url.includes('#') ? 1.0 : 0.0;

    const adKeywords = ['ad', 'ads', 'advert', 'banner', 'sponsor', 'promo', 'campaign'];
    features[5] = adKeywords.filter(k => u.includes(k)).length;

    const trackerParams = ['utm_', 'fbclid', 'gclid', '_ga', 'mc_', 'click'];
    features[6] = trackerParams.filter(p => u.includes(p)).length;

    try {
      const path = new URL(url).pathname;
      const uniqueChars = new Set(path).size;
      features[7] = Math.min(uniqueChars / 20, 1.0) * 3;
    } catch {}

    try {
      const query = new URL(url).search;
      const uniqueChars = new Set(query).size;
      features[8] = Math.min(uniqueChars / 20, 1.0) * 3;
    } catch {}

    features[9] = (u.match(/\d/g) || []).length / url.length;
    features[10] = (u.match(/-/g) || []).length / url.length;
    features[11] = (u.match(/_/g) || []).length / url.length;
    features[12] = (u.match(/=/g) || []).length / url.length;
    features[13] = (u.match(/&/g) || []).length / url.length;
    features[14] = (u.match(/\?/g) || []).length / url.length;
    features[15] = (u.match(/\./g) || []).length / url.length;

    const obfuscationPatterns = [/[a-z]{20,}/i, /[0-9]{10,}/, /[A-Z]{5,}/];
    features[16] = obfuscationPatterns.filter(p => p.test(url)).length;

    const trackerDomains = ['doubleclick', 'googlesyndication', 'google-analytics',
                           'facebook.net', 'scorecardresearch', 'criteo'];
    features[17] = trackerDomains.some(d => u.includes(d)) ? 1.0 : 0.0;

    try {
      const reqDomain = new URL(url).hostname;
      const initDomain = initiator ? new URL(initiator).hostname : '';
      features[23] = reqDomain !== initDomain ? 1.0 : 0.0;
    } catch {}

    const suspiciousTypes = ['script', 'xmlhttprequest', 'fetch'];
    features[24] = suspiciousTypes.includes(type) ? 0.8 : 0.2;

    if (pageContext?.pageStartTime && timestamp) {
      const delay = timestamp - pageContext.pageStartTime;
      features[25] = Math.min(delay / 10000, 1.0);
    }

    // --- COMMAND 1: Enhanced Keyword Signals ---------------------------
    const analyticsKeywords = ['analytics', 'beacon', 'collect', 'track', 'pixel', 'events', 'metrics', 'log'];
    features[26] = Math.min(analyticsKeywords.filter(k => u.includes(k)).length / 3, 1.0);

    // --- COMMAND 1: Enhanced Query Params ------------------------------
    const deviceIdParams = ['tid', 'uid', 'cid', 'session', 'device_id', 'client_id', 'visitor_id'];
    features[27] = Math.min(deviceIdParams.filter(p => u.includes(p)).length / 2, 1.0);

    // --- COMMAND 1: Path Pattern Matching ------------------------------
    const pathPatterns = ['/collect', '/events', '/metrics', '/log', '/track', '/analytics', '/beacon'];
    features[28] = pathPatterns.some(p => u.includes(p)) ? 1.0 : 0.0;

    // --- COMMAND 9: First-Party Tracker Detection ----------------------
    try {
      const reqDomain = new URL(url).hostname;
      const initDomain = initiator ? new URL(initiator).hostname : '';
      const isSameDomain = reqDomain === initDomain;
      const hasHighEntropy = features[7] > 2 || features[8] > 2;
      const isLateInjection = features[25] > 0.3;
      const hasTrackerKeywords = features[26] > 0.3 || features[27] > 0.3;
      
      // First-party suspicious if same domain BUT tracker behavior
      // first_party_suspicious: same-domain tracker behavior detected
      features[29] = (isSameDomain && hasHighEntropy && (isLateInjection || hasTrackerKeywords)) ? 1.0 : 0.0;
    } catch {}

    // --- COMMAND 6: Graph Signals (Lightweight) ------------------------
    if (pageContext?.requests) {
      const requests = pageContext.requests || [];
      
      // Initiator depth: how deep in the request chain
      let depth = 0;
      let current = initiator;
      for (let i = 0; i < 5 && current; i++) {
        const parent = pageContext.initiatorMap?.[current];
        if (!parent || parent === current) break;
        depth++;
        current = parent;
      }
      features[30] = Math.min(depth / 3, 1.0);

      // Sibling requests: how many requests from same initiator
      const siblings = requests.filter(r => r.initiator === initiator).length;
      features[31] = Math.min(siblings / 20, 1.0);

      // Fan-out: unique domains this initiator calls
      const initiatedDomains = new Set();
      requests.filter(r => r.initiator === url).forEach(r => {
        try { initiatedDomains.add(new URL(r.url).hostname); } catch {}
      });
      features[32] = Math.min(initiatedDomains.size / 10, 1.0);
    }

    // --- COMMAND 1: Request Timing (Enhanced) --------------------------
    if (pageContext?.loadTime && timestamp) {
      const timeSincePageStart = timestamp - pageContext.loadTime;
      features[33] = Math.min(timeSincePageStart / 30000, 1.0); // Normalized to 30s
    }

    return features;
  }

  async scoreFromFeatures(features, url) {
    let score = 0;

    // Original weights
    score += features[5] * 0.12;   // ad keywords
    score += features[6] * 0.12;   // tracker params
    score += features[7] * 0.08;   // path entropy
    score += features[16] * 0.10;  // obfuscation
    score += features[17] * 0.20;  // known tracker
    score += features[23] * 0.06;  // third-party
    score += features[25] * 0.08;  // late injection

    // COMMAND 1: Enhanced analytics detection
    score += features[26] * 0.18;  // analytics keywords (HIGH WEIGHT)
    score += features[27] * 0.15;  // device ID params
    score += features[28] * 0.12;  // path patterns

    // COMMAND 9: First-party tracker boost
    score += features[29] * 0.25;  // first-party suspicious (CRITICAL)

    // COMMAND 6: Graph signals
    score += features[30] * 0.05;  // initiator depth
    score += features[31] * 0.04;  // sibling count
    score += features[32] * 0.10;  // fan-out (scripts calling many domains)

    // Pattern boosts
    const u = url.toLowerCase();
    if (/\/ad[sx]?\/|\/banner|\/tracking|pixel|beacon/.test(u)) score += 0.18;
    if (/doubleclick|googlesyndication|analytics|facebook\.net/.test(u)) score += 0.22;
    if (/prebid|criteo|outbrain|taboola|chartbeat|hotjar/.test(u)) score += 0.18;
    if (/collect|events|metrics|track|log/.test(u)) score += 0.15; // COMMAND 1

    return Math.min(score, 1.0);
  }

  async score(details) {
    const features = this.extractFeatures(details);
    return this.scoreFromFeatures(features, details.url);
  }
}


/**
 * AdFlushClassifier
 * Feature engineering follows the AdFlush paper (2024).
 * Falls back to heuristic scoring if ONNX model unavailable.
 */

const FEATURE_NAMES = [
  'url_length', 'path_depth', 'query_param_count', 'has_numeric_id',
  'subdomain_depth', 'ad_keyword_count', 'has_tracker_param',
  'path_entropy', 'query_entropy', 'domain_length', 'is_cdn_domain', 'tld_type',
  'avg_identifier_length', 'short_identifier_ratio', 'bracket_dot_ratio',
  'string_literal_density', 'hex_literal_count', 'max_brace_depth',
  'eval_usage', 'fetch_count_in_script', 'beacon_count',
  'initiator_depth', 'sibling_request_count', 'is_third_party',
  'request_timing_zscore', 'late_injection', 'is_ml_eligible_type',
];

const N_FEATURES = FEATURE_NAMES.length;

const AD_KEYWORDS = new Set([
  'ad', 'ads', 'advert', 'advertisement', 'banner', 'sponsor',
  'tracking', 'analytics', 'pixel', 'beacon', 'doubleclick',
  'adsystem', 'adserver', 'pagead', 'adunit', 'prebid', 'dfp',
  'adsense', 'adroll', 'criteo', 'taboola', 'outbrain', 'mgid',
  'quantserve', 'scorecardresearch', 'rubiconproject', 'openx',
  'collect', 'telemetry', 'measure', 'event', 'track', 'log',
]);

const TRACKER_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'msclkid', 'ttclid', '_ga', 'mc_eid',
  'ref', 'affiliate_id', 'aff_id', 'clickid',
  'tid', 'uid', 'cid', 'aid', 'vid', 'sid', 'user_id', 'session_id',
  'gtag', 'ga_id', 'ga4', 'mp_lib', 'v', 'z',
]);

const CDN_PATTERNS = ['cdn', 'static', 'assets', 'media', 'img', 'files', 'cache'];

export class AdFlushClassifier {
  constructor() {
    this._session     = null;
    this._ready       = false;
    this._modelInfo   = { type: 'none', features: N_FEATURES };
    this._cache       = new Map();
    this._cacheMaxSize = 2000;
  }

  async load() {
    console.warn('[Classifier] ONNX disabled (import() forbidden in Service Worker), using heuristic fallback');
    this._modelInfo = { type: 'heuristic', features: N_FEATURES };
    this._ready = true;
  }

  isReady()      { return this._ready; }
  getModelInfo() { return { ...this._modelInfo, cacheSize: this._cache.size }; }

  async score(request) {
    const cacheKey = `${request.url}:${request.type}`;
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);
    const features = this.extractFeatures(request);
    const score    = this._heuristicScore(features, request.url);
    this._cacheSet(cacheKey, score);
    return score;
  }

  extractFeatures(request) {
    const { url, type, initiator = '', timestamp, pageContext = {} } = request;
    const features = new Float32Array(N_FEATURES);

    let parsed;
    try { parsed = new URL(url); }
    catch { return features; }

    const path     = parsed.pathname;
    const query    = parsed.search.slice(1);
    const hostname = parsed.hostname;

    features[0]  = Math.min(url.length, 500);
    features[1]  = (path.match(/\//g) || []).length;
    features[2]  = query ? query.split('&').length : 0;
    features[3]  = /\/\d{5,}\//.test(path) ? 1 : 0;
    features[4]  = (hostname.match(/\./g) || []).length;
    features[5]  = this._countAdKeywords(url);
    features[6]  = this._hasTrackerParam(query) ? 1 : 0;
    features[7]  = this._entropy(path);
    features[8]  = this._entropy(query);
    features[9]  = Math.min(hostname.length, 60);
    features[10] = CDN_PATTERNS.some(p => hostname.includes(p)) ? 1 : 0;
    features[11] = this._tldType(hostname);

    const isScript = type === 'script';
    features[12] = isScript ? this._estimateIdentifierLength(url) : 0;
    features[13] = isScript ? this._estimateShortIdRatio(url) : 0;
    features[14] = this._bracketDotRatio(url);
    features[15] = 0;
    features[16] = (url.match(/0x[0-9a-fA-F]+/g) || []).length;
    features[17] = 0;
    features[18] = url.toLowerCase().includes('eval')   ? 1 : 0;
    features[19] = url.toLowerCase().includes('fetch')  ? 1 : 0;
    features[20] = url.toLowerCase().includes('beacon') ? 1 : 0;

    const allRequests = pageContext.requests || [];
    features[21] = this._initiatorDepth(initiator, pageContext);
    features[22] = this._siblingCount(initiator, allRequests);
    features[23] = this._isThirdParty(url, pageContext.pageUrl || '') ? 1 : 0;
    features[24] = this._timingZScore(timestamp, allRequests);
    features[25] = this._isLateInjection(timestamp, pageContext) ? 1 : 0;
    features[26] = ['script', 'xmlhttprequest', 'fetch', 'image'].includes(type) ? 1 : 0;

    return features;
  }

  _heuristicScore(features, url) {
    let score = 0;
    const urlLower = url.toLowerCase();

    if (features[5] >= 2)      score += 0.35;
    else if (features[5] >= 1) score += 0.20;

    if (features[6]) score += 0.25;
    if (/[?&](tid|uid|cid|aid|vid|sid|user_id|session_id)=/i.test(url)) score += 0.15;
    if (/[?&](ga_id|ga4|mp_lib|gtag|z|v)=/i.test(url))                  score += 0.10;

    if (features[23]) score += 0.10;
    if (features[7] > 3.5) score += 0.10;

    if (this._knownAdDomain(urlLower)) score += 0.40;

    if (/\/(collect|beacon|track|log|telemetry|measure|event|analytics)\//i.test(url)) {
      score += features[23] ? 0.40 : 0.25;
    }

    if (/google-analytics|googletagmanager|gtag|measurement|firebase|amplitude|mixpanel|segment|heap|fullstory|hotjar|chartbeat|newrelic|datadog|logrocket/i.test(url)) {
      score += 0.40;
    }

    if (/facebook\.com|fbevents|pixel\.facebook|fbcdn\.net|instagram\.com.*pixel/i.test(url)) {
      score += 0.40;
    }

    if (/\/(ad|ads|advert|banner|advertising)\//i.test(url)) score += 0.25;

    if (/\bpagead\b/i.test(url))                score += 0.35;
    if (/\bdoubleclick\.net/i.test(url))         score += 0.50;
    if (/googlesyndication\.com/i.test(url))     score += 0.50;

    if (/\b(pixel|beacon|1x1|clear\.gif|spacer\.gif)\b/i.test(url)) {
      score += features[23] ? 0.20 : 0.10;
    }

    if (features[8] > 4.0) score += 0.10;
    if (features[16] > 2)  score += 0.10;

    if (/stripe|payment|checkout|paypal|square|braintree|authorize\.net/i.test(url)) score -= 0.15;
    if (/^https:\/\/(cdn|static|assets|fonts|images|media)[\.-]/i.test(url))         score -= 0.10;
    if (/github\.com|stackoverflow|wikipedia\.org|medium\.com|dev\.to/i.test(url))   score -= 0.10;

    if (features[1] <= 1 && features[5] === 0 && score < 0.15) score = 0;

    return Math.max(0, Math.min(1, score));
  }

  _knownAdDomain(url) {
    const knownDomains = [
      'doubleclick.net', 'googlesyndication.com', 'googletagmanager.com',
      'googletagservices.com', 'google-analytics.com', 'googleadservices.com',
      'facebook.net/en_US/fbevents', 'connect.facebook.net', 'fbcdn.net',
      'pixel.facebook.com', 'instagram.com/tr',
      'amplitude.com', 'mixpanel.com', 'segment.io', 'segment.com',
      'heap.io', 'fullstory.com', 'hotjar.com', 'chartbeat.com',
      'newrelic.com', 'datadog.com', 'logrocket.io', 'sentry.io',
      'scorecardresearch.com', 'quantserve.com', 'moatads.com',
      'amazon-adsystem.com', 'advertising.com', 'adnxs.com',
      'rubiconproject.com', 'pubmatic.com', 'openx.net', 'openx.com',
      'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com',
      'sharethrough.com', 'triplelift.com', 'lijit.com', 'sovrn.com',
      'doubleverify.com', 'adsafeprotected.com', 'everesttech.net',
    ];
    return knownDomains.some(d => url.includes(d));
  }

  _entropy(str) {
    if (!str || str.length < 2) return 0;
    const freq = {};
    for (const c of str) freq[c] = (freq[c] || 0) + 1;
    const len = str.length;
    return -Object.values(freq).reduce((s, n) => {
      const p = n / len;
      return s + p * Math.log2(p);
    }, 0);
  }

  _countAdKeywords(url) {
    const urlLower = url.toLowerCase();
    let count = 0;
    for (const kw of AD_KEYWORDS) {
      if (urlLower.includes(kw)) count++;
    }
    return Math.min(count, 5);
  }

  _hasTrackerParam(query) {
    if (!query) return false;
    const params = query.toLowerCase().split('&').map(p => p.split('=')[0]);
    return params.some(p => TRACKER_PARAMS.has(p));
  }

  _tldType(hostname) {
    const tld = hostname.split('.').pop()?.toLowerCase() || '';
    if (['com', 'net', 'org'].includes(tld)) return 0;
    if (['io', 'co', 'ai', 'app'].includes(tld)) return 1;
    return 2;
  }

  _estimateIdentifierLength(url) {
    const segments = url.split(/[/?=&]/);
    const lengths  = segments.filter(s => /^[a-zA-Z]/.test(s)).map(s => s.length);
    return lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
  }

  _estimateShortIdRatio(url) {
    const segments = url.split(/[/?=&]/);
    const ids      = segments.filter(s => /^[a-zA-Z]/.test(s));
    if (!ids.length) return 0;
    return ids.filter(s => s.length <= 2).length / ids.length;
  }

  _bracketDotRatio(url) {
    const brackets = (url.match(/\[/g) || []).length;
    const dots     = (url.match(/\./g) || []).length;
    return dots > 0 ? brackets / dots : 0;
  }

  _initiatorDepth(initiator, pageContext) {
    if (!initiator || !pageContext.initiatorMap) return 0;
    let depth = 0, current = initiator;
    const visited = new Set();
    while (current && !visited.has(current) && depth < 10) {
      visited.add(current);
      current = pageContext.initiatorMap?.[current] || '';
      depth++;
    }
    return depth;
  }

  _siblingCount(initiator, allRequests) {
    if (!initiator) return 0;
    return allRequests.filter(r => r.initiator === initiator).length;
  }

  _isThirdParty(url, pageUrl) {
    try {
      const reqBase  = new URL(url).hostname.split('.').slice(-2).join('.');
      const pageBase = new URL(pageUrl).hostname.split('.').slice(-2).join('.');
      return reqBase !== pageBase;
    } catch { return false; }
  }

  _timingZScore(timestamp, allRequests) {
    if (!timestamp || allRequests.length < 3) return 0;
    const times    = allRequests.map(r => r.timestamp).filter(Boolean);
    const mean     = times.reduce((a, b) => a + b, 0) / times.length;
    const variance = times.reduce((a, b) => a + (b - mean) ** 2, 0) / times.length;
    const std      = Math.sqrt(variance);
    return std > 0 ? Math.abs((timestamp - mean) / std) : 0;
  }

  _isLateInjection(timestamp, pageContext) {
    if (!timestamp || !pageContext.domContentLoaded) return false;
    return timestamp > pageContext.domContentLoaded + 500;
  }

  _cacheSet(key, value) {
    if (this._cache.size >= this._cacheMaxSize) {
      this._cache.delete(this._cache.keys().next().value);
    }
    this._cache.set(key, value);
  }

  async scoreFromFeatures(features, url = '') {
    const cacheKey = url ? url.slice(0, 80) : features.join(',').slice(0, 60);
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);
    const score = this._heuristicScore(features, url);
    this._cacheSet(cacheKey, score);
    return score;
  }
}

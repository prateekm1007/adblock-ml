/**
 * AdFlush-style request classifier
 *
 * Feature engineering follows the AdFlush paper (2024):
 *   "AdFlush: Leveraging JS AST and Request Graph for Ad Filtering"
 *   F1 ≈ 0.975, 56% less CPU than graph-only models
 *
 * Implementation uses a GBM model exported to ONNX and run via
 * onnxruntime-web. Falls back to heuristic scoring if model unavailable.
 *
 * Total overhead target: <5ms per request on median hardware.
 */

// Feature indices — must match training feature order
const FEATURE_NAMES = [
  // URL features (12)
  'url_length',
  'path_depth',
  'query_param_count',
  'has_numeric_id',
  'subdomain_depth',
  'ad_keyword_count',
  'has_tracker_param',
  'path_entropy',
  'query_entropy',
  'domain_length',
  'is_cdn_domain',
  'tld_type',

  // JS AST approximation features (9)
  'avg_identifier_length',
  'short_identifier_ratio',
  'bracket_dot_ratio',
  'string_literal_density',
  'hex_literal_count',
  'max_brace_depth',
  'eval_usage',
  'fetch_count_in_script',
  'beacon_count',

  // Request graph features (6)
  'initiator_depth',
  'sibling_request_count',
  'is_third_party',
  'request_timing_zscore',
  'late_injection',
  'is_ml_eligible_type',
];

const N_FEATURES = FEATURE_NAMES.length;

// Known ad/tracker keywords for URL scanning
const AD_KEYWORDS = new Set([
  'ad', 'ads', 'advert', 'advertisement', 'banner', 'sponsor',
  'tracking', 'analytics', 'pixel', 'beacon', 'doubleclick',
  'adsystem', 'adserver', 'pagead', 'adunit', 'prebid', 'dfp',
  'adsense', 'adroll', 'criteo', 'taboola', 'outbrain', 'mgid',
  'quantserve', 'scorecardresearch', 'rubiconproject', 'openx',
]);

const TRACKER_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'msclkid', 'ttclid', '_ga', 'mc_eid',
  'ref', 'affiliate_id', 'aff_id', 'clickid',
]);

const CDN_PATTERNS = ['cdn', 'static', 'assets', 'media', 'img', 'files', 'cache'];

export class AdFlushClassifier {
  constructor() {
    this._session = null;      // ONNX InferenceSession
    this._ready = false;
    this._modelInfo = { type: 'none', features: N_FEATURES };
    this._cache = new Map();   // LRU cache: url → score
    this._cacheMaxSize = 2000;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async load() {
    try {
      // Try loading ONNX model (produced by training script)
      await this._loadOnnxModel();
    } catch (err) {
      console.warn('[Classifier] ONNX load failed, using heuristic fallback:', err.message);
      this._modelInfo = { type: 'heuristic', features: N_FEATURES };
      this._ready = true; // Heuristic always works
    }
  }

  async _loadOnnxModel() {
    // onnxruntime-web must be bundled or loaded as a module
    // During development, use the heuristic until model is trained
    const { InferenceSession, Tensor } = await import(
      chrome.runtime.getURL('vendor/ort.min.js')
    );

    const modelUrl = chrome.runtime.getURL('src/ml/model.onnx');
    this._session = await InferenceSession.create(modelUrl, {
      executionProviders: ['wasm'], // WebGPU when available: ['webgpu', 'wasm']
      graphOptimizationLevel: 'all',
    });

    this._ort = { Tensor };
    this._modelInfo = { type: 'onnx_gbm', features: N_FEATURES };
    this._ready = true;
    console.log('[Classifier] ONNX model loaded successfully');
  }

  isReady() { return this._ready; }
  getModelInfo() { return { ...this._modelInfo, cacheSize: this._cache.size }; }

  // ─── Main scoring entry point ──────────────────────────────────────────────

  /**
   * Score a request. Returns probability [0, 1] that it's an ad/tracker.
   * @param {{ url, type, initiator, timestamp, pageContext }} request
   */
  async score(request) {
    const cacheKey = `${request.url}:${request.type}`;
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }

    const features = this.extractFeatures(request);
    let score;

    if (this._session) {
      score = await this._onnxInfer(features);
    } else {
      score = this._heuristicScore(features, request.url);
    }

    this._cacheSet(cacheKey, score);
    return score;
  }

  // ─── Feature Extraction ────────────────────────────────────────────────────

  extractFeatures(request) {
    const { url, type, initiator = '', timestamp, pageContext = {} } = request;
    const features = new Float32Array(N_FEATURES);

    // Parse URL once
    let parsed;
    try { parsed = new URL(url); }
    catch { return features; } // malformed URL → zero features → low score

    const path = parsed.pathname;
    const query = parsed.search.slice(1); // remove leading ?
    const hostname = parsed.hostname;

    // ── URL features ──
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

    // ── JS AST approximation features (only for scripts) ──
    // We approximate from URL/initiator signals since we don't have source
    // In a full implementation these come from webRequest.onBeforeRequest body
    const isScript = type === 'script';
    features[12] = isScript ? this._estimateIdentifierLength(url) : 0;
    features[13] = isScript ? this._estimateShortIdRatio(url) : 0;
    features[14] = this._bracketDotRatio(url);
    features[15] = 0; // string density — needs actual script source
    features[16] = (url.match(/0x[0-9a-fA-F]+/g) || []).length;
    features[17] = 0; // brace depth — needs actual script source
    features[18] = url.toLowerCase().includes('eval') ? 1 : 0;
    features[19] = url.toLowerCase().includes('fetch') ? 1 : 0;
    features[20] = url.toLowerCase().includes('beacon') ? 1 : 0;

    // ── Request graph features ──
    const allRequests = pageContext.requests || [];
    features[21] = this._initiatorDepth(initiator, pageContext);
    features[22] = this._siblingCount(initiator, allRequests);
    features[23] = this._isThirdParty(url, pageContext.pageUrl || '') ? 1 : 0;
    features[24] = this._timingZScore(timestamp, allRequests);
    features[25] = this._isLateInjection(timestamp, pageContext) ? 1 : 0;
    features[26] = ['script', 'xmlhttprequest', 'fetch', 'image'].includes(type) ? 1 : 0;

    return features;
  }

  // ─── ONNX inference ────────────────────────────────────────────────────────

  async _onnxInfer(features) {
    const tensor = new this._ort.Tensor('float32', features, [1, N_FEATURES]);
    const results = await this._session.run({ float_input: tensor });
    // GBM exported via skl2onnx outputs probabilities in output_probability
    const probs = results.output_probability?.data || results.probabilities?.data;
    return probs ? probs[1] : 0.5; // index 1 = P(ad)
  }

  // ─── Heuristic fallback (no model) ────────────────────────────────────────

  /**
   * Deterministic heuristic scoring.
   * Designed to approximate the ML model before it's trained.
   * Based on known ad-network patterns + AdFlush feature importance.
   */
  _heuristicScore(features, url) {
    let score = 0;
    const urlLower = url.toLowerCase();

    // Strong signals (from AdFlush feature importance ranking)
    if (features[5] >= 2) score += 0.35;        // Multiple ad keywords
    else if (features[5] >= 1) score += 0.20;   // One ad keyword

    if (features[6]) score += 0.20;              // Tracker params present

    if (features[23]) score += 0.10;             // Third-party

    if (features[7] > 3.5) score += 0.10;        // High path entropy (obfuscated)

    if (features[1] <= 1 && features[5] === 0) score -= 0.10; // Simple clean path

    // Domain-level known bad actors (supplement for heuristic mode)
    if (this._knownAdDomain(urlLower)) score += 0.40;

    // Structural URL signals
    if (/\/(ad|ads|advert|banner)\//i.test(url)) score += 0.25;
    if (/\bpagead\b/i.test(url)) score += 0.35;
    if (/\bdoubleclick\.net/i.test(url)) score += 0.50;
    if (/googlesyndication\.com/i.test(url)) score += 0.50;
    if (/\bpixel\b/i.test(url) && features[23]) score += 0.15;

    // Obfuscation signals
    if (features[16] > 2) score += 0.10;         // Hex literals in URL
    if (features[8] > 4.0) score += 0.10;        // High query entropy

    return Math.max(0, Math.min(1, score));
  }

  _knownAdDomain(url) {
    const knownDomains = [
      'doubleclick.net', 'googlesyndication.com', 'googletagmanager.com',
      'googletagservices.com', 'google-analytics.com', 'googleadservices.com',
      'facebook.net/en_US/fbevents', 'connect.facebook.net',
      'scorecardresearch.com', 'quantserve.com', 'moatads.com',
      'amazon-adsystem.com', 'advertising.com', 'adnxs.com',
      'rubiconproject.com', 'pubmatic.com', 'openx.net', 'openx.com',
      'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com',
    ];
    return knownDomains.some(d => url.includes(d));
  }

  // ─── Feature helpers ───────────────────────────────────────────────────────

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
    // Proxy: very short random-looking path segments suggest obfuscation
    const segments = url.split(/[/?=&]/);
    const lengths = segments.filter(s => /^[a-zA-Z]/.test(s)).map(s => s.length);
    return lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
  }

  _estimateShortIdRatio(url) {
    const segments = url.split(/[/?=&]/);
    const ids = segments.filter(s => /^[a-zA-Z]/.test(s));
    if (!ids.length) return 0;
    return ids.filter(s => s.length <= 2).length / ids.length;
  }

  _bracketDotRatio(url) {
    const brackets = (url.match(/\[/g) || []).length;
    const dots = (url.match(/\./g) || []).length;
    return dots > 0 ? brackets / dots : 0;
  }

  _initiatorDepth(initiator, pageContext) {
    if (!initiator || !pageContext.initiatorMap) return 0;
    let depth = 0;
    let current = initiator;
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
      const reqBase = new URL(url).hostname.split('.').slice(-2).join('.');
      const pageBase = new URL(pageUrl).hostname.split('.').slice(-2).join('.');
      return reqBase !== pageBase;
    } catch { return false; }
  }

  _timingZScore(timestamp, allRequests) {
    if (!timestamp || allRequests.length < 3) return 0;
    const times = allRequests.map(r => r.timestamp).filter(Boolean);
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    const variance = times.reduce((a, b) => a + (b - mean) ** 2, 0) / times.length;
    const std = Math.sqrt(variance);
    return std > 0 ? Math.abs((timestamp - mean) / std) : 0;
  }

  _isLateInjection(timestamp, pageContext) {
    if (!timestamp || !pageContext.domContentLoaded) return false;
    return timestamp > pageContext.domContentLoaded + 500;
  }

  // ─── Cache (simple LRU) ────────────────────────────────────────────────────

  _cacheSet(key, value) {
    if (this._cache.size >= this._cacheMaxSize) {
      // Evict oldest entry
      this._cache.delete(this._cache.keys().next().value);
    }
    this._cache.set(key, value);
  }
  /**
   * Score from a pre-extracted feature vector (avoids double extraction).
   * Call extractFeatures() first, pass result here.
   */
  async scoreFromFeatures(features) {
    const cacheKey = features.join(',').slice(0, 60);
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);
    const score = this._session
      ? await this._onnxInfer(features)
      : this._heuristicScore(features, '');
    this._cacheSet(cacheKey, score);
    return score;
  }

  /**
   * Hot-swap the ONNX model from an ArrayBuffer.
   * Called by SyncLayer after downloading + validating a new model.
   */
  async loadFromBuffer(buffer, meta) {
    try {
      const { InferenceSession, Tensor } = await import(
        chrome.runtime.getURL('vendor/ort.min.js')
      );
      this._session   = await InferenceSession.create(buffer, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      this._ort       = { Tensor };
      this._modelInfo = { type: 'onnx_gbm', features: N_FEATURES, version: meta?.version ?? 'unknown' };
      this._cache.clear(); // invalidate old scores
      console.log('[Classifier] Hot-swapped to model v' + (meta?.version ?? '?'));
    } catch (err) {
      console.warn('[Classifier] Hot-swap failed:', err.message);
    }
  }

}

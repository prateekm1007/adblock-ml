/**
 * Enhanced FeatureStore
 * - COMMAND 3: Per-domain adaptive thresholds based on FP/TP tracking
 * - Domain reputation scoring
 */

const DB_NAME    = 'adblock_ml';
const DB_VERSION = 1;
const STORE_NAME = 'feature_store';
const EWMA_ALPHA = 0.2;

// COMMAND 3: Adaptive threshold bounds
const THRESHOLD_MIN = 0.50;
const THRESHOLD_MAX = 0.90;
const THRESHOLD_DEFAULT = 0.65;

export class FeatureStore {
  constructor() {
    this._db = null;
    this._buffer = new Map();
    this._flushTimer = null;
  }

  async open() {
    if (this._db) return;
    this._db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'domain_hash' });
          store.createIndex('block_rate', 'block_rate');
          store.createIndex('last_seen',  'last_seen');
          store.createIndex('adaptive_threshold', 'adaptive_threshold'); // COMMAND 3
        }
      };

      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  async observe(url, pathEntropy, hasTracker, wasBlocked) {
    const hash = await this._hashDomain(url);
    if (!hash) return;

    const now     = Date.now();
    let   entry   = this._buffer.get(hash) ?? await this._get(hash);

    if (!entry) {
      entry = {
        domain_hash:         hash,
        request_count:       0,
        block_count:         0,
        block_rate:          0,
        avg_entropy:         pathEntropy,
        tracker_score:       hasTracker ? 1 : 0,
        last_seen:           now,
        first_seen:          now,
        // COMMAND 3: Adaptive threshold fields
        false_positives:     0,
        true_positives:      0,
        adaptive_threshold:  THRESHOLD_DEFAULT,
      };
    }

    entry.request_count++;
    if (wasBlocked) entry.block_count++;
    entry.block_rate    = entry.block_count / entry.request_count;
    entry.avg_entropy   = EWMA_ALPHA * pathEntropy        + (1 - EWMA_ALPHA) * entry.avg_entropy;
    entry.tracker_score = EWMA_ALPHA * (hasTracker ? 1:0) + (1 - EWMA_ALPHA) * entry.tracker_score;
    entry.last_seen     = now;

    this._buffer.set(hash, entry);
    this._scheduleFlush();
  }

  // COMMAND 3: Report false positive (user allowed blocked domain)
  async reportFalsePositive(url) {
    const hash = await this._hashDomain(url);
    if (!hash) return;
    
    let entry = this._buffer.get(hash) ?? await this._get(hash);
    if (!entry) return;
    
    entry.false_positives++;
    
    // Increase threshold to reduce future false positives
    const fpRate = entry.false_positives / Math.max(1, entry.block_count);
    if (fpRate > 0.1) { // >10% FP rate
      entry.adaptive_threshold = Math.min(
        entry.adaptive_threshold + 0.05,
        THRESHOLD_MAX
      );
    }
    
    this._buffer.set(hash, entry);
    this._scheduleFlush();
    console.log(`[FeatureStore] FP recorded for ${hash.substring(0,8)}, threshold ? ${entry.adaptive_threshold.toFixed(2)}`);
  }

  // COMMAND 3: Report true positive (user confirmed block was correct)
  async reportTruePositive(url) {
    const hash = await this._hashDomain(url);
    if (!hash) return;
    
    let entry = this._buffer.get(hash) ?? await this._get(hash);
    if (!entry) return;
    
    entry.true_positives++;
    
    // Lower threshold to catch more similar requests
    const tpRate = entry.true_positives / Math.max(1, entry.request_count);
    if (tpRate > 0.5) { // >50% TP rate
      entry.adaptive_threshold = Math.max(
        entry.adaptive_threshold - 0.03,
        THRESHOLD_MIN
      );
    }
    
    this._buffer.set(hash, entry);
    this._scheduleFlush();
    console.log(`[FeatureStore] TP recorded for ${hash.substring(0,8)}, threshold ? ${entry.adaptive_threshold.toFixed(2)}`);
  }

  // COMMAND 3: Get adaptive threshold for domain
  async getAdaptiveThreshold(url) {
    const hash = await this._hashDomain(url);
    if (!hash) return THRESHOLD_DEFAULT;
    
    const entry = this._buffer.get(hash) ?? await this._get(hash);
    return entry?.adaptive_threshold ?? THRESHOLD_DEFAULT;
  }

  async getFeatures(url) {
    const hash = await this._hashDomain(url);
    if (!hash) return null;
    return this._buffer.get(hash) ?? await this._get(hash);
  }

  async isCachedSafe(url) {
    const f = await this.getFeatures(url);
    if (!f) return false;
    return f.request_count >= 10 && f.block_rate < 0.02;
  }

  async _get(hash) {
    if (!this._db) return null;
    return new Promise((resolve) => {
      const tx  = this._db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(hash);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = () => resolve(null);
    });
  }

  _scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => this._flush(), 3000);
  }

  async _flush() {
    this._flushTimer = null;
    if (!this._db || !this._buffer.size) return;
    const entries = [...this._buffer.values()];
    this._buffer.clear();

    return new Promise((resolve) => {
      const tx    = this._db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      entries.forEach(e => store.put(e));
      tx.oncomplete = resolve;
      tx.onerror    = resolve;
    });
  }

  async _hashDomain(url) {
    try {
      const hostname = new URL(url).hostname;
      const base     = hostname.split('.').slice(-2).join('.');
      const encoded  = new TextEncoder().encode(base);
      const buf      = await crypto.subtle.digest('SHA-1', encoded);
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('').slice(0,16);
    } catch { return null; }
  }
}

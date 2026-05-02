/**
 * FeatureStore
 *
 * IndexedDB-backed store keyed by SHA-1 domain hash.
 * Persists computed features across SW restarts so the classifier
 * can use historical domain signals (request_count, block_rate, etc.)
 * without recomputing from scratch every time.
 *
 * Schema per entry:
 *   domain_hash      → SHA-1 hex of eTLD+1
 *   request_count    → total requests seen from this domain
 *   block_count      → total times this domain was blocked
 *   block_rate       → rolling block_count / request_count
 *   avg_entropy      → EWMA of URL path entropy
 *   tracker_score    → EWMA of has_tracker_param feature
 *   last_seen        → timestamp of last request
 *   first_seen       → timestamp of first request
 */

const DB_NAME    = 'adblock_ml';
const DB_VERSION = 1;
const STORE_NAME = 'feature_store';

// Exponential weighted moving average factor
const EWMA_ALPHA = 0.2;

export class FeatureStore {
  constructor() {
    this._db = null;
    // In-memory write buffer — flush to IDB in batches
    this._buffer = new Map();   // domainHash → entry
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
        }
      };

      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  // ─── Update on every request ──────────────────────────────────────────────

  /**
   * Record a request observation.
   * @param {string} url
   * @param {number} pathEntropy   - pre-computed, avoid double work
   * @param {boolean} hasTracker
   * @param {boolean} wasBlocked
   */
  async observe(url, pathEntropy, hasTracker, wasBlocked) {
    const hash = await this._hashDomain(url);
    if (!hash) return;

    const now     = Date.now();
    let   entry   = this._buffer.get(hash) ?? await this._get(hash);

    if (!entry) {
      entry = {
        domain_hash:   hash,
        request_count: 0,
        block_count:   0,
        block_rate:    0,
        avg_entropy:   pathEntropy,
        tracker_score: hasTracker ? 1 : 0,
        last_seen:     now,
        first_seen:    now,
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

  /** Get stored features for a domain (returns null if unseen) */
  async getFeatures(url) {
    const hash = await this._hashDomain(url);
    if (!hash) return null;
    return this._buffer.get(hash) ?? await this._get(hash);
  }

  /**
   * Returns true if domain is "known safe" — seen many times, never blocked.
   * Used by classifyAsync to skip ML entirely.
   */
  async isCachedSafe(url) {
    const f = await this.getFeatures(url);
    if (!f) return false;
    // Trust safe cache only after 10+ observations with <2% block rate
    return f.request_count >= 10 && f.block_rate < 0.02;
  }

  // ─── IDB helpers ─────────────────────────────────────────────────────────

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
      tx.onerror    = resolve; // non-fatal
    });
  }

  // ─── Hashing ──────────────────────────────────────────────────────────────

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

/**
 * FeatureStore
 * IndexedDB-backed store keyed by SHA-1 domain hash.
 * IDB-RACE FIX: Uses shared DB_NAME + DB_VERSION=4 so that
 * onupgradeneeded fires exactly once, in one place (event-logger.js).
 * This module opens the DB read/write ONLY after event-logger has
 * already initialized it.
 */

const DB_NAME    = 'adblock_ml';
const DB_VERSION = 4;
const STORE_NAME = 'feature_store';
const EWMA_ALPHA = 0.2;

export class FeatureStore {
  constructor() {
    this._db          = null;
    this._buffer      = new Map();
    this._flushTimer  = null;
  }

  async open() {
    if (this._db) return;
    this._db = await new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);

        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('feature_store')) {
            const fs = db.createObjectStore('feature_store', { keyPath: 'domain_hash' });
            fs.createIndex('block_rate', 'block_rate');
            fs.createIndex('last_seen',  'last_seen');
          }
          if (!db.objectStoreNames.contains('events')) {
            const log = db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
            log.createIndex('url_hash',  'url_hash');
            log.createIndex('synced',    'synced');
            log.createIndex('timestamp', 'timestamp');
            log.createIndex('feedback',  'feedback');
          }
        };

        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror   = (e) => {
          console.error('[FeatureStore] IDB open failed:', e.target.error);
          reject(e.target.error);
        };
      } catch (err) {
        console.error('[FeatureStore] IDB open exception:', err);
        reject(err);
      }
    });
  }

  async observe(url, pathEntropy, hasTracker, wasBlocked) {
    const hash = await this._hashDomain(url);
    if (!hash) return;

    const now   = Date.now();
    let   entry = this._buffer.get(hash) ?? await this._get(hash);

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
    entry.avg_entropy   = EWMA_ALPHA * pathEntropy         + (1 - EWMA_ALPHA) * entry.avg_entropy;
    entry.tracker_score = EWMA_ALPHA * (hasTracker ? 1 : 0) + (1 - EWMA_ALPHA) * entry.tracker_score;
    entry.last_seen     = now;

    this._buffer.set(hash, entry);
    this._scheduleFlush();
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
      try {
        const tx  = this._db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(hash);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror   = () => resolve(null);
      } catch {
        resolve(null);
      }
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
      try {
        const tx    = this._db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        entries.forEach(e => store.put(e));
        tx.oncomplete = resolve;
        tx.onerror    = resolve;
      } catch {
        resolve();
      }
    });
  }

  async _hashDomain(url) {
    try {
      const hostname = new URL(url).hostname;
      const base     = hostname.split('.').slice(-2).join('.');
      const encoded  = new TextEncoder().encode(base);
      const buf      = await crypto.subtle.digest('SHA-1', encoded);
      return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
    } catch { return null; }
  }
}

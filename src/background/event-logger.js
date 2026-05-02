/**
 * EventLogger
 * Stores every classification event in IndexedDB.
 * IDB-RACE FIX: Canonical owner of onupgradeneeded for DB_VERSION=4.
 * Creates BOTH feature_store AND events object stores in one handler.
 */

const DB_NAME    = 'adblock_ml';
const DB_VERSION = 4;
const LOG_STORE  = 'events';
const BATCH_SIZE = 50;

export class EventLogger {
  constructor() {
    this._db            = null;
    this._unsyncedCount = 0;
    this._onBatchReady  = null;
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
          if (!db.objectStoreNames.contains(LOG_STORE)) {
            const log = db.createObjectStore(LOG_STORE, { keyPath: 'id', autoIncrement: true });
            log.createIndex('url_hash',  'url_hash');
            log.createIndex('synced',    'synced');
            log.createIndex('timestamp', 'timestamp');
            log.createIndex('feedback',  'feedback');
          }
        };

        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror   = (e) => {
          console.error('[EventLogger] IDB open failed:', e.target.error);
          reject(e.target.error);
        };
      } catch (err) {
        console.error('[EventLogger] IDB open exception:', err);
        reject(err);
      }
    });
    this._unsyncedCount = await this._countUnsynced();
  }

  onBatchReady(fn) { this._onBatchReady = fn; }

  async log({ url, features, prediction, decision }) {
    if (!this._db) return;
    const [urlHash, domainHash] = await Promise.all([
      this._hash(url),
      this._hashDomain(url),
    ]);
    const record = {
      url_hash:    urlHash,
      domain_hash: domainHash,
      features:    features ? Array.from(features) : null,
      prediction:  prediction ?? null,
      decision,
      feedback:    null,
      timestamp:   Date.now(),
      synced:      false,
    };
    await this._put(LOG_STORE, record);
    this._unsyncedCount++;
    if (this._unsyncedCount >= BATCH_SIZE) await this._triggerBatch();
  }

  async attachFeedback(url, feedbackType) {
    if (!this._db) return;
    const urlHash = await this._hash(url);
    const tx      = this._db.transaction(LOG_STORE, 'readwrite');
    const store   = tx.objectStore(LOG_STORE);
    const index   = store.index('url_hash');
    return new Promise((resolve) => {
      const req = index.getAll(urlHash);
      req.onsuccess = () => {
        const records = req.result;
        if (!records.length) { resolve(); return; }
        const latest = records.reduce((a, b) => a.timestamp > b.timestamp ? a : b);
        latest.feedback = feedbackType;
        store.put(latest);
        tx.oncomplete = resolve;
        tx.onerror    = resolve;
      };
      req.onerror = () => resolve();
    });
  }

  async getUnsyncedBatch(limit = 200) {
    if (!this._db) return [];
    const tx    = this._db.transaction(LOG_STORE, 'readonly');
    const store = tx.objectStore(LOG_STORE);
    const index = store.index('synced');
    return new Promise((resolve) => {
      const results = [];
      const req = index.openCursor(IDBKeyRange.only(0));
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor || results.length >= limit) { resolve(results); return; }
        results.push(cursor.value);
        cursor.continue();
      };
      req.onerror = () => resolve(results);
    });
  }

  async markSynced(ids) {
    if (!this._db || !ids.length) return;
    const tx    = this._db.transaction(LOG_STORE, 'readwrite');
    const store = tx.objectStore(LOG_STORE);
    ids.forEach(id => {
      const req = store.get(id);
      req.onsuccess = () => {
        if (req.result) { req.result.synced = true; store.put(req.result); }
      };
    });
    await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
    this._unsyncedCount = Math.max(0, this._unsyncedCount - ids.length);
  }

  async _put(storeName, record) {
    try {
      const tx  = this._db.transaction(storeName, 'readwrite');
      const req = tx.objectStore(storeName).add(record);
      return new Promise(r => { req.onsuccess = r; req.onerror = r; });
    } catch (err) {
      console.error('[EventLogger] _put failed:', err);
    }
  }

  async _countUnsynced() {
    try {
      const tx  = this._db.transaction(LOG_STORE, 'readonly');
      const req = tx.objectStore(LOG_STORE).index('synced').count(IDBKeyRange.only(0));
      return new Promise(r => { req.onsuccess = () => r(req.result); req.onerror = () => r(0); });
    } catch { return 0; }
  }

  async _triggerBatch() {
    if (!this._onBatchReady) return;
    const batch = await this.getUnsyncedBatch(BATCH_SIZE);
    if (batch.length) this._onBatchReady(batch);
  }

  async _hash(str) {
    try {
      const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
      return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
    } catch { return null; }
  }

  async _hashDomain(url) {
    try {
      const base = new URL(url).hostname.split('.').slice(-2).join('.');
      return this._hash(base);
    } catch { return null; }
  }
}

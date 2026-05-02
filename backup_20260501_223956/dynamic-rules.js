/**
 * DynamicRuleManager
 *
 * Two-tier ML-generated DNR rule system:
 *
 *   HIGH confidence (score ≥ 0.92) → immediate block rule, 72h TTL
 *   LOW  confidence (score ≥ 0.78) → observe-only (no DNR rule), 24h TTL
 *
 * The low-confidence tier accumulates evidence before committing a block rule.
 * If the same domain gets 3+ low-confidence hits it is promoted to high.
 *
 * TTL enforcement: a pruning sweep runs every 30 minutes.
 * Cap: 5000 rules total (Chrome hard limit).
 *
 * Priority note: HIGHER priority number wins in DNR.
 *   Block rules:      priority 1
 *   Site allow rules: priority 10  (overrides blocks)
 */

const MAX_RULES         = 4800;    // 200 headroom below Chrome 5000
const BLOCK_PRIORITY    = 1;
const ALLOW_PRIORITY    = 10;
const RULE_ID_OFFSET    = 100_000;
const SITE_ALLOW_OFFSET = 200_000;
const STORAGE_KEY       = 'adblock_ml_dynamic_rules';

const HIGH_CONFIDENCE   = 0.92;
const TTL_HIGH_MS       = 72 * 60 * 60 * 1000;  // 72 hours
const TTL_LOW_MS        = 24 * 60 * 60 * 1000;  // 24 hours
const PRUNE_INTERVAL_MS = 30 * 60 * 1000;        // 30 minutes
const PROMOTE_THRESHOLD = 3;                      // hits before low → high

const RESOURCE_TYPES = [
  'script', 'xmlhttprequest', 'fetch', 'image',
  'sub_frame', 'media', 'object', 'other',
];

export class DynamicRuleManager {
  constructor() {
    // High-confidence: pattern → { id, addedAt }
    this._high       = new Map();
    // Low-confidence: pattern → { hits, firstSeen, lastSeen }
    this._low        = new Map();
    // In-memory block set for O(1) pre-check
    this._blockSet   = new Set();
    // Site whitelist: hostname → rule id
    this._siteAllows = new Map();
    this._nextId     = RULE_ID_OFFSET;
    this._pruneTimer = null;
  }

  async initialize() {
    try {
      const stored = await chrome.storage.session.get(STORAGE_KEY);
      const data   = stored[STORAGE_KEY];
      if (data) {
        this._high       = new Map(Object.entries(data.high       ?? {}));
        this._low        = new Map(Object.entries(data.low        ?? {}));
        this._blockSet   = new Set(data.blockSet  ?? []);
        this._siteAllows = new Map(Object.entries(data.siteAllows ?? {}));
        this._nextId     = data.nextId ?? RULE_ID_OFFSET;
      }
    } catch { /* first run */ }

    // Start TTL pruning
    this._pruneTimer = setInterval(() => this._prune(), PRUNE_INTERVAL_MS);
  }

  /** O(1) fast check before ML — avoids redundant work */
  async isBlocked(url) {
    return this._blockSet.has(this._toPattern(url));
  }

  /**
   * Process a new ML decision.
   * @param {string} url
   * @param {number} score  ML confidence (0-1)
   */
  async addBlock(url, score = 1.0) {
    const pattern = this._toPattern(url);

    if (this._blockSet.has(pattern)) return; // already active

    if (score >= HIGH_CONFIDENCE) {
      await this._addHighConfidence(pattern);
    } else {
      this._recordLowConfidence(pattern);
    }
  }

  /**
   * Remove a block (called by FeedbackEngine on false positive).
   * @param {string} url
   */
  async removeBlock(url) {
    const pattern = this._toPattern(url);
    this._blockSet.delete(pattern);
    this._low.delete(pattern);

    const entry = this._high.get(pattern);
    if (entry) {
      this._high.delete(pattern);
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({
          addRules: [], removeRuleIds: [entry.id],
        });
      } catch { /* rule may already be gone */ }
      this._schedulePersist();
    }
  }

  async disableSite(hostname) {
    if (this._siteAllows.has(hostname)) return;
    const id = SITE_ALLOW_OFFSET + this._siteAllows.size;
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [{
        id, priority: ALLOW_PRIORITY,
        action: { type: 'allow' },
        condition: { requestDomains: [hostname], resourceTypes: RESOURCE_TYPES },
      }],
      removeRuleIds: [],
    });
    this._siteAllows.set(hostname, id);
    this._schedulePersist();
  }

  async enableSite(hostname) {
    const id = this._siteAllows.get(hostname);
    if (!id) return;
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [], removeRuleIds: [id],
    });
    this._siteAllows.delete(hostname);
    this._schedulePersist();
  }

  async clearAll() {
    const ids = [...this._high.values().map(v => v.id), ...this._siteAllows.values()];
    if (ids.length) {
      await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [], removeRuleIds: ids });
    }
    this._high.clear(); this._low.clear();
    this._blockSet.clear(); this._siteAllows.clear();
    this._nextId = RULE_ID_OFFSET;
    await this._persist();
  }

  getStats() {
    return { high: this._high.size, low: this._low.size, total: this._high.size };
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  async _addHighConfidence(pattern) {
    if (this._high.size >= MAX_RULES) await this._evictOldest();

    const id = this._nextId++;
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        addRules: [{
          id, priority: BLOCK_PRIORITY,
          action: { type: 'block' },
          condition: { urlFilter: pattern, resourceTypes: RESOURCE_TYPES },
        }],
        removeRuleIds: [],
      });
      this._high.set(pattern, { id, addedAt: Date.now() });
      this._blockSet.add(pattern);
      this._low.delete(pattern); // graduated from low
      this._schedulePersist();
    } catch (err) {
      console.warn('[DynamicRules] addHigh failed:', err.message);
    }
  }

  _recordLowConfidence(pattern) {
    const existing = this._low.get(pattern);
    const now      = Date.now();

    if (existing) {
      existing.hits++;
      existing.lastSeen = now;
      if (existing.hits >= PROMOTE_THRESHOLD) {
        // Promote to high confidence
        this._addHighConfidence(pattern);
        return;
      }
    } else {
      this._low.set(pattern, { hits: 1, firstSeen: now, lastSeen: now });
    }
    this._schedulePersist();
  }

  async _prune() {
    const now      = Date.now();
    const toRemove = [];

    for (const [pattern, entry] of this._high) {
      if (now - entry.addedAt > TTL_HIGH_MS) {
        toRemove.push({ pattern, id: entry.id });
      }
    }

    for (const [pattern, entry] of this._low) {
      if (now - entry.lastSeen > TTL_LOW_MS) {
        this._low.delete(pattern);
      }
    }

    if (!toRemove.length) return;

    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        addRules: [], removeRuleIds: toRemove.map(r => r.id),
      });
    } catch { /* best effort */ }

    toRemove.forEach(({ pattern }) => {
      this._high.delete(pattern);
      this._blockSet.delete(pattern);
    });

    console.log(`[DynamicRules] Pruned ${toRemove.length} expired rules`);
    await this._persist();
  }

  async _evictOldest() {
    // Evict the oldest high-confidence rule
    let oldestPattern = null, oldestTime = Infinity;
    for (const [p, e] of this._high) {
      if (e.addedAt < oldestTime) { oldestTime = e.addedAt; oldestPattern = p; }
    }
    if (oldestPattern) await this.removeBlock(oldestPattern.replace('||','').replace('^',''));
  }

  _toPattern(url) {
    try { return `||${new URL(url).hostname}^`; }
    catch { return url; }
  }

  _scheduleTimer = null;
  _schedulePersist() {
    if (this._scheduleTimer) clearTimeout(this._scheduleTimer);
    this._scheduleTimer = setTimeout(() => this._persist(), 500);
  }

  async _persist() {
    const highObj = {};
    this._high.forEach((v, k) => { highObj[k] = v; });
    const lowObj = {};
    this._low.forEach((v, k) => { lowObj[k] = v; });

    try {
      await chrome.storage.session.set({
        [STORAGE_KEY]: {
          high: highObj, low: lowObj,
          blockSet:   [...this._blockSet],
          siteAllows: Object.fromEntries(this._siteAllows),
          nextId:     this._nextId,
        },
      });
    } catch { /* session storage unavailable */ }
  }
}

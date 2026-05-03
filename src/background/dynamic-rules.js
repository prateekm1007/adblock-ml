/**
 * Enhanced DynamicRuleManager
 * - COMMAND 2: Session-based domain promotion (=3 hits ? DNR rule)
 * - TTL-based rule expiration
 */

const MAX_RULES         = 4800;
const BLOCK_PRIORITY    = 1;
const ALLOW_PRIORITY    = 10;
const RULE_ID_OFFSET    = 100_000;
const SITE_ALLOW_OFFSET = 200_000;
const STORAGE_KEY       = 'adblock_ml_dynamic_rules';

const HIGH_CONFIDENCE   = 0.90; // COMMAND 2: Increased from 0.92
const TTL_HIGH_MS       = 72 * 60 * 60 * 1000;
const TTL_LOW_MS        = 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 30 * 60 * 1000;
const PROMOTE_THRESHOLD = 3; // COMMAND 2: Domain must appear 3x in session

const RESOURCE_TYPES = [
  'script', 'xmlhttprequest', 'fetch', 'image',
  'sub_frame', 'media', 'object', 'other',
];

export class DynamicRuleManager {
  constructor() {
    this._high          = new Map(); // pattern ? { id, addedAt, confidence, domain }
    this._low           = new Map(); // pattern ? { hits, firstSeen, lastSeen }
    this._blockSet      = new Set();
    this._siteAllows    = new Map();
    this._nextId        = RULE_ID_OFFSET;
    this._pruneTimer    = null;
    this._scheduleTimer = null;
    
    // COMMAND 2: Session-based promotion tracking
    this._sessionDomains = new Map(); // domain ? hit count
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
        this._sessionDomains = new Map(Object.entries(data.sessionDomains ?? {}));
      }
    } catch { /* first run */ }
    this._pruneTimer = setInterval(() => this._prune(), PRUNE_INTERVAL_MS);
  }

  async isBlocked(url) {
    return this._blockSet.has(this._toPattern(url));
  }

  // COMMAND 2: Enhanced addBlock with session promotion
  async addBlock(url, score = 1.0) {
    const pattern = this._toPattern(url);
    const domain = this._extractDomain(url);
    
    if (this._blockSet.has(pattern)) return;
    
    // Track domain hits for promotion
    const hits = (this._sessionDomains.get(domain) || 0) + 1;
    this._sessionDomains.set(domain, hits);
    
    // COMMAND 2: Auto-promote if =3 hits in session OR high confidence
    if (score >= HIGH_CONFIDENCE || hits >= PROMOTE_THRESHOLD) {
      await this._addHighConfidence(pattern, score, domain);
      console.log(`[DNR-Promote] ${domain} (hits=${hits}, score=${score.toFixed(3)})`);
    } else {
      this._recordLowConfidence(pattern);
    }
  }

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
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        addRules: [{
          id, priority: ALLOW_PRIORITY,
          action: { type: 'allow' },
          condition: { requestDomains: [hostname], resourceTypes: RESOURCE_TYPES },
        }],
        removeRuleIds: [],
      });
    } catch (err) {
      console.error('[DynamicRules] disableSite failed:', err);
    }
    this._siteAllows.set(hostname, id);
    this._schedulePersist();
  }

  async enableSite(hostname) {
    const id = this._siteAllows.get(hostname);
    if (!id) return;
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        addRules: [], removeRuleIds: [id],
      });
    } catch (err) {
      console.error('[DynamicRules] enableSite failed:', err);
    }
    this._siteAllows.delete(hostname);
    this._schedulePersist();
  }

  async clearAll() {
    const highIds = [...this._high.values()].map(v => v.id);
    const siteIds = [...this._siteAllows.values()];
    const ids     = [...highIds, ...siteIds];
    if (ids.length) {
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [], removeRuleIds: ids });
      } catch (err) {
        console.error('[DynamicRules] clearAll failed:', err);
      }
    }
    this._high.clear();
    this._low.clear();
    this._blockSet.clear();
    this._siteAllows.clear();
    this._sessionDomains.clear();
    this._nextId = RULE_ID_OFFSET;
    await this._persist();
  }

  getStats() {
    return {
      high: this._high.size,
      low: this._low.size,
      total: this._high.size,
      sessionDomains: this._sessionDomains.size,
    };
  }

  // COMMAND 2: Store confidence + domain for TTL calculation
  async _addHighConfidence(pattern, confidence, domain) {
    if (this._high.size >= MAX_RULES) await this._evictOldest();
    const id = this._nextId++;
    const ttl = confidence >= 0.95 ? TTL_HIGH_MS : TTL_LOW_MS;
    
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        addRules: [{
          id, priority: BLOCK_PRIORITY,
          action: { type: 'block' },
          condition: { urlFilter: pattern, resourceTypes: RESOURCE_TYPES },
        }],
        removeRuleIds: [],
      });
      this._high.set(pattern, {
        id,
        addedAt: Date.now(),
        confidence,
        domain,
        ttl,
      });
      this._blockSet.add(pattern);
      this._low.delete(pattern);
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
        const domain = this._extractDomain(pattern);
        this._addHighConfidence(pattern, 0.85, domain);
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
    
    // COMMAND 2: Use per-rule TTL instead of global
    for (const [pattern, entry] of this._high) {
      const age = now - entry.addedAt;
      const ttl = entry.ttl || TTL_HIGH_MS;
      if (age > ttl) {
        toRemove.push({ pattern, id: entry.id });
      }
    }
    
    for (const [pattern, entry] of this._low) {
      if (now - entry.lastSeen > TTL_LOW_MS) this._low.delete(pattern);
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
    let oldestPattern = null, oldestTime = Infinity;
    for (const [p, e] of this._high) {
      if (e.addedAt < oldestTime) { oldestTime = e.addedAt; oldestPattern = p; }
    }
    if (oldestPattern) {
      await this.removeBlock(oldestPattern.replace('||', '').replace('^', ''));
    }
  }

  _toPattern(url) {
    try { return `||${new URL(url).hostname}^`; }
    catch { return url; }
  }

  _extractDomain(url) {
    try {
      const hostname = new URL(url).hostname;
      return hostname.split('.').slice(-2).join('.');
    } catch {
      return url.substring(0, 30);
    }
  }

  _schedulePersist() {
    if (this._scheduleTimer) clearTimeout(this._scheduleTimer);
    this._scheduleTimer = setTimeout(() => this._persist(), 500);
  }

  async _persist() {
    const highObj = {};
    this._high.forEach((v, k) => { highObj[k] = v; });
    const lowObj = {};
    this._low.forEach((v, k) => { lowObj[k] = v; });
    const sessionObj = {};
    this._sessionDomains.forEach((v, k) => { sessionObj[k] = v; });
    
    try {
      await chrome.storage.session.set({
        [STORAGE_KEY]: {
          high:           highObj,
          low:            lowObj,
          blockSet:       [...this._blockSet],
          siteAllows:     Object.fromEntries(this._siteAllows),
          sessionDomains: sessionObj,
          nextId:         this._nextId,
        },
      });
    } catch (err) {
      console.error('[DynamicRules] _persist failed:', err);
    }
  }
}

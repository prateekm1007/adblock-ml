/**
 * StatsTracker
 * STATS-SAVINGS: savedBytes is present in _global and accumulated
 * in recordBlock() per source type. No regression from prior version.
 */

const STORAGE_KEY      = 'adblock_ml_stats';
const SAVE_DEBOUNCE_MS = 2000;

export class StatsTracker {
  constructor() {
    this._global = {
      totalBlocked:         0,
      dnrBlocked:           0,
      mlBlocked:            0,
      dynamicCacheBlocked:  0,
      totalAllowed:         0,
      sessionsCount:        0,
      mlScoreHistogram:     new Array(10).fill(0),
      savedBytes:           0,    // STATS-SAVINGS: present and initialised
    };
    this._tabs      = new Map();
    this._saveTimer = null;
  }

  async load() {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      if (stored[STORAGE_KEY]) {
        Object.assign(this._global, stored[STORAGE_KEY]);
        if (!Array.isArray(this._global.mlScoreHistogram)) {
          this._global.mlScoreHistogram = new Array(10).fill(0);
        }
        if (typeof this._global.savedBytes !== 'number') {
          this._global.savedBytes = 0;
        }
      }
    } catch (err) {
      console.error('[Stats] Failed to load:', err);
    }
    this._global.sessionsCount = (this._global.sessionsCount || 0) + 1;
    this._scheduleSave();
  }

  recordBlock(tabId, url, source, mlScore) {
    this._global.totalBlocked++;
    if (source === 'dnr')               this._global.dnrBlocked++;
    else if (source === 'ml')           this._global.mlBlocked++;
    else if (source === 'dynamic_cache') this._global.dynamicCacheBlocked++;

    if (mlScore !== undefined) {
      const bucket = Math.min(Math.floor(mlScore * 10), 9);
      this._global.mlScoreHistogram[bucket]++;
    }

    // STATS-SAVINGS: accumulate saved bytes per source type
    const bytes = source === 'dnr' ? 40 : (source === 'ml' ? 12 : 25);
    this._global.savedBytes += bytes;

    const tab = this._getOrCreateTab(tabId);
    tab.blocked++;
    if (source === 'ml') tab.mlBlocks = (tab.mlBlocks || 0) + 1;
    tab.savedBytes = (tab.savedBytes || 0) + bytes;
    tab.blockSources[source] = (tab.blockSources[source] || 0) + 1;
    tab.recentBlocks.push({ url, source, mlScore, ts: Date.now() });
    if (tab.recentBlocks.length > 50) tab.recentBlocks.shift();

    this._scheduleSave();
  }

  recordAllow(tabId, url, mlScore) {
    this._global.totalAllowed++;
    if (tabId != null) this._getOrCreateTab(tabId).allowed++;
  }

  newPage(tabId, url) {
    this._tabs.set(tabId, {
      tabId,
      pageUrl:      url,
      blocked:      0,
      allowed:      0,
      mlBlocks:     0,
      savedBytes:   0,
      blockSources: {},
      recentBlocks: [],
      startTime:    Date.now(),
    });
  }

  async getGlobalStats() {
    return {
      ...this._global,
      savedBytesDisplay: (this._global.savedBytes / 1024 / 1024).toFixed(1) + ' MB',
    };
  }

  async getTabStats(tabId) {
    const tab = this._tabs.get(tabId);
    if (!tab) return null;
    return { ...tab, recentBlocks: [...tab.recentBlocks] };
  }

  _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._save(), SAVE_DEBOUNCE_MS);
  }

  async _save() {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: this._global });
    } catch (err) {
      console.error('[Stats] Failed to save:', err);
    }
  }

  _getOrCreateTab(tabId) {
    if (!this._tabs.has(tabId)) this.newPage(tabId, '');
    return this._tabs.get(tabId);
  }
}

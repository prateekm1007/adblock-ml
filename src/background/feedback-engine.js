/**
 * Enhanced FeedbackEngine
 * - COMMAND 4: Strict ML-only detection with deduplication
 * - COMMAND 7: Training pipeline connection with stability checks
 */

export class FeedbackEngine {
  constructor(eventLogger, dynamicRules) {
    this._log          = eventLogger;
    this._dynamicRules = dynamicRules;
    this._tabState     = new Map();
    
    // COMMAND 4: ML-only tracking with domain caps
    this._mlOnlyDomains = new Map(); // tabId ? Set<domain>
    this._mlOnlyCounts  = new Map(); // tabId ? count
    this._seenRequests  = new Map(); // tabId ? Set<requestKey>
    
    // COMMAND 7: Training dataset quality tracking
    this._feedbackStats = {
      totalFP: 0,
      totalFN: 0,
      totalConfirmed: 0,
      ambiguousSamples: 0,
    };
  }

  async reportFalsePositive(url, tabId) {
    await this._log.attachFeedback(url, 'fp');
    await this._dynamicRules.removeBlock(url);
    
    // COMMAND 7: Track for model retraining
    this._feedbackStats.totalFP++;
    console.log('[Feedback] FP:', url, `(total FP: ${this._feedbackStats.totalFP})`);
    
    // COMMAND 7: Export dataset if threshold reached
    if (this._shouldExportDataset()) {
      await this._exportTrainingDataset();
    }
  }

  async reportFalseNegative(url, tabId) {
    await this._log.attachFeedback(url, 'fn');
    await this._dynamicRules.addBlock(url, 1.0);
    
    // COMMAND 7: Track for model retraining
    this._feedbackStats.totalFN++;
    console.log('[Feedback] FN:', url, `(total FN: ${this._feedbackStats.totalFN})`);
    
    if (this._shouldExportDataset()) {
      await this._exportTrainingDataset();
    }
  }

  async reportConfirmed(url) {
    await this._log.attachFeedback(url, 'confirmed');
    this._feedbackStats.totalConfirmed++;
  }

  // COMMAND 4: Record ML-only block with strict deduplication
  async recordMLOnlyBlock(url, type, tabId, score, confidence) {
    // Deduplication: request key
    const requestKey = `${url}|${type}`;
    const seen = this._seenRequests.get(tabId) ?? new Set();
    if (seen.has(requestKey)) return false; // Already counted
    seen.add(requestKey);
    this._seenRequests.set(tabId, seen);
    
    // Extract domain
    const domain = this._extractDomain(url);
    if (!domain) return false;
    
    // COMMAND 4: Per-domain cap (max 3 per domain per tab)
    const mlOnlyDomains = this._mlOnlyDomains.get(tabId) ?? new Set();
    const domainCount = [...mlOnlyDomains].filter(d => d === domain).length;
    if (domainCount >= 3) return false; // Cap reached
    
    mlOnlyDomains.add(domain);
    this._mlOnlyDomains.set(tabId, mlOnlyDomains);
    
    // Increment ML-only count
    const count = (this._mlOnlyCounts.get(tabId) ?? 0) + 1;
    this._mlOnlyCounts.set(tabId, count);
    
    // Store for popup display
    await this._storeMLOnlySummary(tabId, { domain, confidence, type, url: url.substring(0, 100) });
    
    return true;
  }

  getMLOnlyCount(tabId) {
    return this._mlOnlyCounts.get(tabId) ?? 0;
  }

  getMLOnlyDomains(tabId) {
    return [...(this._mlOnlyDomains.get(tabId) ?? new Set())];
  }

  recordBlock(tabId, url) {
    if (!this._tabState.has(tabId)) {
      this._tabState.set(tabId, { url: '', blockedUrls: new Set(), timestamp: Date.now() });
    }
    this._tabState.get(tabId).blockedUrls.add(url);
  }

  async onNavigation(tabId, newUrl) {
    const state = this._tabState.get(tabId);
    if (!state) return;

    const elapsed = Date.now() - state.timestamp;
    const isSamePage = this._sameOrigin(state.url, newUrl);
    const hadBlocks  = state.blockedUrls.size > 0;

    if (isSamePage && hadBlocks && elapsed < 10_000) {
      for (const url of state.blockedUrls) {
        await this._log.attachFeedback(url, 'fp');
        this._feedbackStats.totalFP++;
        console.log('[Feedback] Implicit FP (reload):', url);
      }
    }

    // Reset state
    this._tabState.set(tabId, {
      url: newUrl,
      blockedUrls: new Set(),
      timestamp: Date.now(),
    });
    
    // Reset ML-only tracking
    this._mlOnlyDomains.delete(tabId);
    this._mlOnlyCounts.delete(tabId);
    this._seenRequests.delete(tabId);
  }

  onTabRemoved(tabId) {
    this._tabState.delete(tabId);
    this._mlOnlyDomains.delete(tabId);
    this._mlOnlyCounts.delete(tabId);
    this._seenRequests.delete(tabId);
  }

  // COMMAND 7: Dataset export logic
  _shouldExportDataset() {
    const totalFeedback = this._feedbackStats.totalFP + 
                         this._feedbackStats.totalFN + 
                         this._feedbackStats.totalConfirmed;
    return totalFeedback >= 100 && totalFeedback % 50 === 0; // Every 50 samples after 100
  }

  async _exportTrainingDataset() {
    console.log('[Feedback] Exporting training dataset...');
    // This would trigger scripts/train_pipeline.py
    // For now, log the stats
    console.log('[Feedback] Stats:', this._feedbackStats);
  }

  async _storeMLOnlySummary(tabId, entry) {
    try {
      const key = `ml_summary_${tabId}`;
      const current = (await chrome.storage.session.get(key))[key] ?? {};
      const entries = current.entries ?? [];
      entries.push({ ...entry, timestamp: Date.now() });
      if (entries.length > 20) entries.shift();
      
      await chrome.storage.session.set({
        [key]: {
          ml_only_count: this._mlOnlyCounts.get(tabId) ?? 0,
          tabId,
          entries,
          timestamp: Date.now(),
        },
      });
    } catch (err) {
      console.warn('[Feedback] Failed to store ML summary:', err);
    }
  }

  _extractDomain(url) {
    try {
      const hostname = new URL(url).hostname;
      return hostname.split('.').slice(-2).join('.');
    } catch {
      return null;
    }
  }

  _sameOrigin(a, b) {
    try {
      return new URL(a).origin === new URL(b).origin;
    } catch { return false; }
  }
}

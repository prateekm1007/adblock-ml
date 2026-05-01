/**
 * FeedbackEngine
 *
 * Collects three types of feedback and attaches them to event log entries.
 *
 * 1. Explicit — user clicks "Blocked incorrectly" or "Block missed"
 * 2. Implicit — reload after block (false positive signal)
 * 3. Passive  — nothing (future: time-on-page, click-through)
 *
 * Feedback types stored:
 *   'fp'        → false positive (we blocked something we shouldn't have)
 *   'fn'        → false negative (user says we missed a block)
 *   'confirmed' → user confirms block was correct
 */

export class FeedbackEngine {
  /**
   * @param {EventLogger}    eventLogger
   * @param {DynamicRuleManager} dynamicRules
   */
  constructor(eventLogger, dynamicRules) {
    this._log          = eventLogger;
    this._dynamicRules = dynamicRules;

    // Track recent tab navigations to detect "reload after block"
    // tabId → { url, blockedUrls: Set, timestamp }
    this._tabState = new Map();
  }

  // ─── Explicit feedback (from popup UI) ───────────────────────────────────

  /**
   * User says a URL was blocked but shouldn't have been (false positive).
   * @param {string} url
   */
  async reportFalsePositive(url) {
    await this._log.attachFeedback(url, 'fp');

    // Remove the dynamic block rule immediately — restore access
    await this._dynamicRules.removeBlock(url);

    console.log('[Feedback] FP reported:', url);
  }

  /**
   * User says a URL was allowed but should have been blocked (false negative).
   * @param {string} url
   */
  async reportFalseNegative(url) {
    await this._log.attachFeedback(url, 'fn');

    // Add to dynamic rules immediately — user has confirmed this is an ad
    await this._dynamicRules.addBlock(url);

    console.log('[Feedback] FN reported:', url);
  }

  /**
   * User confirms a block was correct.
   * @param {string} url
   */
  async reportConfirmed(url) {
    await this._log.attachFeedback(url, 'confirmed');
  }

  // ─── Implicit feedback (reload detection) ────────────────────────────────

  /**
   * Record that a URL was blocked on a tab — used to detect reloads.
   * Called by service worker after a block decision.
   */
  recordBlock(tabId, url) {
    if (!this._tabState.has(tabId)) {
      this._tabState.set(tabId, { url: '', blockedUrls: new Set(), timestamp: Date.now() });
    }
    this._tabState.get(tabId).blockedUrls.add(url);
  }

  /**
   * Called when a tab navigates. If the same page reloads within 10s of
   * having blocks, it's a strong false positive signal.
   * @param {number} tabId
   * @param {string} newUrl
   */
  async onNavigation(tabId, newUrl) {
    const state = this._tabState.get(tabId);
    if (!state) return;

    const elapsed = Date.now() - state.timestamp;
    const isSamePage = this._sameOrigin(state.url, newUrl);
    const hadBlocks  = state.blockedUrls.size > 0;

    if (isSamePage && hadBlocks && elapsed < 10_000) {
      // Quick reload with blocks present → likely false positive
      for (const url of state.blockedUrls) {
        await this._log.attachFeedback(url, 'fp');
        console.log('[Feedback] Implicit FP (reload):', url);
      }
    }

    // Reset for new page
    this._tabState.set(tabId, {
      url: newUrl,
      blockedUrls: new Set(),
      timestamp: Date.now(),
    });
  }

  onTabRemoved(tabId) {
    this._tabState.delete(tabId);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  _sameOrigin(a, b) {
    try {
      return new URL(a).origin === new URL(b).origin;
    } catch { return false; }
  }
}

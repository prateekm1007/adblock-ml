/**
 * RequestGraph
 */

const MAX_REQUESTS_PER_TAB = 500;
const MAX_RECENT_GLOBAL    = 1000;

export class RequestGraph {
  constructor() {
    this._pages  = new Map();
    this._recent = [];
  }

  newPage(tabId, url) {
    this._pages.set(tabId, {
      tabId, pageUrl: url,
      requests: [],
      initiatorMap: {},
      domContentLoaded: null,
      loadTime: Date.now(),
    });
  }

  _getOrCreate(tabId) {
    if (!this._pages.has(tabId)) this.newPage(tabId, '');
    return this._pages.get(tabId);
  }

  recordRequest({ requestId, url, type, tabId, initiator, timestamp }) {
    const page  = this._getOrCreate(tabId);
    const entry = { requestId, url, type, initiator, timestamp, status: 'pending' };
    if (page.requests.length >= MAX_REQUESTS_PER_TAB) page.requests.shift();
    page.requests.push(entry);
    if (initiator) page.initiatorMap[url] = initiator;
    this._recent.push(entry);
    if (this._recent.length > MAX_RECENT_GLOBAL) this._recent.shift();
  }

  markCompleted(requestId, statusCode) {
    this._patchRecent(requestId, { status: 'completed', statusCode });
  }

  markError(requestId, error) {
    this._patchRecent(requestId, { status: 'error', error });
  }

  _patchRecent(requestId, updates) {
    for (let i = this._recent.length - 1; i >= 0; i--) {
      if (this._recent[i].requestId === requestId) {
        Object.assign(this._recent[i], updates);
        return;
      }
    }
  }

  getPageContext(tabId) {
    return this._pages.get(tabId) ?? {
      pageUrl: '', requests: [], initiatorMap: {}, domContentLoaded: null,
    };
  }

  getRecentRequests(n = 200) {
    return this._recent.slice(-n);
  }

  pruneTab(tabId) {
    this._pages.delete(tabId);
  }

  _baseDomain(url) {
    try { return new URL(url).hostname.split('.').slice(-2).join('.'); }
    catch { return ''; }
  }
}

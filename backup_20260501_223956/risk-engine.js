/**
 * Risk Engine v1 - Stable Pattern-Based Scoring
 */
export class RiskEngine {
  constructor() {
    this._tabRisks = new Map();
    this._signalHistory = new Map();
    this._stabilityWindow = new Map();
  }

  recordSignal(tabId, signal, detected) {
    if (!['late_injection','obfuscation','first_party_tracking','multi_domain'].includes(signal)) return;
    if (!this._signalHistory.has(tabId)) {
      this._signalHistory.set(tabId, new Map());
      this._stabilityWindow.set(tabId, { prevScore: 0, prevLevel: 'LOW', timestamp: Date.now() });
    }
    const history = this._signalHistory.get(tabId);
    const log = history.get(signal) || [];
    log.push(detected);
    if (log.length > 3) log.shift();
    history.set(signal, log);
    this._computeRisk(tabId);
  }

  getPageRisk(tabId) {
    return this._tabRisks.get(tabId) || { level: 'LOW', score: 0, reasons: [], confidence: 1.0 };
  }

  resetTab(tabId) {
    this._tabRisks.delete(tabId);
    this._signalHistory.delete(tabId);
    this._stabilityWindow.delete(tabId);
  }

  _computeRisk(tabId) {
    const signals = this._signalHistory.get(tabId) || new Map();
    const stability = this._stabilityWindow.get(tabId) || {};
    const sc = this._aggregateSignals(signals);
    let score = 0;
    const reasons = [];
    if (sc.late_injection >= 0.5)       { score += 35; reasons.push('Late script injection detected'); }
    if (sc.obfuscation >= 0.4)          { score += 25; reasons.push('Obfuscated tracking patterns'); }
    if (sc.first_party_tracking >= 0.5) { score += 20; reasons.push('First-party tracking signals'); }
    if (sc.multi_domain >= 0.6)         { score += 15; reasons.push('Multi-domain coordination detected'); }
    const smoothed = this._smoothScore(score, stability.prevScore || 0, Date.now() - (stability.timestamp || 0));
    const level = smoothed >= 60 ? 'HIGH' : (smoothed >= 30 ? 'MEDIUM' : 'LOW');
    const confidence = level === 'HIGH' ? 0.85 : (level === 'MEDIUM' ? 0.75 : 0.9);
    this._tabRisks.set(tabId, { level, score: Math.round(smoothed), reasons, confidence });
    this._stabilityWindow.set(tabId, { prevScore: smoothed, prevLevel: level, timestamp: Date.now() });
  }

  _aggregateSignals(map) {
    const c = { late_injection: 0, obfuscation: 0, first_party_tracking: 0, multi_domain: 0 };
    for (const [k, v] of map) {
      if (!v.length) continue;
      const rate = v.filter(Boolean).length / v.length;
      c[k] = Math.min(1, rate * (v.at(-1) ? 1.2 : 0.8));
    }
    return c;
  }

  _smoothScore(raw, prev, elapsed) {
    if (elapsed < 10000) return prev * 0.8 + raw * 0.2;
    if (elapsed < 30000) return prev * 0.5 + raw * 0.5;
    return raw;
  }
}

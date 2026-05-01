/**
 * Risk Engine v1 — Pattern-Based Page Safety Scoring
 */

export class RiskEngine {
  constructor() {
    this._tabRisks = new Map();
    this._signalHistory = new Map();
    this._stabilityWindow = new Map();
  }

  recordSignal(tabId, signal, detected, meta = {}) {
    if (!['late_injection', 'obfuscation', 'first_party_tracking', 'multi_domain'].includes(signal)) {
      console.warn(`[RiskEngine] Unknown signal: ${signal}`);
      return;
    }

    if (!this._signalHistory.has(tabId)) {
      this._signalHistory.set(tabId, new Map());
      this._stabilityWindow.set(tabId, { prevScore: 0, prevLevel: 'LOW', timestamp: Date.now() });
    }

    const history = this._signalHistory.get(tabId);
    const signalLog = history.get(signal) || [];
    signalLog.push(detected);
    if (signalLog.length > 3) signalLog.shift();
    history.set(signal, signalLog);

    this._computeRisk(tabId);
  }

  getPageRisk(tabId) {
    if (!this._tabRisks.has(tabId)) {
      return { level: 'LOW', score: 0, reasons: [], confidence: 1.0 };
    }
    return this._tabRisks.get(tabId);
  }

  resetTab(tabId) {
    this._tabRisks.delete(tabId);
    this._signalHistory.delete(tabId);
    this._stabilityWindow.delete(tabId);
  }

  getDiagnostics(tabId) {
    const signals = this._signalHistory.get(tabId) || new Map();
    const stability = this._stabilityWindow.get(tabId) || {};

    const diagnostic = {};
    for (const [sig, log] of signals) {
      diagnostic[sig] = {
        events: log,
        detected_count: log.filter(b => b).length,
        detection_rate: log.filter(b => b).length / Math.max(log.length, 1),
      };
    }

    return {
      ...diagnostic,
      stability_info: {
        previous_score: stability.prevScore,
        previous_level: stability.prevLevel,
        stability_window_ms: Date.now() - (stability.timestamp || 0),
      },
    };
  }

  _computeRisk(tabId) {
    const signals = this._signalHistory.get(tabId) || new Map();
    const stability = this._stabilityWindow.get(tabId) || {};

    const signalConfidence = this._aggregateSignals(signals);

    let rawScore = 0;
    const reasons = [];

    if (signalConfidence.late_injection >= 0.5) {
      rawScore += 35;
      reasons.push('Late script injection detected');
    }

    if (signalConfidence.obfuscation >= 0.4) {
      rawScore += 25;
      reasons.push('Obfuscated tracking patterns');
    }

    if (signalConfidence.first_party_tracking >= 0.5) {
      rawScore += 20;
      reasons.push('First-party tracking signals');
    }

    if (signalConfidence.multi_domain >= 0.6) {
      rawScore += 15;
      reasons.push('Multi-domain coordination detected');
    }

    const smoothedScore = this._smoothScore(
      rawScore,
      stability.prevScore,
      Date.now() - (stability.timestamp || 0)
    );

    let level = 'LOW';
    let confidence = 0.8;

    if (smoothedScore >= 60) {
      level = 'HIGH';
      confidence = Math.min(0.95, 0.7 + signalConfidence.late_injection * 0.25);
    } else if (smoothedScore >= 30) {
      level = 'MEDIUM';
      confidence = Math.min(0.85, 0.65 + (signalConfidence.obfuscation + signalConfidence.first_party_tracking) * 0.2);
    } else {
      level = 'LOW';
      confidence = 1.0 - Math.max(...Object.values(signalConfidence)) * 0.1;
    }

    const result = {
      level,
      score: Math.round(smoothedScore),
      reasons,
      confidence: Math.round(confidence * 100) / 100,
      timestamp: Date.now(),
    };

    this._tabRisks.set(tabId, result);
    this._stabilityWindow.set(tabId, {
      prevScore: smoothedScore,
      prevLevel: level,
      timestamp: Date.now(),
    });

    console.debug(`[RiskEngine] Tab ${tabId}: ${level} (${Math.round(smoothedScore)}) — ${reasons.join(', ')}`);
  }

  _aggregateSignals(signalMap) {
    const confidence = {
      late_injection: 0,
      obfuscation: 0,
      first_party_tracking: 0,
      multi_domain: 0,
    };

    for (const [signal, history] of signalMap) {
      if (history.length === 0) continue;

      const detectionRate = history.filter(b => b).length / history.length;
      const recencyBoost = history[history.length - 1] ? 1.2 : 0.8;

      confidence[signal] = Math.min(1.0, detectionRate * recencyBoost);
    }

    return confidence;
  }

  _smoothScore(rawScore, prevScore, timeSinceLastMs) {
    if (timeSinceLastMs < 10_000) {
      return prevScore * 0.8 + rawScore * 0.2;
    } else if (timeSinceLastMs < 30_000) {
      return prevScore * 0.5 + rawScore * 0.5;
    } else {
      return rawScore;
    }
  }
}

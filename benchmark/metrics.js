const TRACKER_PATTERNS = [
  'google-analytics', 'googletagmanager', 'gtag', 'doubleclick',
  'facebook.net', 'fbcdn', 'pixel', 'analytics', 'beacon',
  'amplitude', 'mixpanel', 'segment', 'heap', 'fullstory',
  'hotjar', 'chartbeat', 'newrelic', 'datadog', 'logrocket',
  'scorecardresearch', 'quantserve', 'moatads'
];

function isTracker(url) {
  const urlLower = url.toLowerCase();
  return TRACKER_PATTERNS.some(pattern => urlLower.includes(pattern));
}

function calculateBlockRate(baseline, withExtension) {
  if (withExtension.totalRequests === 0) return 0;
  return withExtension.blockedRequests / withExtension.totalRequests;
}

function calculateTrackerBlockRate(baseline, withExtension) {
  if (withExtension.totalTrackers === 0) return 0;
  return withExtension.blockedTrackers / withExtension.totalTrackers;
}

function calculateBreakageScore(baseline, withExtension) {
  const jsErrorDelta = Math.max(0, withExtension.jsErrors - baseline.jsErrors) / Math.max(1, baseline.jsErrors + 1);
  const domDelta = Math.abs(withExtension.domNodes - baseline.domNodes) / Math.max(1, baseline.domNodes);
  const loadFailureRate = withExtension.totalRequests > 0
    ? withExtension.failedRequests / withExtension.totalRequests
    : 0;
  const clampedJsError = Math.min(1, jsErrorDelta);
  const clampedDom = Math.min(1, domDelta);
  const clampedLoad = Math.min(1, loadFailureRate);
  const breakageScore = 0.4 * clampedJsError + 0.4 * clampedDom + 0.2 * clampedLoad;
  return breakageScore;
}

function calculateMLContribution(mlOnlyBlocks, totalBlocks) {
  if (totalBlocks === 0) return 0;
  return mlOnlyBlocks / totalBlocks;
}

function checkThresholds(metrics, baseline = null) {
  const failures = [];
  if (metrics.tracker_block_rate < 0.10) {
    failures.push(`tracker_block_rate ${(metrics.tracker_block_rate * 100).toFixed(1)}% < 10% (required)`);
  }
  if (metrics.breakage_score > 0.05) {
    failures.push(`breakage_score ${metrics.breakage_score.toFixed(3)} > 0.05 (limit)`);
  }
  if (metrics.ml_contribution < 0.05) {
    failures.push(`ml_contribution ${(metrics.ml_contribution * 100).toFixed(1)}% < 5% (required on native_ads)`);
  }
  if (baseline) {
    if (metrics.breakage_score > baseline.breakage_score + 0.02) {
      failures.push(`breakage regression: ${metrics.breakage_score.toFixed(3)} vs ${baseline.breakage_score.toFixed(3)} (+${(metrics.breakage_score - baseline.breakage_score).toFixed(3)})`);
    }
    if (metrics.tracker_block_rate < baseline.tracker_block_rate) {
      failures.push(`tracker_block_rate regression: ${(metrics.tracker_block_rate * 100).toFixed(1)}% vs ${(baseline.tracker_block_rate * 100).toFixed(1)}%`);
    }
    if (metrics.block_rate < baseline.block_rate * 0.95) {
      failures.push(`block_rate drop > 5%: ${(metrics.block_rate * 100).toFixed(1)}% vs ${(baseline.block_rate * 100).toFixed(1)}%`);
    }
  }
  return {
    pass: failures.length === 0,
    failures
  };
}

module.exports = {
  isTracker,
  calculateBlockRate,
  calculateTrackerBlockRate,
  calculateBreakageScore,
  calculateMLContribution,
  checkThresholds
};
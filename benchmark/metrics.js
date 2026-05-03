// COMMAND 5: Enhanced benchmark metrics with first-party detection

const TRACKER_PATTERNS = [
  'google-analytics', 'googletagmanager', 'gtag', 'doubleclick',
  'facebook.net', 'fbcdn', 'pixel', 'analytics', 'beacon',
  'amplitude', 'mixpanel', 'segment', 'heap', 'fullstory',
  'hotjar', 'chartbeat', 'newrelic', 'datadog', 'logrocket',
  'scorecardresearch', 'quantserve', 'moatads'
];

// COMMAND 5: First-party tracker patterns
const FIRST_PARTY_PATTERNS = [
  '/collect', '/analytics', '/track', '/events', '/metrics',
  '/beacon', '/log', '/telemetry'
];

function isTracker(url) {
  const urlLower = url.toLowerCase();
  return TRACKER_PATTERNS.some(pattern => urlLower.includes(pattern));
}

// COMMAND 5: First-party tracker detection
function isFirstPartyTracker(url, pageUrl) {
  try {
    const urlDomain = new URL(url).hostname;
    const pageDomain = new URL(pageUrl).hostname;
    const sameDomain = urlDomain === pageDomain;
    const hasPattern = FIRST_PARTY_PATTERNS.some(p => url.toLowerCase().includes(p));
    return sameDomain && hasPattern;
  } catch {
    return false;
  }
}

function calculateBlockRate(baseline, withExtension) {
  if (withExtension.totalRequests === 0) return 0;
  return withExtension.blockedRequests / withExtension.totalRequests;
}

function calculateTrackerBlockRate(baseline, withExtension) {
  if (withExtension.totalTrackers === 0) return 0;
  return withExtension.blockedTrackers / withExtension.totalTrackers;
}

// COMMAND 5: First-party tracker block rate
function calculateFirstPartyBlockRate(baseline, withExtension) {
  if (!withExtension.firstPartyTrackers || withExtension.firstPartyTrackers === 0) return 0;
  return (withExtension.blockedFirstParty || 0) / withExtension.firstPartyTrackers;
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
  
  // COMMAND 5: Stricter thresholds
  if (metrics.tracker_block_rate < 0.15) {
    failures.push(`tracker_block_rate ${(metrics.tracker_block_rate * 100).toFixed(1)}% < 15% (required)`);
  }
  if (metrics.breakage_score > 0.05) {
    failures.push(`breakage_score ${metrics.breakage_score.toFixed(3)} > 0.05 (limit)`);
  }
  if (metrics.ml_contribution < 0.05) {
    failures.push(`ml_contribution ${(metrics.ml_contribution * 100).toFixed(1)}% < 5% (required)`);
  }
  
  // COMMAND 5: First-party detection requirement
  if (metrics.first_party_block_rate !== undefined && metrics.first_party_block_rate < 0.10) {
    failures.push(`first_party_block_rate ${(metrics.first_party_block_rate * 100).toFixed(1)}% < 10% (required)`);
  }
  
  if (baseline) {
    if (metrics.breakage_score > baseline.breakage_score + 0.02) {
      failures.push(`breakage regression: ${metrics.breakage_score.toFixed(3)} vs ${baseline.breakage_score.toFixed(3)}`);
    }
    if (metrics.tracker_block_rate < baseline.tracker_block_rate * 0.95) {
      failures.push(`tracker_block_rate regression > 5%`);
    }
  }
  
  return {
    pass: failures.length === 0,
    failures
  };
}

module.exports = {
  isTracker,
  isFirstPartyTracker,
  calculateBlockRate,
  calculateTrackerBlockRate,
  calculateFirstPartyBlockRate,
  calculateBreakageScore,
  calculateMLContribution,
  checkThresholds
};

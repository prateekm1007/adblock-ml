/**
 * Data capture content script
 * ============================
 * Injected manually during data collection sessions only.
 * NOT included in production manifest — add temporarily when gathering
 * labeled training data for the ML model.
 *
 * Usage:
 *   1. Add "src/content/capture.js" to manifest content_scripts temporarily
 *   2. Browse normally for 20-30 minutes across ad-heavy and clean sites
 *   3. Open DevTools console → run: copy(window.__adblockCapture.export())
 *   4. Paste into data/captured_requests.json
 *   5. Manually label entries (label: 1 = ad, label: 0 = clean)
 *   6. Feed to scripts/train_model.py
 *
 * This script patches fetch/XHR to record every request with context.
 */

(function () {
  'use strict';
  if (window.__adblockCapture) return;

  const captured = [];
  const pageLoadTime = performance.now();
  const pageUrl = window.location.href;

  // Track request timing for z-score feature
  const requestTimestamps = [];

  function baseDomain(url) {
    try {
      return new URL(url).hostname.split('.').slice(-2).join('.');
    } catch { return ''; }
  }

  function isThirdParty(url) {
    return baseDomain(url) !== baseDomain(pageUrl);
  }

  function captureRequest(url, type, initiator) {
    const timestamp = performance.now();
    requestTimestamps.push(timestamp);

    // Compute timing z-score inline (approximate)
    let timingZScore = 0;
    if (requestTimestamps.length > 2) {
      const mean = requestTimestamps.reduce((a, b) => a + b, 0) / requestTimestamps.length;
      const variance = requestTimestamps.reduce((a, b) => a + (b - mean) ** 2, 0) / requestTimestamps.length;
      const std = Math.sqrt(variance);
      timingZScore = std > 0 ? Math.abs((timestamp - mean) / std) : 0;
    }

    captured.push({
      url,
      type,
      initiator: initiator || document.currentScript?.src || pageUrl,
      is_third_party: isThirdParty(url),
      timestamp,
      late_injection: timestamp > 2000, // >2s after page start
      timing_zscore: parseFloat(timingZScore.toFixed(3)),
      page_url: pageUrl,
      label: -1, // -1 = unlabeled, set to 0 or 1 when reviewing
    });
  }

  // ─── Patch fetch ──────────────────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = function (resource, init) {
    const url = typeof resource === 'string' ? resource : resource?.url || '';
    if (url && !url.startsWith('chrome-extension://')) {
      captureRequest(url, 'fetch', document.currentScript?.src);
    }
    return origFetch.apply(this, arguments);
  };

  // ─── Patch XHR ────────────────────────────────────────────────────────────
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (url && !String(url).startsWith('chrome-extension://')) {
      captureRequest(String(url), 'xmlhttprequest', document.currentScript?.src);
    }
    return origOpen.apply(this, arguments);
  };

  // ─── Observe script/image insertions ─────────────────────────────────────
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        if (node.tagName === 'SCRIPT' && node.src) {
          captureRequest(node.src, 'script', node.getAttribute('data-initiator') || pageUrl);
        } else if (node.tagName === 'IMG' && node.src) {
          captureRequest(node.src, 'image', pageUrl);
        } else if (node.tagName === 'IFRAME' && node.src && node.src !== 'about:blank') {
          captureRequest(node.src, 'sub_frame', pageUrl);
        }
      }
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  // ─── Export API ───────────────────────────────────────────────────────────
  window.__adblockCapture = {
    /** Returns JSON string of all captured requests */
    export() {
      return JSON.stringify(captured, null, 2);
    },

    /** Returns only unlabeled requests for manual review */
    unlabeled() {
      return captured.filter(r => r.label === -1);
    },

    /** Quick-label by URL pattern */
    labelContaining(substring, label) {
      let count = 0;
      captured.forEach(r => {
        if (r.url.toLowerCase().includes(substring.toLowerCase())) {
          r.label = label;
          count++;
        }
      });
      console.log(`Labeled ${count} requests containing "${substring}" as ${label}`);
    },

    /** Show summary */
    summary() {
      const ads   = captured.filter(r => r.label === 1).length;
      const clean = captured.filter(r => r.label === 0).length;
      const unlbl = captured.filter(r => r.label === -1).length;
      console.table({ total: captured.length, ads, clean, unlabeled: unlbl });
    },

    get count() { return captured.length; },
  };

  console.log('[AdBlockML Capture] Active. Use window.__adblockCapture.summary() to check progress.');
  console.log('[AdBlockML Capture] Use window.__adblockCapture.export() when done.');
})();

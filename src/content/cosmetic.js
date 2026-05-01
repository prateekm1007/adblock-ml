/**
 * Cosmetic content script
 *
 * Handles element hiding that network rules can't do:
 *   - CSS cosmetic filters (##div.ad-banner)
 *   - First-party ad elements that load from same domain
 *   - "Sponsored" label detection
 *
 * Injected at document_start so rules apply before paint.
 *
 * Note: Kept intentionally minimal for Phase 1.
 * Phase 3 (perceptual layer) will extend this with ML-based detection.
 */

(function () {
  'use strict';

  // Prevent double-injection
  if (window.__adblockMlInstalled) return;
  window.__adblockMlInstalled = true;

  // ─── Phase 1: Static cosmetic rules ───────────────────────────────────────
  // These mirror common uBO cosmetic filters.
  // A real build generates this list from EasyList cosmetic filter compilation.

  const COSMETIC_SELECTORS = [
    // Generic ad container classes
    '.ad-banner', '.ad-container', '.ad-wrapper', '.ad-slot',
    '.adsbygoogle', '.ads-banner', '.ads-container',
    '#ad-banner', '#ad-container', '#advertisement',
    '[id^="google_ads_"]', '[id^="div-gpt-ad"]',
    '[data-ad-unit]', '[data-ad-slot]',
    '[aria-label="Advertisement"]',

    // Common sponsored content wrappers
    '.sponsored-content:not(article)',
    '[data-testid="ad"]',
    'ins.adsbygoogle',

    // Overlay / sticky ad patterns
    '.sticky-ad', '.floating-ad', '.overlay-ad',
    '#sticky-ad', '#floating-ad',

    // Native ad patterns (conservative — high false positive risk)
    // Only apply these with a parent domain check in production
    // '.taboola-widget', '.outbrain-widget',
  ];

  // ─── CSS injection (fastest path) ─────────────────────────────────────────

  function injectCosmeticCSS(selectors) {
    const css = selectors.map(s => `${s}{display:none!important}`).join('\n');
    const style = document.createElement('style');
    style.id = '__adblock_ml_cosmetic';
    style.textContent = css;
    // Inject into <head> or <html>
    (document.head || document.documentElement).appendChild(style);
  }

  // ─── Mutation observer for dynamically-injected ads ───────────────────────

  function setupMutationObserver() {
    const selectorSet = new Set(COSMETIC_SELECTORS);
    const allSelectors = COSMETIC_SELECTORS.join(',');

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          hideIfAd(node, allSelectors);
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function hideIfAd(element, allSelectors) {
    try {
      if (element.matches(allSelectors)) {
        element.style.setProperty('display', 'none', 'important');
        return;
      }
      // Check descendants
      element.querySelectorAll(allSelectors).forEach(el => {
        el.style.setProperty('display', 'none', 'important');
      });
    } catch { /* invalid selector edge cases */ }
  }

  // ─── Communication with background ────────────────────────────────────────

  // Request site-specific cosmetic rules from background
  function requestSiteRules() {
    chrome.runtime.sendMessage(
      { type: 'GET_COSMETIC_RULES', hostname: window.location.hostname },
      (rules) => {
        if (!rules || !rules.length) return;
        injectCosmeticCSS(rules);
      }
    );
  }

  // ─── Boot ──────────────────────────────────────────────────────────────────

  injectCosmeticCSS(COSMETIC_SELECTORS);
  setupMutationObserver();

  // Request site-specific rules after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', requestSiteRules, { once: true });
  } else {
    requestSiteRules();
  }

})();

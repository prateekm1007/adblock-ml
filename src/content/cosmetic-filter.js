(function() {
  if (window.__adblockCosmeticLoaded) return;
  window.__adblockCosmeticLoaded = true;

  const GENERIC_SELECTORS = [
    '[class^="ad-"]',
    '[class*=" ad-"]',
    '[class*="-ad-"]',
    '[id^="ad-"]',
    '[id*="-ad-"]',
    '[class^="ads-"]',
    '[class*=" ads-"]',
    '[class*="ad-banner"]',
    '[class*="ad-space"]',
    '[class*="ad-container"]',
    '[class*="ad-wrapper"]',
    '[class*="advertisement"]',
    '[id*="google_ads"]',
    '[id*="div-gpt-ad"]',
    '[data-ad]',
    '[data-advertisement]',
    '[data-google-query-id]',
    '[aria-label*="Advertisement"]',
    '[aria-label*="Sponsored"]',
  ];

  function hideElements() {
    try {
      const elements = document.querySelectorAll(GENERIC_SELECTORS.join(','));
      elements.forEach(el => {
        if (!el.hasAttribute('data-adblocker-hidden')) {
          el.style.cssText = 'display:none!important;visibility:hidden!important;height:0!important;';
          el.setAttribute('data-adblocker-hidden', '1');
        }
      });
    } catch(e) {}
  }

  hideElements();

  const observer = new MutationObserver(() => hideElements());
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
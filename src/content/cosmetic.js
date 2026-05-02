/**
 * AdBlockML — Cosmetic Filter (ML-Integrated)
 * 
 * Two-layer approach:
 *   Layer 1: Safe generic selectors (always active)
 *   Layer 2: ML-driven domain-specific injection (triggered by SW messages)
 */

// ━━━ State ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const injectedDomains = new Set();
let hiddenCount = 0;
let observerActive = false;

// ━━━ Layer 1: Safe Generic Selectors ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const GENERIC_SELECTORS = [
  // Anchored patterns only (safe from false positives)
  '[class^="ad-"]',
  '[class*=" ad-"]',
  '[class*="-ad-"]',
  '[id^="ad-"]',
  '[id*="-ad-"]',
  '[class^="ads-"]',
  '[class*=" ads-"]',
  
  // Specific ad containers
  '[class*="ad-banner"]',
  '[class*="ad-space"]',
  '[class*="ad-container"]',
  '[class*="ad-wrapper"]',
  '[class*="advertisement"]',
  '[id*="google_ads"]',
  '[id*="div-gpt-ad"]',
  
  // Sponsored/promoted content
  '[data-ad]',
  '[data-advertisement]',
  '[data-google-query-id]',
  '.sponsored',
  '.promoted',
  '[aria-label*="Advertisement"]',
  '[aria-label*="Sponsored"]',
];

// Containers safe to collapse (whitelist)
const SAFE_COLLAPSE_CONTAINERS = new Set([
  'aside', 'div', 'section', 'header', 'footer', 'nav'
]);

// Never collapse these (critical layout elements)
const PROTECTED_ELEMENTS = new Set([
  'body', 'main', 'article', 'html'
]);

// ━━━ Layer 2: ML-Driven Domain Blocking ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function injectDomainCSS(domain, confidence) {
  if (injectedDomains.has(domain)) return;

  const style = document.createElement('style');
  style.setAttribute('data-adblocker-ml', domain);
  
  // Only target visual elements (not scripts — DNR handles that)
  style.textContent = `
    iframe[src*="${domain}"],
    img[src*="${domain}"],
    video[src*="${domain}"],
    embed[src*="${domain}"],
    object[data*="${domain}"],
    link[href*="${domain}"][rel="stylesheet"] {
      display: none !important;
      visibility: hidden !important;
      height: 0 !important;
      width: 0 !important;
      min-height: 0 !important;
      min-width: 0 !important;
      opacity: 0 !important;
    }
  `;
  
  document.documentElement.appendChild(style);
  injectedDomains.add(domain);
  
  console.log(`[Cosmetic] Injected CSS for domain: ${domain} (confidence: ${confidence.toFixed(2)})`);
}

// ━━━ Container Collapse (guarded) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function tryCollapseContainer(element) {
  if (!element || !element.parentElement) return;
  if (PROTECTED_ELEMENTS.has(element.parentElement.tagName.toLowerCase())) return;
  
  let depth = 0;
  let current = element.parentElement;
  
  while (current && depth < 2) {
    const tagName = current.tagName.toLowerCase();
    
    // Only collapse safe containers
    if (!SAFE_COLLAPSE_CONTAINERS.has(tagName)) break;
    
    // Check if container is effectively empty
    const hasVisibleContent = Array.from(current.childNodes).some(node => {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent.trim().length > 0;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node;
        return el.offsetHeight > 0 && !el.hasAttribute('data-adblocker-hidden');
      }
      return false;
    });
    
    if (!hasVisibleContent && current.offsetHeight < 20) {
      current.style.cssText = 'display: none !important; height: 0 !important;';
      console.log(`[Cosmetic] Collapsed container: ${tagName}.${current.className}`);
      break;
    }
    
    current = current.parentElement;
    depth++;
  }
}

// ━━━ Generic Selector Application ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function applyGenericFilters() {
  const elements = document.querySelectorAll(GENERIC_SELECTORS.join(','));
  let count = 0;
  
  elements.forEach(el => {
    if (el.hasAttribute('data-adblocker-hidden')) return;
    
    el.style.cssText = 'display: none !important; visibility: hidden !important; height: 0 !important;';
    el.setAttribute('data-adblocker-hidden', 'generic');
    count++;
    
    // Try to collapse parent container if it becomes empty
    setTimeout(() => tryCollapseContainer(el), 50);
  });
  
  if (count > 0) {
    hiddenCount += count;
    console.log(`[Cosmetic] Hidden ${count} elements via generic selectors (total: ${hiddenCount})`);
  }
}

// ━━━ MutationObserver (throttled) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let mutationBatch = [];
let mutationTimer = null;

function processMutationBatch() {
  if (mutationBatch.length === 0) return;
  
  const addedNodes = new Set();
  mutationBatch.forEach(mutation => {
    mutation.addedNodes.forEach(node => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        addedNodes.add(node);
      }
    });
  });
  
  mutationBatch = [];
  
  // Limit processing to 200 nodes per batch
  let processed = 0;
  const maxNodes = 200;
  
  addedNodes.forEach(node => {
    if (processed >= maxNodes) return;
    
    // Check if node or its children match generic selectors
    if (node.matches && GENERIC_SELECTORS.some(sel => {
      try { return node.matches(sel); } catch { return false; }
    })) {
      node.style.cssText = 'display: none !important; visibility: hidden !important; height: 0 !important;';
      node.setAttribute('data-adblocker-hidden', 'generic');
      hiddenCount++;
      processed++;
      setTimeout(() => tryCollapseContainer(node), 50);
    }
    
    // Check children
    try {
      const children = node.querySelectorAll(GENERIC_SELECTORS.join(','));
      children.forEach(child => {
        if (processed >= maxNodes) return;
        if (!child.hasAttribute('data-adblocker-hidden')) {
          child.style.cssText = 'display: none !important; visibility: hidden !important; height: 0 !important;';
          child.setAttribute('data-adblocker-hidden', 'generic');
          hiddenCount++;
          processed++;
          setTimeout(() => tryCollapseContainer(child), 50);
        }
      });
    } catch (err) {
      // Ignore querySelectorAll errors on non-element nodes
    }
  });
  
  if (processed > 0) {
    console.log(`[Cosmetic] Processed ${processed} mutations (total hidden: ${hiddenCount})`);
  }
}

const observer = new MutationObserver(mutations => {
  mutationBatch.push(...mutations);
  
  if (mutationTimer) clearTimeout(mutationTimer);
  mutationTimer = setTimeout(processMutationBatch, 100);
});

// ━━━ Message Listener (ML → Cosmetic) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'INJECT_DOMAIN_CSS') {
    const { domains } = message;
    
    if (Array.isArray(domains)) {
      domains.forEach(entry => {
        injectDomainCSS(entry.domain, entry.confidence);
      });
    }
    
    sendResponse({ ok: true, injected: domains.length });
  }
  
  return false;
});

// ━━━ Initialization ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function initialize() {
  // Apply generic filters immediately
  applyGenericFilters();
  
  // Start mutation observer
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
  observerActive = true;
  
  // Disconnect observer after 10s if no new mutations
  let lastMutationTime = Date.now();
  const mutationCheck = setInterval(() => {
    if (Date.now() - lastMutationTime > 10000 && observerActive) {
      observer.disconnect();
      observerActive = false;
      console.log('[Cosmetic] Observer disconnected (no activity for 10s)');
      clearInterval(mutationCheck);
    }
  }, 5000);
  
  // Update last mutation time on any mutation
  const originalCallback = observer.takeRecords;
  observer.takeRecords = function() {
    lastMutationTime = Date.now();
    return originalCallback.apply(this, arguments);
  };
  
  console.log('[Cosmetic] Initialized (generic filters + ML layer active)');
}

// Run on DOMContentLoaded or immediately if already loaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}
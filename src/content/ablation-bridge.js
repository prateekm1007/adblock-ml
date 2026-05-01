/**
 * Ablation bridge content script
 *
 * The Playwright benchmark runner injects ablation flags into localStorage
 * before page load via context.addInitScript(). This content script reads
 * those flags and forwards them to the service worker so the extension
 * can behave differently in each ablation condition.
 *
 * This script runs only when the extension is loaded during benchmarking.
 * In normal use the localStorage key is absent and nothing happens.
 *
 * Included in manifest under content_scripts but runs at document_start
 * so it fires before any page JS.
 */

(function () {
  'use strict';

  let flags;
  try {
    const raw = localStorage.getItem('__adblock_ml_flags');
    if (!raw) return; // normal user session — nothing to do
    flags = JSON.parse(raw);
  } catch { return; }

  if (!flags || typeof flags !== 'object') return;

  // Forward flags to service worker
  chrome.runtime.sendMessage({ type: 'SET_RUNTIME_FLAGS', flags }, (res) => {
    if (chrome.runtime.lastError) return; // SW not ready yet — flags will be default
    console.debug('[AdBlockML] Ablation flags applied:', flags);
  });
})();

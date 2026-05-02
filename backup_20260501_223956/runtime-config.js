/**
 * RuntimeConfig
 *
 * Manages feature flags for benchmark ablation testing.
 * In production all flags are ON. The benchmark runner injects flags
 * via localStorage before page load; a content script reads them and
 * sends them to the service worker via a one-time message.
 *
 * Supported flags:
 *   ml_enabled           (default: true)  — run ML classifier
 *   feature_store_enabled (default: true) — use domain history for safe-domain gate
 *
 * The service worker calls RuntimeConfig.get() synchronously on every
 * request. No async needed after initialization.
 */

const STORAGE_KEY    = 'adblock_ml_runtime_flags';
const DEFAULTS = {
  ml_enabled:            true,
  feature_store_enabled: true,
};

export class RuntimeConfig {
  constructor() {
    this._flags = { ...DEFAULTS };
  }

  async load() {
    try {
      const stored = await chrome.storage.session.get(STORAGE_KEY);
      if (stored[STORAGE_KEY]) {
        Object.assign(this._flags, stored[STORAGE_KEY]);
        console.log('[RuntimeConfig] Flags loaded:', this._flags);
      }
    } catch { /* first run */ }
  }

  /** Called by the SET_RUNTIME_FLAGS message handler */
  async set(flags) {
    Object.assign(this._flags, flags);
    await chrome.storage.session.set({ [STORAGE_KEY]: this._flags });
    console.log('[RuntimeConfig] Flags updated:', this._flags);
  }

  /** Reset to production defaults */
  async reset() {
    this._flags = { ...DEFAULTS };
    await chrome.storage.session.remove(STORAGE_KEY);
  }

  get mlEnabled()           { return this._flags.ml_enabled           ?? true; }
  get featureStoreEnabled() { return this._flags.feature_store_enabled ?? true; }

  get() { return { ...this._flags }; }
}

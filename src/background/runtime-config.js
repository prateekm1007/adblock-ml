/**
 * RuntimeConfig
 */

const STORAGE_KEY = 'adblock_ml_runtime_config';

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

  async set(flags) {
    Object.assign(this._flags, flags);
    await chrome.storage.session.set({ [STORAGE_KEY]: this._flags });
    console.log('[RuntimeConfig] Flags updated:', this._flags);
  }

  async reset() {
    this._flags = { ...DEFAULTS };
    await chrome.storage.session.remove(STORAGE_KEY);
  }

  get mlEnabled()           { return this._flags.ml_enabled           ?? true; }
  get featureStoreEnabled() { return this._flags.feature_store_enabled ?? true; }

  get() { return { ...this._flags }; }
}

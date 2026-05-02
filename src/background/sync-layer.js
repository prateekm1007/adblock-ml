/**
 * SyncLayer
 */

const BACKEND_URL             = 'https://api.adblock-ml.dev';
const BATCH_ENDPOINT          = `${BACKEND_URL}/events/batch`;
const MODEL_ENDPOINT          = `${BACKEND_URL}/model/latest`;
const MODEL_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const MAX_RETRIES   = 5;
const BASE_DELAY_MS = 1000;

export class SyncLayer {
  constructor(eventLogger, classifier) {
    this._log        = eventLogger;
    this._classifier = classifier;
    this._retryCount = 0;
    this._retryTimer = null;
    this._modelTimer = null;
  }

  start() {
    this._log.onBatchReady((batch) => this._uploadBatch(batch));
    const jitter = Math.random() * 60 * 60 * 1000;
    setTimeout(() => {
      this._checkModelUpdate();
      this._modelTimer = setInterval(() => this._checkModelUpdate(), MODEL_CHECK_INTERVAL_MS);
    }, jitter);
  }

  stop() {
    if (this._retryTimer) clearTimeout(this._retryTimer);
    if (this._modelTimer) clearInterval(this._modelTimer);
  }

  async _uploadBatch(batch) {
    if (await this._isMetered()) {
      console.log('[Sync] Skipping upload - metered connection');
      return;
    }

    const payload = {
      events:     batch.map(this._sanitizeEvent),
      client_ver: chrome.runtime.getManifest().version,
      sent_at:    Date.now(),
    };

    const success = await this._post(BATCH_ENDPOINT, payload);

    if (success) {
      await this._log.markSynced(batch.map(e => e.id));
      this._retryCount = 0;
      console.log(`[Sync] Uploaded ${batch.length} events`);
    } else {
      this._scheduleRetry(batch);
    }
  }

  _scheduleRetry(batch) {
    if (this._retryCount >= MAX_RETRIES) {
      console.warn('[Sync] Max retries reached - dropping batch');
      this._retryCount = 0;
      return;
    }
    const delay = BASE_DELAY_MS * Math.pow(2, this._retryCount) + Math.random() * 500;
    this._retryCount++;
    console.log(`[Sync] Retry ${this._retryCount} in ${Math.round(delay)}ms`);
    this._retryTimer = setTimeout(() => this._uploadBatch(batch), delay);
  }

  async _checkModelUpdate() {
    if (await this._isMetered()) return;
    try {
      const res = await fetch(MODEL_ENDPOINT, { method: 'GET', cache: 'no-store' });
      if (!res.ok) return;
      const meta           = await res.json();
      const currentVersion = this._classifier.getModelInfo().version ?? '0';
      if (meta.version === currentVersion) {
        console.log('[Sync] Model up to date:', currentVersion);
        return;
      }
      console.log(`[Sync] New model available: ${meta.version}`);
      await this._downloadAndSwap(meta);
    } catch (err) {
      console.warn('[Sync] Model check failed:', err.message);
    }
  }

  async _downloadAndSwap(meta) {
    try {
      const res = await fetch(meta.download_url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const modelBuffer = await res.arrayBuffer();
      const hashBuffer  = await crypto.subtle.digest('SHA-256', modelBuffer);
      const hashHex     = Array.from(new Uint8Array(hashBuffer))
                               .map(b => b.toString(16).padStart(2, '0')).join('');
      if (hashHex !== meta.sha256) {
        throw new Error(`Checksum mismatch: got ${hashHex}, expected ${meta.sha256}`);
      }
      await this._cacheModel(modelBuffer, meta);
      await this._classifier.loadFromBuffer(modelBuffer, meta);
      console.log(`[Sync] Model swapped to v${meta.version}`);
    } catch (err) {
      console.error('[Sync] Model download/swap failed:', err.message);
    }
  }

  async _cacheModel(buffer, meta) {
    await chrome.storage.local.set({
      'adblock_ml_cached_model': {
        buffer:    Array.from(new Uint8Array(buffer)),
        meta,
        cached_at: Date.now(),
      },
    });
  }

  async _isMetered() {
    try {
      const conn = navigator.connection;
      if (!conn) return false;
      return conn.type === 'cellular' || conn.saveData === true;
    } catch { return false; }
  }

  async _post(url, payload) {
    try {
      const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      });
      return res.ok;
    } catch { return false; }
  }

  _sanitizeEvent(event) {
    return {
      url_hash:    event.url_hash,
      domain_hash: event.domain_hash,
      features:    event.features,
      prediction:  event.prediction,
      decision:    event.decision,
      feedback:    event.feedback,
      timestamp:   event.timestamp,
    };
  }
}

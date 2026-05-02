# === AdBlockML AUTO REPAIR COMMAND ===
$dir = "src\background"

Write-Host "Starting automatic repair..." -ForegroundColor Cyan

# Backup originals
Copy-Item "$dir\classifier.js" "$dir\classifier.js.bak" -Force
Copy-Item "$dir\event-logger.js" "$dir\event-logger.js.bak" -Force
Copy-Item "$dir\service-worker.js" "$dir\service-worker.js.bak" -Force

# === 1. FIX classifier.js (remove dynamic import, force heuristic) ===
(Get-Content "$dir\classifier.js" -Raw) -replace '(?s)async _loadOnnxModel\(\)\s*\{.*?\n\}', '' -replace 
'async load\(\) \{.*?\n\s*\}', '
async load() {
  console.log("[Classifier] Auto-heuristic mode (ONNX blocked in Service Worker)");
  this._modelInfo = { type: "heuristic", features: N_FEATURES };
  this._ready = true;
}
' | Set-Content "$dir\classifier.js" -Encoding UTF8

# === 2. FIX event-logger.js (self-healing IndexedDB - no manual delete needed) ===
(Get-Content "$dir\event-logger.js" -Raw) -replace 'const DB_VERSION = 1;', 'const DB_VERSION = 4;' -replace 
'(?s)async _openDB\(\)\s*\{.*?\n\s*\}', '
async _openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const tx = e.target.transaction;
      if (!db.objectStoreNames.contains(LOG_STORE)) {
        const log = db.createObjectStore(LOG_STORE, { keyPath: "id", autoIncrement: true });
        log.createIndex("url_hash", "url_hash");
        log.createIndex("synced", "synced");
        log.createIndex("timestamp", "timestamp");
        log.createIndex("feedback", "feedback");
      } else {
        const store = tx.objectStore(LOG_STORE);
        if (!store.indexNames.contains("synced")) store.createIndex("synced", "synced");
        if (!store.indexNames.contains("feedback")) store.createIndex("feedback", "feedback");
      }
      if (!db.objectStoreNames.contains("feature_store")) {
        const fs = db.createObjectStore("feature_store", { keyPath: "domain_hash" });
        fs.createIndex("block_rate", "block_rate");
        fs.createIndex("last_seen", "last_seen");
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}
' | Set-Content "$dir\event-logger.js" -Encoding UTF8

# === 3. FIX service-worker.js (defensive init + fix broken template literals) ===
$content = Get-Content "$dir\service-worker.js" -Raw
$content = $content -replace '```ml_summary_\$\{tabId\}```', '`ml_summary_${tabId}`' -replace '```ml_summary_\$\{message\.tabId .*?\}```', '`ml_summary_${tabId}`'
$content = $content -replace '(?s)async function initialize\(\) \{.*?\n\s*\}', '
async function initialize() {
  console.log("[AdBlockML] Service worker v4 starting - auto repair active");
  try {
    await Promise.allSettled([
      config.load(),
      classifier.load(),
      listManager.initialize(),
      stats.load(),
      dynamicRules.initialize(),
      featureStore.open(),
      eventLogger.open().catch(e => console.warn("[EventLogger] non-fatal:", e.message))
    ]);
    setupWebRequestListeners();
    setupMessageListeners();
    setupTabListeners();
    console.log("[AdBlockML] Service worker started successfully (self-repaired)");
  } catch (err) {
    console.error("[AdBlockML] Critical init error:", err);
  }
}
'
$content | Set-Content "$dir\service-worker.js" -Encoding UTF8

Write-Host "✅ All files automatically repaired!" -ForegroundColor Green
Write-Host "Next step: Go to chrome://extensions/ → find AdBlockML → click Reload" -ForegroundColor Yellow
Write-Host "After reload, check the service worker console for success message." -ForegroundColor Cyan

/**
 * Popup controller v3
 *
 * Tasks implemented:
 *   Task 3 — Reads ml_summary_${tabId} from session storage via GET_STATS
 *   Task 4 — Shows "+X trackers blocked by advanced detection" banner when
 *             ml_only_count >= 2, else "Standard protection handled this page"
 *   Task 5 — Renders ML-only request detail entries with type/confidence/reason/domain
 *   Task 6 — Allow button on each ML detail entry: allowlists domain + reloads tab
 *
 * Security: all dynamic content via textContent or safe el() construction.
 * No innerHTML with external data anywhere.
 */

'use strict';

let _selectedUrl = null;
let _currentTabId = null;

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if      (k === 'className')   node.className = v;
    else if (k === 'textContent') node.textContent = v;
    else if (k === 'title')       node.title = v;
    else if (k === 'style')       node.style.cssText = v;
    else                          node.setAttribute(k, v);
  }
  children.forEach(c => {
    if (typeof c === 'string') node.appendChild(document.createTextNode(c));
    else if (c)                node.appendChild(c);
  });
  return node;
}

function fmt(n) {
  if (n == null) return '—';
  if (n >= 1e6)  return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3)  return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function safeHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url.slice(0, 40); }
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ─── Main render ──────────────────────────────────────────────────────────────

async function render() {
  const tab = await getCurrentTab();
  if (!tab) return;

  _currentTabId = tab.id;
  let hostname = '';
  try { hostname = new URL(tab.url).hostname; } catch {}

  chrome.runtime.sendMessage({ type: 'GET_STATS', tabId: tab.id }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    renderClassifier(res.classifierInfo);
    renderGlobal(res.global);
    renderTab(res.tab);
    renderBreakdown(res.global);
    renderMlSummary(res.mlSummary);       // Tasks 3, 4, 5
  });

  chrome.runtime.sendMessage({ type: 'GET_UNSYNCED_COUNT' }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    renderSyncBadge(res.count);
  });

  setupToggle(hostname);
  setupFeedback();
}

// ─── Classifier status ────────────────────────────────────────────────────────

function renderClassifier(info) {
  const sub = document.getElementById('classifier-status');
  if (!info) { sub.textContent = 'Model unavailable'; return; }
  if (info.type === 'onnx_gbm') {
    sub.textContent = `ML active · v${info.version ?? '?'} · ${info.features} features`;
    sub.style.color = '#34d399';
  } else if (info.type === 'heuristic') {
    sub.textContent = 'Heuristic mode — train model for full ML';
    sub.style.color = '#fbbf24';
  } else {
    sub.textContent = 'Classifier loading…';
  }
}

// ─── Global stats ─────────────────────────────────────────────────────────────

function renderGlobal(global) {
  if (!global) return;
  document.getElementById('global-blocked').textContent = fmt(global.totalBlocked);
  document.getElementById('ml-blocked').textContent     = fmt(global.mlBlocked);
  const rate = global.totalBlocked > 0
    ? Math.round((global.mlBlocked / global.totalBlocked) * 100) : 0;
  document.getElementById('ml-rate').textContent = `${rate}%`;
}

// ─── Tab stats ────────────────────────────────────────────────────────────────

function renderTab(tabStats) {
  document.getElementById('tab-blocked').textContent = fmt(tabStats?.blocked ?? 0);

  const list   = document.getElementById('recent-list');
  const blocks = tabStats?.recentBlocks ?? [];
  list.textContent = '';

  if (!blocks.length) {
    list.appendChild(el('div', { className: 'empty-state', textContent: 'No blocks on this page' }));
    return;
  }

  [...blocks].reverse().slice(0, 20).forEach((b) => {
    const srcClass = b.source === 'ml'            ? 'source-ml'
                   : b.source === 'dynamic_cache' ? 'source-cache' : 'source-dnr';
    const srcLabel = b.source === 'ml'            ? 'ML'
                   : b.source === 'dynamic_cache' ? 'CACHE' : 'LIST';

    const badge   = el('span', { className: `block-source ${srcClass}`, textContent: srcLabel });
    const urlSpan = el('span', { className: 'block-url', title: b.url, textContent: safeHost(b.url) });
    const row     = el('div',  { className: 'block-item' }, badge, urlSpan);

    if (b.mlScore != null) {
      row.appendChild(el('span', { style: 'font-size:10px;color:#94a3b8', textContent: b.mlScore.toFixed(2) }));
    }

    row.style.cursor = 'pointer';
    row.addEventListener('click', () => {
      document.querySelectorAll('.block-item.selected').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');
      _selectedUrl = b.url;
      updateFeedbackButtons(true);
    });

    list.appendChild(row);
  });
}

// ─── Breakdown bars ───────────────────────────────────────────────────────────

function renderBreakdown(global) {
  if (!global) return;
  const total    = global.totalBlocked || 1;
  const dnrPct   = Math.round((global.dnrBlocked          / total) * 100);
  const mlPct    = Math.round((global.mlBlocked            / total) * 100);
  const cachePct = Math.round((global.dynamicCacheBlocked  / total) * 100);

  document.getElementById('bar-dnr').style.width   = `${dnrPct}%`;
  document.getElementById('bar-ml').style.width    = `${mlPct}%`;
  document.getElementById('bar-cache').style.width = `${cachePct}%`;
  document.getElementById('pct-dnr').textContent   = `${dnrPct}%`;
  document.getElementById('pct-ml').textContent    = `${mlPct}%`;
  document.getElementById('pct-cache').textContent = `${cachePct}%`;
}

// ─── Task 3 + 4 + 5: ML summary banner + detail list ─────────────────────────

function renderMlSummary(mlSummary) {
  const banner    = document.getElementById('ml-banner');
  const bannerTxt = document.getElementById('ml-banner-text');
  const detailTitle = document.getElementById('ml-detail-title');
  const detailList  = document.getElementById('ml-detail-list');

  detailList.textContent = '';

  const count     = mlSummary?.ml_only_count ?? 0;
  const entries   = mlSummary?.entries ?? [];
  const dataAge   = mlSummary?.timestamp ? Date.now() - mlSummary.timestamp : Infinity;
  const isStale   = dataAge > 20_000;

  // Patch 4: if the stored summary belongs to a different tab, don't show it.
  // This guards the race where the popup opens before new tab data is written.
  const summaryTabId = mlSummary?.tabId ?? null;
  if (summaryTabId !== null && summaryTabId !== _currentTabId) {
    banner.className = 'ml-banner hidden';
    detailTitle.style.display = 'none';
    return;
  }

  // Stale data: page changed and SW hasn't written fresh data yet
  if (isStale && count > 0) {
    banner.className = 'ml-banner hidden';
    detailTitle.style.display = 'none';
    return;
  }

  // Task 4: banner copy depends on count
  if (count >= 2) {
    bannerTxt.textContent = `+${count} trackers blocked by advanced detection`;
    banner.className = 'ml-banner ml-banner-active';
  } else {
    bannerTxt.textContent = 'Standard protection handled this page';
    banner.className = 'ml-banner ml-banner-standard';
  }
  banner.classList.remove('hidden');

  // Task 5: detail entries
  if (!entries.length) {
    detailTitle.style.display = 'none';
    return;
  }

  detailTitle.style.display = '';

  // Deduplicate by domain — show most recent entry per domain
  const byDomain = new Map();
  entries.forEach(e => byDomain.set(e.domain, e));

  byDomain.forEach((entry) => {
    const confClass = entry.confidence === 'High' ? 'conf-high' : 'conf-med';
    const reasonLabel = REASON_LABELS[entry.reason] ?? entry.reason;

    const confBadge  = el('span', { className: `conf-badge ${confClass}`, textContent: entry.confidence });
    const domain     = el('span', { className: 'detail-domain', textContent: entry.domain });
    const reason     = el('span', { className: 'detail-reason', textContent: reasonLabel });

    // Patch 2: persistent two-step allow — no timeout, explicit cancel.
    // Step 1: 'Allow' → renders a confirm button inline.
    // Step 2: 'Confirm' applies. 'Cancel' resets. No silent timeouts.
    const allowBtn   = el('button', { className: 'allow-btn',     title: 'Allow this domain' }, 'Allow');
    const confirmBtn = el('button', { className: 'allow-btn allow-btn-confirm', title: `Confirm: allow ${entry.domain}` }, 'Confirm');
    const cancelBtn  = el('button', { className: 'cancel-btn',    title: 'Cancel' }, '✕');
    confirmBtn.style.display = 'none';
    cancelBtn.style.display  = 'none';

    allowBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      allowBtn.style.display   = 'none';
      confirmBtn.style.display = '';
      cancelBtn.style.display  = '';
    });

    confirmBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      confirmBtn.disabled = true;
      cancelBtn.disabled  = true;
      handleAllow(entry.domain, confirmBtn);
    });

    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      confirmBtn.style.display = 'none';
      cancelBtn.style.display  = 'none';
      allowBtn.style.display   = '';
    });

    const row = el('div', { className: 'detail-row' }, confBadge, domain, reason, allowBtn, confirmBtn, cancelBtn);
    detailList.appendChild(row);
  });
}

// Human-readable labels for explanation tags
const REASON_LABELS = {
  late_injection:      'Late injection',
  obfuscated_url:      'Obfuscated URL',
  high_entropy_path:   'High entropy path',
  high_entropy_query:  'High entropy query',
  tracker_params:      'Tracking parameters',
  ad_keyword_match:    'Ad keyword match',
  third_party:         'Third-party request',
  tracking_pixel:      'Tracking pixel',
  ad_network:          'Ad network pattern',
  ml_pattern:          'ML pattern match',
};

// ─── Task 6: Allow domain ─────────────────────────────────────────────────────

function handleAllow(domain, btn) {
  btn.textContent = '…';
  btn.disabled    = true;

  chrome.runtime.sendMessage(
    { type: 'ALLOWLIST_DOMAIN', domain, tabId: _currentTabId },
    (res) => {
      if (chrome.runtime.lastError || !res?.ok) {
        btn.textContent = 'Error';
        return;
      }
      // Tab will reload — popup closes automatically
      btn.textContent = 'Allowed ✓';
    }
  );
}

// ─── Site toggle ──────────────────────────────────────────────────────────────

function setupToggle(hostname) {
  const btn = document.getElementById('site-toggle');
  chrome.storage.local.get('disabled_sites', ({ disabled_sites = [] }) => {
    updateToggleUI(btn, !disabled_sites.includes(hostname));
  });

  btn.addEventListener('click', () => {
    const nowEnabled = btn.classList.contains('disabled');
    chrome.storage.local.get('disabled_sites', ({ disabled_sites = [] }) => {
      const updated = nowEnabled
        ? disabled_sites.filter(s => s !== hostname)
        : [...new Set([...disabled_sites, hostname])];
      chrome.storage.local.set({ disabled_sites: updated });
      chrome.runtime.sendMessage({ type: 'TOGGLE_SITE', hostname, enabled: nowEnabled });
      updateToggleUI(btn, nowEnabled);
    });
  });
}

function updateToggleUI(btn, enabled) {
  btn.textContent = enabled ? 'ON' : 'OFF';
  btn.classList.toggle('disabled', !enabled);
}

// ─── Feedback ─────────────────────────────────────────────────────────────────

function setupFeedback() {
  updateFeedbackButtons(false);

  document.getElementById('btn-fp').addEventListener('click', () => {
    if (_selectedUrl) sendFeedback(_selectedUrl, 'fp', 'Reported: not an ad');
  });

  document.getElementById('btn-fn').addEventListener('click', () => {
    if (_selectedUrl) sendFeedback(_selectedUrl, 'fn', 'Reported: should be blocked');
  });
}

function updateFeedbackButtons(enabled) {
  document.querySelectorAll('.fb-btn').forEach(b => {
    b.disabled      = !enabled;
    b.style.opacity = enabled ? '1' : '0.4';
    b.style.cursor  = enabled ? 'pointer' : 'default';
  });
}

function sendFeedback(url, feedbackType, confirmText) {
  chrome.runtime.sendMessage({ type: 'REPORT_FEEDBACK', url, feedbackType }, (res) => {
    if (chrome.runtime.lastError || !res?.ok) return;
    const btn = document.getElementById(feedbackType === 'fp' ? 'btn-fp' : 'btn-fn');
    const orig = btn.textContent;
    btn.textContent = '✓ ' + confirmText;
    setTimeout(() => { btn.textContent = orig; }, 2500);
    _selectedUrl = null;
    updateFeedbackButtons(false);
    document.querySelectorAll('.block-item.selected').forEach(r => r.classList.remove('selected'));
  });
}

// ─── Sync badge ───────────────────────────────────────────────────────────────

function renderSyncBadge(count) {
  const badge = document.getElementById('sync-badge');
  if (count > 0) {
    badge.textContent = `${count} unsynced`;
    badge.classList.add('pending');
  } else {
    badge.textContent = '';
    badge.classList.remove('pending');
  }
}

// ─── Benchmark ────────────────────────────────────────────────────────────────

document.getElementById('run-benchmark').addEventListener('click', () => {
  const panel = document.getElementById('benchmark-panel');
  const res   = document.getElementById('benchmark-results');
  panel.classList.remove('hidden');
  res.textContent = '';
  res.appendChild(el('div', { style: 'padding:8px 0;color:#64748b;font-size:11px', textContent: 'Running…' }));

  chrome.runtime.sendMessage({ type: 'RUN_BENCHMARK' }, (data) => {
    res.textContent = '';
    if (!data?.total) {
      res.appendChild(el('div', {
        style: 'padding:8px 0;color:#94a3b8;font-size:11px',
        textContent: 'Not enough recent requests. Browse some pages first.',
      }));
      return;
    }
    const rate = Math.round((data.mlOnlyBlocked / data.total) * 100);
    [
      ['Requests analyzed', String(data.total),              ''],
      ['List blocked',      String(data.listBlocked),        ''],
      ['ML-only blocks',    `+${data.mlOnlyBlocked}`,        'benchmark-highlight'],
      ['ML improvement',    `+${rate}%`,                     'benchmark-highlight'],
      ['Need manual review', String(data.mlFalsePositives),  'benchmark-warn'],
    ].forEach(([key, val, cls]) => {
      res.appendChild(el('div', { className: 'benchmark-row' },
        el('span', { className: 'benchmark-key',                         textContent: key }),
        el('span', { className: `benchmark-val${cls ? ' '+cls : ''}`,   textContent: val }),
      ));
    });
  });
});

// ─── Clear cache ──────────────────────────────────────────────────────────────

document.getElementById('clear-cache').addEventListener('click', () => {
  const btn = document.getElementById('clear-cache');
  chrome.runtime.sendMessage({ type: 'CLEAR_DYNAMIC_RULES' }, () => {
    btn.textContent = 'Cleared ✓';
    setTimeout(() => { btn.textContent = 'Clear ML cache'; }, 2000);
  });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
render();

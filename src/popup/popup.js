document.addEventListener("DOMContentLoaded", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  chrome.runtime.sendMessage({ type: "GET_STATS", tabId: tab?.id }, async (response) => {
    if (!response) return;

    const global = response.global ?? {};
    const tabStats = response.tab ?? {};
    
    // Core stats
    const blockedPage = tabStats.blocked ?? 0;
    const blockedTotal = global.totalBlocked ?? 0;
    
    // Fetch ML-only summary from session storage
    const mlSummaryKey = 'ml_summary_' + tab.id;
    const sessionData = await chrome.storage.session.get(mlSummaryKey);
    const mlSummary = sessionData[mlSummaryKey] ?? {};
    const mlOnlyCount = mlSummary.ml_only_count ?? 0;
    const mlEntries = mlSummary.entries ?? [];

    // PROOF ENGINE: Calculate contribution
    const mlContribution = blockedTotal > 0
      ? Math.round(((global.mlBlocked ?? 0) / blockedTotal) * 100)
      : 0;

    // Update core stats
    document.getElementById("blocked-page").textContent = blockedPage;
    document.getElementById("blocked-total").textContent = blockedTotal;
    document.getElementById("ml-only").textContent = mlOnlyCount;
    document.getElementById("ml-contribution").textContent = mlContribution + "%";

    // PROOF ENGINE: Hero Banner (≥2 ML-only = show)
    const banner = document.getElementById("ml-banner");
    const bannerText = document.getElementById("ml-banner-text");
    
    if (mlOnlyCount >= 2) {
      banner.classList.remove("hidden");
      bannerText.textContent = `+${mlOnlyCount} additional trackers blocked by advanced detection`;
    } else if (blockedPage > 0) {
      banner.classList.remove("hidden");
      bannerText.textContent = "Standard protection handled this page";
    }

    // PROOF ENGINE: ML-only details with explanations
    const detailTitle = document.getElementById("ml-detail-title");
    const detailList = document.getElementById("ml-detail-list");
    
    if (mlOnlyCount >= 1 && mlEntries.length > 0) {
      detailTitle.style.display = "block";
      detailList.innerHTML = "";
      
      // Show up to 5 most recent, deduplicated by domain
      const seen = new Set();
      mlEntries.slice(-5).reverse().forEach(entry => {
        if (seen.has(entry.domain)) return;
        seen.add(entry.domain);
        
        const item = document.createElement("div");
        item.className = "ml-detail-item";
        
        const confClass = entry.confidence === "High" ? "conf-high" : "conf-med";
        const reasonText = formatReason(entry.reason);
        
        item.innerHTML = `
          <div class="ml-detail-header">
            <span class="ml-detail-domain">${truncate(entry.domain, 35)}</span>
            <span class="ml-detail-conf ${confClass}">${entry.confidence}</span>
          </div>
          <div class="ml-detail-reason">${reasonText}</div>
          <button class="ml-detail-allow" data-domain="${entry.domain}">Allow this domain</button>
        `;
        
        detailList.appendChild(item);
      });
      
      // Attach allow button handlers
      document.querySelectorAll(".ml-detail-allow").forEach(btn => {
        btn.addEventListener("click", () => handleAllow(btn.dataset.domain));
      });
    }

    // Source breakdown
    const dnrCount = global.dnrBlocked ?? 0;
    const mlCount = global.mlBlocked ?? 0;
    const cacheCount = global.dynamicCache ?? 0;
    const total = dnrCount + mlCount + cacheCount;
    
    if (total > 0) {
      updateBar("dnr", dnrCount, total);
      updateBar("ml", mlCount, total);
      updateBar("cache", cacheCount, total);
    }

    // Recent blocks
    const recentList = document.getElementById("recent-list");
    const recentBlocks = tabStats.recentBlocks ?? [];
    
    if (recentBlocks.length > 0) {
      recentList.innerHTML = "";
      recentBlocks.slice(-10).reverse().forEach(block => {
        const item = document.createElement("div");
        item.className = "recent-item";
        item.innerHTML = `
          <div class="recent-url">${truncate(block.url, 50)}</div>
          <div class="recent-meta">
            <span class="recent-source">${block.source}</span>
            ${block.mlScore ? `<span class="recent-score">${(block.mlScore * 100).toFixed(0)}%</span>` : ''}
          </div>
        `;
        recentList.appendChild(item);
      });
    }
  });
});

// PROOF ENGINE: Format reason tags into human-readable text
function formatReason(reason) {
  const map = {
    late_injection: "Script injected after page load",
    obfuscated_url: "Obfuscated tracking URL",
    high_entropy_path: "Randomly generated tracker path",
    high_entropy_query: "Fingerprinting parameters detected",
    tracker_params: "Analytics tracking identifiers",
    ad_keyword_match: "Known advertising pattern",
    tracking_pixel: "Invisible tracking pixel",
    ad_network: "Ad network domain",
    third_party: "Third-party tracker",
    ml_pattern: "Suspicious behavioral pattern"
  };
  return map[reason] ?? "Advanced pattern detected";
}

// PROOF ENGINE: Two-step allow flow
function handleAllow(domain) {
  if (!confirm(`Allow all requests from ${domain}?\n\nThis will reload the page.`)) {
    return;
  }
  
  chrome.runtime.sendMessage({
    type: "ALLOW_DOMAIN",
    domain: domain
  }, () => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      chrome.tabs.reload(tab.id);
      window.close();
    });
  });
}

function updateBar(id, count, total) {
  const pct = Math.round((count / total) * 100);
  document.getElementById(`bar-${id}`).style.width = pct + "%";
  document.getElementById(`pct-${id}`).textContent = pct + "%";
}

function truncate(str, len) {
  return str.length > len ? str.substring(0, len) + "..." : str;
}

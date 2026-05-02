document.addEventListener("DOMContentLoaded", async () => {

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  chrome.runtime.sendMessage({ type: "GET_STATS", tabId: tab?.id }, (response) => {

    const global = response?.global ?? {};
    const tabStats = response?.tab ?? {};

    const blockedPage = tabStats.blocked ?? 0;
    const blockedTotal = global.totalBlocked ?? 0;
    const mlOnly = tabStats.mlBlocks ?? 0;

    const mlContribution = blockedTotal > 0
      ? Math.round(( (global.mlBlocked ?? 0) / blockedTotal ) * 100)
      : 0;

    document.getElementById("blocked-page").textContent = blockedPage;
    document.getElementById("blocked-total").textContent = blockedTotal;
    document.getElementById("ml-only").textContent = mlOnly;
    document.getElementById("ml-contribution").textContent = mlContribution + "%";

  });

});
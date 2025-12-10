(() => {
  let lastData = null;
  const qs = (s) => document.querySelector(s);
  const qsa = (s) => Array.from(document.querySelectorAll(s));
  const setText = (sel, val) => { const el = qs(sel); if (el) el.textContent = val; };
  // Backward-compat: stub to prevent legacy calls after hot reloads
  function resolveDashboardUrl(path = '') {
    try {
      const base = (typeof chrome !== 'undefined' && chrome?.runtime?.getURL) ? chrome.runtime.getURL('sidepanel.html') : 'sidepanel.html';
      return base;
    } catch (_) { return 'sidepanel.html'; }
  }

  // Extension context detection (avoid errors in preview outside Chrome)
  const hasChromeRuntime = typeof chrome !== 'undefined' && !!(chrome.runtime && typeof chrome.runtime.sendMessage === 'function');
  const hasChromeTabs = typeof chrome !== 'undefined' && !!(chrome.tabs && typeof chrome.tabs.create === 'function');

  function applyData(data) {
    lastData = data;
    setText("#c-critique", data.counters.Critique || 0);
    setText("#c-majeure", data.counters.Majeure || 0);
    setText("#c-moyenne", data.counters.Moyenne || 0);
    setText("#c-mineure", data.counters.Mineure || 0);
    setText("#score-global", data.scoreGlobal);
    setText("#score-perc", data.principleScores.Perceivable);
    setText("#score-oper", data.principleScores.Operable);
    setText("#score-under", data.principleScores.Understandable);
    setText("#score-robust", data.principleScores.Robust);

    // Partial banner (CSP/SOP)
    if (data.partial) {
      setText('#status', `Partial scan (cross-origin iframes: ${data.crossOriginIframes || 0})`);
    } else {
      setText('#status', 'Scan completed');
    }
    const statusEl = qs('#status');
    if (statusEl) statusEl.classList.toggle('status-partial', !!data.partial);

    // Detailed lists and filters are now shown only in the Side Panel
  }

  qs("#btn-scan").addEventListener("click", async () => {
    if (!hasChromeRuntime) {
      setText("#status", "Scan available only in the Chrome extension.");
      return;
    }
    setText("#status", "Running accessibility scan…");
    try {
      const res = await chrome.runtime.sendMessage({ type: "scan" });
      if (!res?.ok) throw new Error(res?.error || "Scan failed");
      applyData(res);
      setText("#status", "Scan completed. Open the Side Panel for details.");
    } catch (e) {
      setText("#status", "Error: " + (e?.message || e));
    }
  });

  const btnScanDark = qs("#btn-scan-dark");
  if (btnScanDark) {
    btnScanDark.addEventListener("click", async () => {
      if (!hasChromeRuntime) {
        setText("#status", "Scan available only in the Chrome extension.");
        return;
      }
      setText("#status", "Running dark patterns scan…");
      try {
        const scanId = 'dp-' + Date.now().toString(36);
        const res = await chrome.runtime.sendMessage({ type: "dark-scan", viewport: "desktop", scanId });
        if (!res?.ok) throw new Error(res?.error || "Scan failed");
        setText("#status", "Dark patterns scan completed. Open the Side Panel for details.");
      } catch (e) {
        setText("#status", "Error: " + (e?.message || e));
      }
    });
  }

  // Open Chrome side panel
  const openDashBtn = qs('#btn-open-dashboard');
  if (openDashBtn && hasChromeRuntime && chrome?.sidePanel?.setOptions) {
    openDashBtn.addEventListener('click', async () => {
      try {
        // Ouvre le side panel pour l’onglet courant
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          await chrome.sidePanel.setOptions({ tabId: tab.id, path: 'sidepanel.html', enabled: true });
          await chrome.sidePanel.open({ tabId: tab.id });
        } else {
          // Fallback: ouverture dans une nouvelle onglet de la ressource sidepanel
          if (hasChromeTabs) chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html') });
          else window.open(chrome.runtime.getURL('sidepanel.html'), '_blank', 'noopener');
        }
      } catch (e) {
        // Fallback si API non disponible
        if (hasChromeTabs) chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html') });
        else window.open(chrome.runtime.getURL('sidepanel.html'), '_blank', 'noopener');
      }
    });
  }

  // Enterprise guide removed
})();
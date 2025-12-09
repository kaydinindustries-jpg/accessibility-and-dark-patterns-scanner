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

  function renderFindings(findings) {
    const list = qs("#findings");
    list.innerHTML = "";
    const activeFilters = new Set(qsa(".f:checked").map(el => el.value));
    const filterMatch = (f) => {
      if (activeFilters.size === 0) return true;
      const tags = f.tags || [];
      if (activeFilters.has("contrast") && tags.includes("cat.color")) return true;
      if (activeFilters.has("keyboard") && tags.includes("cat.keyboard")) return true;
      if (activeFilters.has("forms") && tags.includes("cat.forms")) return true;
      if (activeFilters.has("aria") && tags.includes("cat.name-role-value")) return true;
      return false;
    };
    for (const f of findings) {
      // Exclude advice and unmapped rules from main list
      if (f.advice === true || f.needsMapping === true) continue;
      if (!filterMatch(f)) continue;
      const li = document.createElement("li");
      li.className = "finding";
      li.innerHTML = `
        <div class="id">${f.id} <small>(${f.status || 'violation'} • ${f.impact})</small></div>
        <div>WCAG: ${(f.wcagRef || []).join(", ") || (f.needsMapping ? 'needs-mapping' : '-')}</div>
        <div>EN 301 549: ${(f.en301549Ref || []).join(", ") || '-'}</div>
        <div>Principe: ${f.principle || '-'}</div>
        <div>Sélecteurs: ${(f.selectors || []).join(" ") || "-"}</div>
        <div>Extrait: <code>${(f.snippet || "").replace(/</g,"&lt;").slice(0,240)}</code></div>
        <div>Aide: ${(f.help || "-")}</div>
      `;
      list.appendChild(li);
    }
  }

  function renderAdvice(findings) {
    const container = qs('#advice-container');
    const list = qs('#advice-list');
    if (!container || !list) return;
    list.innerHTML = '';
    const adv = [];
    const seen = new Set();
    for (const f of findings || []) {
      if (!(f.advice === true || f.needsMapping === true)) continue;
      const key = f.id;
      if (seen.has(key)) continue;
      seen.add(key);
      adv.push(f);
    }
    if (adv.length === 0) {
      container.classList.add('hidden');
      return;
    }
    for (const f of adv) {
      const li = document.createElement('li');
      const wcagBadge = (f.needsMapping && !f.advice) ? '<em>(needs-mapping)</em>' : '';
      li.innerHTML = `
        <div><strong>${f.id}</strong> ${wcagBadge}</div>
        <div class="small">${f.help || 'Conseil axe-core non bloquant.'}</div>
      `;
      list.appendChild(li);
    }
    container.classList.remove('hidden');
  }

  // Update filter badges by category
  function updateFilterBadges(findings) {
    const counts = { contrast: 0, keyboard: 0, forms: 0, aria: 0 };
    for (const f of findings || []) {
      if (f.advice === true || f.needsMapping === true) continue;
      const t = f.tags || [];
      if (t.includes('cat.color')) counts.contrast++;
      if (t.includes('cat.keyboard')) counts.keyboard++;
      if (t.includes('cat.forms')) counts.forms++;
      if (t.includes('cat.name-role-value')) counts.aria++;
    }
    setText('#count-contrast', counts.contrast);
    setText('#count-keyboard', counts.keyboard);
    setText('#count-forms', counts.forms);
    setText('#count-aria', counts.aria);
  }

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

    // Sample summary (if any)
    const sample = Array.isArray(data.sample) ? data.sample : [];
    if (sample.length) {
      const n = qs('#sample-status');
      if (n) n.textContent = `Pages covered: ${sample.length} — ${sample.slice(0,6).join(', ')}${sample.length>6?'…':''}`;
    }
    const ss = data.sampleStats;
    const ssNode = qs('#sample-summary');
    if (ssNode) {
      if (ss && typeof ss.count === 'number' && ss.count > 1) {
        ssNode.textContent = `Échantillon — min: ${ss.min}, médiane: ${ss.median}, moyenne: ${ss.mean}, max: ${ss.max} (n=${ss.count})`;
      } else {
        ssNode.textContent = '';
      }
    }

    // Missing mapping alert
    if (data.needsMapping) {
      const warn = document.createElement('div');
      warn.className = 'warning';
      warn.textContent = `Warning: axe rules without mapping: ${(data.unknownRules || []).join(', ')}`;
      const container = document.querySelector('.container');
      container.insertBefore(warn, container.firstChild.nextSibling);
    }

    // Contrast summary
    if (data.contrast?.summary) {
      const { total, fails, needsManual } = data.contrast.summary;
      const node = document.createElement('div');
      node.className = 'contrast-summary';
      node.textContent = `Contrast: ${fails} failure(s), ${needsManual} need(s) manual check over ${total} text elements.`;
      const container = document.querySelector('.container');
      container.insertBefore(node, document.querySelector('.filters'));
    }

    // Màj compteurs filtres
    updateFilterBadges(data.findings || []);

    renderAdvice(data.findings || []);
    renderFindings(data.findings || []);
  }

  qs("#btn-scan").addEventListener("click", async () => {
    if (!hasChromeRuntime) {
      setText("#status", "Scan disponible uniquement dans l’extension Chrome (aperçu hors extension)");
      return;
    }
    setText("#status", "Scan en cours…");
    try {
      const res = await chrome.runtime.sendMessage({ type: "scan" });
      if (!res?.ok) throw new Error(res?.error || "Échec du scan");
      applyData(res);
    } catch (e) {
      setText("#status", "Erreur: " + (e?.message || e));
    }
  });

  qsa(".f").forEach(el => {
    el.addEventListener("change", () => {
      if (lastData) renderFindings(lastData.findings || []);
    });
  });

  // Initial load of sampling values
  async function loadSample() {
    if (!hasChromeRuntime || !chrome.storage || !chrome.storage.local) return;
    try {
      const { meta_sample, meta_perimeter } = await chrome.storage.local.get(['meta_sample', 'meta_perimeter']);
      if (Array.isArray(meta_sample) && meta_sample.length) {
        qs('#sample-urls').value = meta_sample.join('\n');
      }
      if (typeof meta_perimeter === 'string') qs('#sample-perimeter').value = meta_perimeter;
    } catch(_){}}

  async function saveSample() {
    if (!hasChromeRuntime || !chrome.storage || !chrome.storage.local) return;
    const raw = qs('#sample-urls').value || '';
    const perimeter = (qs('#sample-perimeter').value || '').trim();
    const urls = raw.split(/\n+/).map(s => s.trim()).filter(Boolean);
    try {
      await chrome.storage.local.set({ meta_sample: urls.slice(0, 50), meta_perimeter: perimeter, meta_sample_saved_at: Date.now() });
      setText('#sample-status', `Échantillon enregistré (${urls.length} URL).`);
    } catch (e) {
      setText('#sample-status', `Erreur enregistrement: ${e?.message || e}`);
    }
  }

  const btnSave = qs('#btn-save-sample');
  if (btnSave) btnSave.addEventListener('click', saveSample);
  loadSample();

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
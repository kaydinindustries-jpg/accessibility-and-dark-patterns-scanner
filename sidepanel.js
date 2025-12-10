 (async () => {
  const qs = (s) => document.querySelector(s);
  const qsa = (s) => Array.from(document.querySelectorAll(s));
  const setText = (sel, val) => { const el = qs(sel); if (el) el.textContent = String(val); };
  const hasChromeRuntime = typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.sendMessage);

  // ---------- ACCESSIBILITY VIEW ----------

  async function getLastScan() {
    return new Promise((resolve) => {
      const DB_NAME = 'eaa_auditor_db';
      const STORE = 'scans';
      const req = indexedDB.open(DB_NAME);
      req.onsuccess = () => {
        try {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            resolve(null);
            return;
          }
          const tx = db.transaction(STORE, 'readonly');
          const idx = tx.objectStore(STORE).index('by_time');
          const items = [];
          idx.openCursor(null, 'prev').onsuccess = (ev) => {
            const cursor = ev.target.result;
            if (cursor && items.length < 1000) { items.push(cursor.value); cursor.continue(); } else { resolve(items[0] || null); }
          };
          tx.onerror = () => resolve(null);
        } catch (_) {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  }

  function updateFilterCounters(findings) {
    const counts = { contrast: 0, keyboard: 0, forms: 0, aria: 0 };
    for (const f of findings || []) {
      if (f.advice === true || f.needsMapping === true) continue;
      const t = f.tags || [];
      if (t.includes('cat.color')) counts.contrast++;
      if (t.includes('cat.keyboard')) counts.keyboard++;
      if (t.includes('cat.forms')) counts.forms++;
      if (t.includes('cat.name-role-value')) counts.aria++;
    }
    setText('#fc-contrast', counts.contrast);
    setText('#fc-keyboard', counts.keyboard);
    setText('#fc-forms', counts.forms);
    setText('#fc-aria', counts.aria);
  }

  function renderItems(data) {
    const list = qs('#items');
    if (!list) return;
    const term = (qs('#search')?.value || '').toLowerCase();
    const selected = new Set(qsa('.ff:checked').map(el => el.value));
    const sortBy = qs('#sort')?.value || 'impact';
    list.innerHTML = '';
    const base = (data.findings || []).filter(f => !(f.advice === true || f.needsMapping === true));
    let arr = base.filter(f => {
      if (selected.size) {
        const t = f.tags || [];
        if (selected.has('contrast') && !t.includes('cat.color')) return false;
        if (selected.has('keyboard') && !t.includes('cat.keyboard')) return false;
        if (selected.has('forms') && !t.includes('cat.forms')) return false;
        if (selected.has('aria') && !t.includes('cat.name-role-value')) return false;
      }
      if (term) {
        const txt = [f.id, (f.wcagRef||[]).join(' '), (f.selectors||[]).join(' '), f.snippet || ''].join(' ').toLowerCase();
        if (!txt.includes(term)) return false;
      }
      return true;
    });

    const impactOrder = { 'Critique': 0, 'Majeure': 1, 'Moyenne': 2, 'Mineure': 3 };
    arr.sort((a, b) => {
      if (sortBy === 'impact') return (impactOrder[a.impact] ?? 99) - (impactOrder[b.impact] ?? 99);
      if (sortBy === 'wcag') return ((a.wcagRef||[]).join(',')).localeCompare((b.wcagRef||[]).join(','));
      if (sortBy === 'principle') return (a.principle||'').localeCompare(b.principle||'');
      return 0;
    });

    const frag = document.createDocumentFragment();
    for (const f of arr) {
      const li = document.createElement('li');
      li.className = 'item';
      li.innerHTML = `
        <div class="id">${f.id} <small class="impact-${f.impact}">(${f.status || 'violation'} • ${f.impact})</small> <small class="principle">${f.principle || '-'}</small></div>
        <div class="meta">WCAG: ${(f.wcagRef || []).join(', ') || (f.needsMapping ? 'needs-mapping' : '-')} — EN: ${(f.en301549Ref || []).join(', ') || '-'}</div>
        <div class="meta">Selectors: ${(f.selectors || []).join(' ') || '-'}</div>
        <div class="meta">Snippet: <code>${(f.snippet || '').replace(/</g,'&lt;').slice(0,280)}</code></div>
      `;
      frag.appendChild(li);
    }
    list.appendChild(frag);
  }

  let exportsWired = false;
  let lastAccessibilityData = null;

  async function applyAccessibilityData(data) {
    if (!data) return;
    lastAccessibilityData = data;
    setText('#m-global', data.scoreGlobal ?? '-');
    setText('#m-crit', data.counters?.Critique ?? 0);
    setText('#m-maj', data.counters?.Majeure ?? 0);
    setText('#m-moy', data.counters?.Moyenne ?? 0);
    setText('#m-min', data.counters?.Mineure ?? 0);
    setText('#m-partial', data.partial ? 'yes' : 'no');
    updateFilterCounters(data.findings || []);
    renderItems(data);

    if (!exportsWired && hasChromeRuntime) {
      exportsWired = true;
      const sendExport = async (format) => {
        try {
          const darkActive = !!document.querySelector('#tab-dark[aria-selected="true"]');
          let payload;
          if (darkActive && lastDarkData) {
            // Export dark patterns report
            payload = {
              kind: 'dark',
              dark: lastDarkData,
              accessibility: lastAccessibilityData
            };
          } else if (lastAccessibilityData) {
            // Export accessibility report
            payload = {
              kind: 'accessibility',
              accessibility: lastAccessibilityData
            };
          } else {
            alert('Nothing to export yet. Run a scan first.');
            return;
          }
          const resp = await chrome.runtime.sendMessage({ type: 'export', format, data: payload });
          if (!resp?.ok) {
            alert('Export failed: ' + (resp?.error || 'unknown error'));
          }
        } catch (e) {
          alert('Export failed: ' + (e?.message || e));
        }
      };
      qs('#sp-export-json')?.addEventListener('click', () => sendExport('json'));
      qs('#sp-export-csv')?.addEventListener('click', () => sendExport('csv'));
      qs('#sp-export-doc')?.addEventListener('click', () => sendExport('doc'));
    }
    await loadHistory();
  }

  function resetAccessibilityUI() {
    setText('#m-global', '-');
    setText('#m-crit', 0);
    setText('#m-maj', 0);
    setText('#m-moy', 0);
    setText('#m-min', 0);
    setText('#m-partial', '-');
    setText('#fc-contrast', 0);
    setText('#fc-keyboard', 0);
    setText('#fc-forms', 0);
    setText('#fc-aria', 0);
    const list = qs('#items');
    if (list) list.innerHTML = '';
    lastAccessibilityData = null;
  }

  function resetDarkUI() {
    updateDarkSummary({ summary: { totalCandidates: 0, totalPatterns: 0, countsByPatternType: {}, countsByRisk: {} }, candidates: [], findings: [], modelVersion: '-' });
    const list = qs('#dp-items');
    if (list) list.innerHTML = '';
    setDarkState('idle');
    lastDarkData = null;
  }

  function wireAccessibilityFilters(data) {
    qsa('.ff').forEach(el => el.addEventListener('change', () => renderItems(data)));
    qs('#search')?.addEventListener('input', () => renderItems(data));
    qs('#sort')?.addEventListener('change', () => renderItems(data));
    qs('#sp-reset')?.addEventListener('click', () => {
      try {
        qsa('.ff:checked').forEach((el) => { el.checked = false; });
        const s = qs('#search'); if (s) s.value = '';
        const pf = qs('#dp-filter-pattern'); if (pf) pf.value = '';
        const rf = qs('#dp-filter-risk'); if (rf) rf.value = '';
        resetAccessibilityUI();
        resetDarkUI();
      } catch (_) {}
    });
  }

  // ---------- DARK PATTERNS VIEW ----------

  let lastDarkData = null;
  let candidateSelectorMap = new Map();

  const DP_STRINGS = {
    idle: "Click 'Scan dark patterns' to analyze this page.",
    scanning: "Scanning DOM and calling analysis backend…",
    error: "Analysis failed (network / parsing error). This does not mean your page is compliant.",
    noCandidates: "No relevant UI elements found to analyze on this page (no cookie banner, checkout, subscription flow, etc.).",
    noPatterns: "No obvious dark patterns detected according to our V1 heuristics. This is not a legal guarantee, but an indication."
  };

  function setDarkState(key, extra) {
    const el = qs('#dp-state');
    if (!el) return;
    let msg = DP_STRINGS[key] || '';
    if (extra) msg += ` ${extra}`;
    el.textContent = msg;
  }

  function updateDarkSummary(data) {
    const summary = data?.summary || {};
    setText('#dp-total-candidates', summary.totalCandidates ?? (data?.candidates?.length ?? 0));
    setText('#dp-total-patterns', summary.totalPatterns ?? (data?.findings?.filter(f => f.isDarkPattern).length ?? 0));

    const byRisk = summary.countsByRisk || { low: 0, medium: 0, high: 0 };
    setText('#dp-risk-high', byRisk.high ?? 0);
    setText('#dp-risk-medium', byRisk.medium ?? 0);
    setText('#dp-risk-low', byRisk.low ?? 0);

    setText('#dp-model', data?.modelVersion || 'unknown');
  }

  function buildCandidateSelectorMap(data) {
    candidateSelectorMap = new Map();
    const cands = data?.candidates || [];
    for (const c of cands) {
      if (c && c.id && c.xpathOrSelector) candidateSelectorMap.set(c.id, c.xpathOrSelector);
    }
  }

  function renderDarkItems(data) {
    const list = qs('#dp-items');
    if (!list) return;
    list.innerHTML = '';
    const findings = data?.findings || [];
    const patternFilter = qs('#dp-filter-pattern')?.value || '';
    const riskFilter = qs('#dp-filter-risk')?.value || '';

    const arr = findings.filter(f => {
      if (patternFilter && f.patternType !== patternFilter) return false;
      if (riskFilter && f.riskLevel !== riskFilter) return false;
      return true;
    });

    const frag = document.createDocumentFragment();
    for (const f of arr) {
      const li = document.createElement('li');
      li.className = 'dp-card';
      const selector = candidateSelectorMap.get(f.candidateId) || '';
      const riskClass = f.riskLevel === 'high' ? 'dp-badge-risk-high' : f.riskLevel === 'medium' ? 'dp-badge-risk-medium' : 'dp-badge-risk-low';
      const confidencePct = typeof f.confidence === 'number' ? Math.round(f.confidence * 100) : null;

      li.innerHTML = `
        <div class="dp-card-header">
          <div>
            <div class="small">candidate: <code>${f.candidateId}</code></div>
          </div>
          <div class="dp-badges">
            <span class="dp-badge dp-badge-type">${f.patternType}</span>
            <span class="dp-badge ${riskClass}">risk: ${f.riskLevel}</span>
            ${confidencePct != null ? `<span class="dp-badge dp-badge-confidence">conf: ${confidencePct}%</span>` : ''}
          </div>
        </div>
        <div class="small">${(f.explanation || '').slice(0, 320)}</div>
        <div class="small"><strong>Suggestion:</strong> ${(f.suggestedFix || '').slice(0, 320)}</div>
        <div class="small"><strong>Legal refs:</strong> ${(Array.isArray(f.legalRefs) && f.legalRefs.length) ? f.legalRefs.join(', ') : '-'}</div>
        <div class="small"><strong>Selector:</strong> <code>${selector || '-'}</code></div>
        <div class="dp-actions">
          <button type="button" class="dp-highlight" ${selector ? '' : 'disabled'}>Voir dans la page</button>
        </div>
      `;
      const btn = li.querySelector('.dp-highlight');
      if (btn && selector && hasChromeRuntime) {
        btn.addEventListener('click', async () => {
          try {
            await chrome.runtime.sendMessage({ type: 'dark-highlight', selector });
          } catch (e) {
            console.warn('dark-highlight failed', e);
          }
        });
      }
      frag.appendChild(li);
    }
    list.appendChild(frag);
  }

  async function applyDarkData(data) {
    lastDarkData = data;
    buildCandidateSelectorMap(data);
    updateDarkSummary(data);
    renderDarkItems(data);
    await loadHistory();
  }

  async function loadLastDarkScan() {
    if (!hasChromeRuntime) {
      setDarkState('idle', '(extension context only)');
      return;
    }
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'dark-last-scan' });
      if (resp?.ok && resp.data) {
        await applyDarkData(resp.data);
        setDarkState('idle');
      } else {
        setDarkState('idle');
      }
    } catch (e) {
      setDarkState('error');
    }
  }

  async function triggerDarkScan() {
    if (!hasChromeRuntime) {
      setDarkState('error', '(extension context only)');
      return;
    }
    setDarkState('scanning');
    try {
      const scanId = 'dp-' + Date.now().toString(36);
      const resp = await chrome.runtime.sendMessage({ type: 'dark-scan', viewport: 'desktop', scanId });
      if (!resp?.ok) {
        setDarkState('error', resp?.error ? `(${resp.error})` : '');
        return;
      }
      if (resp.stage === 'collect') {
        updateDarkSummary(resp.data || { summary: { totalCandidates: 0, totalPatterns: 0 } });
        lastDarkData = resp.data || null;
        setDarkState('noCandidates');
        const list = qs('#dp-items');
        if (list) list.innerHTML = '';
        return;
      }
      const data = resp.data;
      await applyDarkData(data);
      if (!data?.findings || data.findings.length === 0) {
        setDarkState('noPatterns');
      } else {
        setDarkState('idle');
      }
    } catch (e) {
      setDarkState('error', e?.message || String(e));
    }
  }

  function wireDarkUi() {
    const btnScan = qs('#dp-scan');
    if (btnScan) btnScan.addEventListener('click', triggerDarkScan);
    const pf = qs('#dp-filter-pattern');
    const rf = qs('#dp-filter-risk');
    if (pf) pf.addEventListener('change', () => lastDarkData && renderDarkItems(lastDarkData));
    if (rf) rf.addEventListener('change', () => lastDarkData && renderDarkItems(lastDarkData));
    setDarkState('idle');
  }

  // ---------- TABS ----------

  function switchTab(tab) {
    const accPanel = qs('#panel-accessibility');
    const darkPanel = qs('#panel-dark');
    const historyPanel = qs('#panel-history');
    const tAcc = qs('#tab-accessibility');
    const tDark = qs('#tab-dark');
    const tHist = qs('#tab-history');
    if (!accPanel || !darkPanel || !historyPanel || !tAcc || !tDark || !tHist) return;

    accPanel.hidden = true;
    darkPanel.hidden = true;
    historyPanel.hidden = true;
    tAcc.setAttribute('aria-selected', 'false');
    tDark.setAttribute('aria-selected', 'false');
    tHist.setAttribute('aria-selected', 'false');

    if (tab === 'dark') {
      darkPanel.hidden = false;
      tDark.setAttribute('aria-selected', 'true');
    } else if (tab === 'history') {
      historyPanel.hidden = false;
      tHist.setAttribute('aria-selected', 'true');
    } else {
      accPanel.hidden = false;
      tAcc.setAttribute('aria-selected', 'true');
    }
  }

  function wireTabs() {
    const tAcc = qs('#tab-accessibility');
    const tDark = qs('#tab-dark');
    const tHist = qs('#tab-history');
    if (tAcc) tAcc.addEventListener('click', () => switchTab('accessibility'));
    if (tDark) tDark.addEventListener('click', () => switchTab('dark'));
    if (tHist) tHist.addEventListener('click', () => switchTab('history'));
  }

  // ---------- INIT ----------

  const btnAccScan = qs('#sp-scan-accessibility');
  if (btnAccScan && hasChromeRuntime) {
    btnAccScan.addEventListener('click', async () => {
      try {
        const res = await chrome.runtime.sendMessage({ type: 'scan' });
        if (!res?.ok) {
          alert('Accessibility scan failed: ' + (res?.error || 'unknown error'));
          return;
        }
        await applyAccessibilityData(res);
      } catch (e) {
        alert('Accessibility scan failed: ' + (e?.message || e));
      }
    });
  }

  const last = await getLastScan();
  wireAccessibilityFilters(last || {});
  await applyAccessibilityData(last || {});
  wireTabs();
  wireDarkUi();
  await loadLastDarkScan();
  await loadHistory();
})();

async function getHistoryEntries(limit = 30) {
  return new Promise((resolve) => {
    const DB_NAME = 'eaa_auditor_db';
    const SCANS = 'scans';
    const DARK = 'dark_scans';
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => {
      try {
        const db = req.result;
        const items = [];
        let pending = 0;
        const done = () => {
          if (pending > 0) return;
          items.sort((a, b) => b.ts - a.ts);
          resolve(items.slice(0, limit));
        };

        if (db.objectStoreNames.contains(SCANS)) {
          pending++;
          const tx = db.transaction(SCANS, 'readonly');
          const idx = tx.objectStore(SCANS).index('by_time');
          idx.openCursor(null, 'prev').onsuccess = (ev) => {
            const cursor = ev.target.result;
            if (cursor && items.length < limit * 2) {
              const v = cursor.value;
              const ts = typeof v.timestamp === 'number' ? v.timestamp : Date.parse(v.timestamp || '') || Date.now();
              items.push({
                type: 'accessibility',
                ts,
                url: v.url || '',
                score: v.scoreGlobal,
              });
              cursor.continue();
            } else {
              pending--;
              done();
            }
          };
          tx.onerror = () => { pending--; done(); };
        }

        if (db.objectStoreNames.contains(DARK)) {
          pending++;
          const tx = db.transaction(DARK, 'readonly');
          const idx = tx.objectStore(DARK).index('by_time');
          idx.openCursor(null, 'prev').onsuccess = (ev) => {
            const cursor = ev.target.result;
            if (cursor && items.length < limit * 2) {
              const v = cursor.value;
              const ts = Date.parse(v.timestamp || '') || Date.now();
              const summary = v.summary || {};
              const count = summary.totalPatterns ?? (Array.isArray(v.findings) ? v.findings.filter(f => f.isDarkPattern).length : 0) ?? 0;
              items.push({
                type: 'dark',
                ts,
                url: v.pageUrl || v.url || '',
                patterns: count,
              });
              cursor.continue();
            } else {
              pending--;
              done();
            }
          };
          tx.onerror = () => { pending--; done(); };
        }

        if (pending === 0) resolve([]);
      } catch (_) {
        resolve([]);
      }
    };
    req.onerror = () => resolve([]);
  });
}

async function loadHistory() {
  const list = document.querySelector('#sp-history');
  if (!list) return;
  const entries = await getHistoryEntries(30);
  list.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const e of entries) {
    const li = document.createElement('li');
    li.className = 'history-item';
    const date = new Date(e.ts);
    const ts = isNaN(date.getTime()) ? '' : date.toLocaleString();
    const badgeClass = e.type === 'dark' ? 'history-badge history-badge-dark' : 'history-badge history-badge-accessibility';
    const title = e.type === 'dark' ? 'Dark Patterns' : 'Accessibility';
    const detail = e.type === 'dark'
      ? `Patterns: ${e.patterns ?? 0}`
      : `Score: ${e.score ?? '-'}`;
    li.innerHTML = `
      <div class="history-header">
        <span class="${badgeClass}">${title}</span>
        <span>${ts}</span>
      </div>
      <div class="small">${e.url || '-'}</div>
      <div class="small">${detail}</div>
    `;
    frag.appendChild(li);
  }
  list.appendChild(frag);
}



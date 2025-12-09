(async () => {
  const qs = (s) => document.querySelector(s);
  const qsa = (s) => Array.from(document.querySelectorAll(s));
  const setText = (sel, val) => { const el = qs(sel); if (el) el.textContent = String(val); };

  // Load last scan from IndexedDB (same schema as popup/service_worker)
  async function getLastScan() {
    return new Promise((resolve) => {
      const DB_NAME = 'eaa_auditor_db';
      const STORE = 'scans';
      const req = indexedDB.open(DB_NAME, 1);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(STORE, 'readonly');
        const idx = tx.objectStore(STORE).index('by_time');
        const items = [];
        idx.openCursor(null, 'prev').onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (cursor && items.length < 1000) { items.push(cursor.value); cursor.continue(); } else { resolve(items[0] || null); }
        };
        tx.onerror = () => resolve(null);
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

  async function applyData(data) {
    if (!data) return;
    setText('#m-global', data.scoreGlobal ?? '-');
    setText('#m-crit', data.counters?.Critique ?? 0);
    setText('#m-maj', data.counters?.Majeure ?? 0);
    setText('#m-moy', data.counters?.Moyenne ?? 0);
    setText('#m-min', data.counters?.Mineure ?? 0);
    setText('#m-partial', data.partial ? 'yes' : 'no');
    updateFilterCounters(data.findings || []);
    renderItems(data);

    // Exports
    const sendExport = async (format) => {
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'export', format, data });
        if (resp?.ok) {
          const a = document.createElement('a');
          a.href = resp.dataUrl;
          a.download = resp.filename || `eaa-wcag-audit.${format}`;
          document.body.appendChild(a); a.click(); a.remove();
        } else if (resp?.error) {
          alert('Export failed: ' + resp.error);
        }
      } catch (e) {
        alert('Export failed');
      }
    };
    qs('#sp-export-json')?.addEventListener('click', () => sendExport('json'));
    qs('#sp-export-csv')?.addEventListener('click', () => sendExport('csv'));
    qs('#sp-export-doc')?.addEventListener('click', () => sendExport('doc'));
  }

  function wireFilters(data) {
    qsa('.ff').forEach(el => el.addEventListener('change', () => renderItems(data)));
    qs('#search')?.addEventListener('input', () => renderItems(data));
    qs('#sort')?.addEventListener('change', () => renderItems(data));
    qs('#sp-refresh')?.addEventListener('click', async () => { const d = await getLastScan(); applyData(d); });
    // Reset panel: clear search and filters, re-render
    qs('#sp-reset')?.addEventListener('click', async () => {
      try {
        qsa('.ff:checked').forEach((el) => { el.checked = false; });
        const s = qs('#search'); if (s) s.value = '';
        const d = await getLastScan();
        await applyData(d);
      } catch (_) {}
    });
  }

  const last = await getLastScan();
  wireFilters(last || {});
  await applyData(last || {});
})();



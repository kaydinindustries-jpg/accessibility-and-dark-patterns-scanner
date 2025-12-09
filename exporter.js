// Offscreen report generator (DOC/CSV/JSON) 100% local

// Signal readiness as soon as the script loads
try { chrome.runtime.sendMessage({ type: "offscreen-ready" }); } catch (_) {}

function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleString();
}

function weightForImpact(frLabel) {
  if (frLabel === "Critique") return 4;
  if (frLabel === "Majeure") return 3;
  if (frLabel === "Moyenne") return 2;
  if (frLabel === "Mineure") return 1;
  return 0;
}

function buildReportHTML(data) {
  const wcagRefs = new Set();
  const enRefs = new Set();
  for (const f of data.findings || []) {
    (f.wcagRef || []).forEach(r => wcagRefs.add(r));
    (f.en301549Ref || []).forEach(r => enRefs.add(r));
  }

  const root = document.createElement("div");
  root.className = "report";
  const sampleList = (data.sample || [data.url]).filter(Boolean);
  const csumCandidate = data.contrast;
  const csum = (csumCandidate && typeof csumCandidate.total === 'number') ? csumCandidate : (data.contrast?.summary || { total: 0, fails: 0, needsManual: 0 });
  const needsReviewCount = (data.findings || []).filter(f => f.status === 'incomplete').length;

  // Build contrast summary directly from findings (authoritative)
  const contrastFromFindings = (() => {
    const all = (data.findings || []).filter(f => f.id === 'color-contrast' || f.id === 'color-contrast-custom');
    const total = all.length;
    const fails = all.filter(f => f.status === 'violation').length;
    const needsManual = all.filter(f => f.status === 'incomplete' || f.needsManualCheck).length;
    return { total, fails, needsManual };
  })();

  const contrastSummary = (contrastFromFindings.total || contrastFromFindings.fails || contrastFromFindings.needsManual)
    ? contrastFromFindings
    : csum;
  const details = [];
  const adviceItems = [];
  for (const f of (data.findings || [])) {
    const isAdviceLike = (f.advice === true) || (f.needsMapping === true);
    const needsReviewLine = f.needsManualCheck ? `<div>Needs manual review: yes${f.explanation ? ' — ' + f.explanation : ''}</div>` : '';
    const contrastInfoHTML = (() => {
      // color-contrast: only show ratio if provided by axe on same pair
      if (f.id === 'color-contrast') {
        const hasAxeRatio = f.contrastSource === 'axe' && (f.contrastRatio != null);
        const ratioText = hasAxeRatio ? `ratio=${f.contrastRatio}` : 'ratio unavailable';
        return `<div>Contrast: ${ratioText} (AA: 4.5:1 normal text, 3:1 large text & UI)</div>`;
      }
      const ratioText = (f.contrastRatio != null) ? `ratio=${f.contrastRatio}` : 'ratio unavailable';
      const fg = f.fgColor || '-';
      const bg = f.bgColor || '';
      const lt = f.isLargeText ? '(large text)' : '';
      const st = f.state || 'normal';
      return `<div>Contrast: ${ratioText} fg=${fg} bg=${bg} ${lt} state=${st} (AA: 4.5:1 normal text, 3:1 large text & UI)</div>`;
    })();
    const block = `
      <div class="sep">************</div>
      <div class="item">
        <div><strong>${f.id}</strong> <small>(${f.status || 'violation'}, ${f.impact}, ${f.principle || '-'})</small></div>
        <div>WCAG: ${(f.wcagRef || []).join(", ") || (f.needsMapping && !f.advice ? 'needs-mapping' : '-')}</div>
        <div>EN 301 549: ${(f.en301549Ref || []).join(", ") || '-'}</div>
        <div>Selectors: ${(f.selectors || []).join(" ") || "-"}</div>
        <div>Snippet: <code>${(f.snippet || "").replace(/</g,"&lt;").slice(0,600)}</code></div>
        ${contrastInfoHTML}
        <div>Focus visible: ${f.focusVisible == null ? '-' : (f.focusVisible ? 'yes' : 'no')}</div>
        ${needsReviewLine}
        <div>How to fix: ${(f.help || "-")}</div>
      </div>
    `;
    if (isAdviceLike) adviceItems.push({ f, block }); else details.push(block);
  }

  // Group advice by rule, show a counter and example
  const adviceGrouped = adviceItems.reduce((acc, { f }) => {
    const key = f.id || 'unknown';
    if (!acc[key]) acc[key] = { count: 0, first: f };
    acc[key].count += 1;
    return acc;
  }, {});

  const adviceHTML = Object.keys(adviceGrouped).length ? `
    <h2>Advice (non-blocking)</h2>
    <ul>
      ${Object.entries(adviceGrouped).map(([id, info]) => {
        const exSel = (info.first.selectors || []).join(' ');
        const exSnip = (info.first.snippet || '').replace(/\s+/g,' ').slice(0, 240);
        const needsMap = info.first.needsMapping && !info.first.advice ? '<em>(needs-mapping)</em>' : '';
        const help = info.first.help || 'axe-core non-blocking advice.';
        return `<li><strong>${id}</strong> ×${info.count} ${needsMap}<div class=\"small\">${help}</div>${exSel || exSnip ? `<div class=\"small\">Example: ${exSel ? exSel : ''}${exSel && exSnip ? ' — ' : ''}${exSnip ? `<code>${exSnip}</code>` : ''}</div>` : ''}</li>`;
      }).join('')}
    </ul>
  ` : '';

  // STRICT read from JSON.meta.sampleStats when present
  const sampleStats = (data.meta && data.meta.sampleStats != null) ? data.meta.sampleStats : null;
  const sampleStatsHTML = sampleStats ? `
    <div class=\"small\">Sample summary (overall scores):
      min=${sampleStats.min}, median=${sampleStats.median}, mean=${sampleStats.mean}, max=${sampleStats.max} (n=${sampleStats.count})
    </div>
  ` : '';

  root.innerHTML = `
    <div class="doc-watermark">ARDASIA Software</div>
    <div class="disclaimer-red">Technical pre-audit, not certification.</div>
    <h1>Accessibility information (EAA)</h1>
    <div class="small">Site: ${data.url}</div>
    <div class="small">Method: local automated analysis (axe-core), MV3</div>
    <div class="small">Perimeter: ${data.perimeter || 'Active page (CSP/iframes may limit analysis)'} </div>
    <div class="small">Sample: ${sampleList.length ? sampleList.map(u => `<span class="url">${u}</span>`).join(', ') : '-'}</div>
    <div class="small">Pages covered: ${sampleList.length}</div>
    <div class="small">Timestamp: ${formatDate(data.timestamp)}${data.sampleSavedAt ? ' (sampling set: ' + formatDate(data.sampleSavedAt) + ')' : ''}</div>
    ${sampleStatsHTML}

    <h2>Results & Scores</h2>
    <div class="grid">
      <div>Overall score: <strong>${data.scoreGlobal}</strong></div>
      <div>Perceivable: ${data.principleScores?.Perceivable ?? '-'}</div>
      <div>Operable: ${data.principleScores?.Operable ?? '-'}</div>
      <div>Understandable: ${data.principleScores?.Understandable ?? '-'}</div>
      <div>Robust: ${data.principleScores?.Robust ?? '-'}</div>
      <div>Counters: C:${data.counters?.Critique||0} / S:${data.counters?.Majeure||0} / M:${data.counters?.Moyenne||0} / m:${data.counters?.Mineure||0}</div>
      <div>Manual review needed (incomplete): ${needsReviewCount}</div>
    </div>

    ${adviceHTML}

    <div class="page-break"></div>

    <h2>Sample & Perimeter</h2>
    <div class="small">URLs: ${sampleList.length ? sampleList.map(u => `<div>${u}</div>`).join('') : '-'}</div>
    <div class="small">Constraints: CSP/iframes may limit analysis</div>

    <h2>Limits</h2>
    <div class="small">${data.partial ? `Partial scan (cross-origin iframes: ${data.crossOriginIframes}).` : 'Complete scan (within CSP limits).'}</div>
    <div class="small">Contrast: ${contrastSummary.fails} failure(s), ${contrastSummary.needsManual} need(s) manual check over ${contrastSummary.total} text elements.</div>
    <div class="small">AA thresholds: 4.5:1 for normal text, 3:1 for large text and UI components.</div>
    ${ (data.findings || []).some(f => f.id === 'meta-viewport' && (f.status === 'violation' || f.status === 'incomplete')) ? `<div class="small">Zoom: <strong>blocking zoom (user-scalable=no, maximum-scale&lt;2)</strong> fails <strong>1.4.4 Resize text</strong>.</div>` : '' }

    <div class="page-break"></div>

    <h2>Findings details</h2>
    <div id="items">${details.join('\n')}</div>

    <div class="page-break"></div>

    <h2>Appendix</h2>
    <div class="small">WCAG 2.2 references: ${(Array.from(wcagRefs).join(", ")) || "-"}</div>
    <div class="small">EN 301 549 v3.2.1 references: ${(Array.from(enRefs).join(", ")) || "-"}</div>
    <div class="small">Method: axe-core (local), custom contrast measurement, no network, MV3 Offscreen.</div>
  `;

  return root;
}

function buildDocHTMLDocument(data) {
  const root = buildReportHTML(data);
  const styles = `
    body { margin:0; padding:40px 32px 60px; background:#fff; color:#111; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; }
    h1 { margin: 0 0 10px; font-size: 20px; }
    h2 { margin: 18px 0 8px; font-size: 16px; }
    .small { color:#333; font-size:12px; line-height:1.4; }
    .grid { display:grid; grid-template-columns: repeat(3, 1fr); gap: 8px; font-size: 12px; }
    .item { border-top: 1px solid #eee; padding: 8px 0; font-size: 12px; }
    .sep { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color:#999; margin: 6px 0; }
    code { background:#f6f8fa; padding:2px 4px; border-radius:3px; font-size: 11px; }
    .page-break { page-break-before: always; }
    .disclaimer-red { background: #ffeaea; border: 1px solid #d32f2f; color:#8b0000; padding: 8px 10px; margin: 10px 0; font-weight: 600; }
    .doc-header { position: fixed; top: 0; left: 0; right: 0; height: 28px; background: #f7f7f7; color:#444; font-size: 12px; display:flex; align-items:center; justify-content: center; border-bottom:1px solid #e5e5e5; }
    .doc-footer { position: fixed; bottom: 0; left: 0; right: 0; height: 28px; background: #f7f7f7; color:#444; font-size: 11px; display:flex; align-items:center; justify-content: center; border-top:1px solid #e5e5e5; }
    .doc-watermark { position: fixed; top: 40%; left: 10%; right: 10%; text-align: center; font-size: 56px; color: #b30000; opacity: 0.08; transform: rotate(-28deg); pointer-events: none; user-select: none; z-index: 0; }
    .report { position: relative; z-index: 1; }
    .url { word-break: break-all; }
  `;
  const header = `<div class="doc-header">ARDASIA Software — Accessibility pre-audit</div>`;
  const footer = `<div class="doc-footer">ARDASIA Software • ${formatDate(data.timestamp)} • ${data.url}</div>`;
  const html = `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>EAA Audit</title>
        <style>${styles}</style>
      </head>
      <body>${header}${footer}${root.outerHTML}</body>
    </html>
  `;
  return html;
}

// Build meta object for JSON/DOC output
function buildMeta(data) {
  const sample = data.sample || [data.url].filter(Boolean);
  const sampleStats = (data.meta && data.meta.sampleStats != null)
    ? data.meta.sampleStats
    : (data.sampleStats != null ? data.sampleStats : null);
  return {
    version: '1.0',
    tool: 'ARDASIA Software',
    timestamp: data.timestamp,
    sample,
    perimeter: data.perimeter || 'Active page (CSP/iframes may limit analysis)',
    partialScan: !!data.partial,
    sampleSavedAt: data.sampleSavedAt || null,
    sampleStats
  };
}

async function exportDOC(data) {
  console.info("[offscreen] exportDOC: start");
  try { chrome.runtime.sendMessage({ type: "offscreen-log", stage: "doc:start" }); } catch (_) {}
  const meta = data.meta ? data.meta : buildMeta(data);
  const html = buildDocHTMLDocument({ ...data, meta });
  // Prefer a data: URL to avoid cross-context blob: URL issues with downloads API
  const base64 = btoa(unescape(encodeURIComponent(html)));
  const url = `data:application/msword;charset=utf-8;base64,${base64}`;
  try { chrome.runtime.sendMessage({ type: "offscreen-log", stage: "doc:complete" }); } catch (_) {}
  return { dataUrl: url, filename: "eaa-wcag-audit.doc" };
}

function csvQuote(v){ return '"' + String(v).replace(/"/g, '""') + '"'; }

function exportCSV(data) {
  const headers = [
    'timestamp','page_url','principle','wcag_sc','en301549','impact','advice','weight','count','selector','snippet_trunc','fg_color','bg_color','contrast_ratio','state','needsManualCheck','partialScan','watermark'
  ];
  const disclaimerRow = ["DISCLAIMER=Technical pre-audit, not certification."];
  while (disclaimerRow.length < headers.length) disclaimerRow.push("");
  const rows = [];
  for (const f of (data.findings || [])) {
    const snippet = (f.snippet || '').replace(/\s+/g,' ').slice(0, 1000) + (f.needsManualCheck && f.explanation ? ` | NOTE: ${f.explanation}` : '');
    const weight = (f.advice === true) ? 0 : weightForImpact(f.impact || '');
    const row = [
      data.timestamp,
      data.url,
      f.principle || '',
      (f.wcagRef || []).join(' | '),
      (f.en301549Ref || []).join(' | '),
      f.impact || '',
      f.advice === true ? 'true' : 'false',
      weight,
      1,
      (f.selectors || []).join(' '),
      snippet,
      f.fgColor || '',
      f.bgColor || '',
      f.contrastRatio ?? '',
      f.state || 'normal',
      f.needsManualCheck ? 'true' : 'false',
      data.partial ? 'true' : 'false',
      'ARDASIA Software'
    ];
    rows.push(row);
  }
  const csvBody = [headers.map(csvQuote).join(','), disclaimerRow.map(csvQuote).join(','), ...rows.map(r => r.map(csvQuote).join(','))].join('\n');
  const withBOM = '\uFEFF' + csvBody; // UTF-8 BOM
  // Use percent-encoded data URL (keeps BOM)
  const url = 'data:text/csv;charset=utf-8,' + encodeURIComponent(withBOM);
  return { dataUrl: url, filename: 'eaa-wcag-audit.csv' };
}

function exportJSON(data) {
  const obj = {
    meta: buildMeta(data),
    scores: {
      global: data.scoreGlobal,
      perceivable: data.principleScores?.Perceivable,
      operable: data.principleScores?.Operable,
      understandable: data.principleScores?.Understandable,
      robust: data.principleScores?.Robust
    },
    findings: (data.findings || []).filter(x => x.advice !== true).map(f => ({
      timestamp: data.timestamp,
      page_url: data.url,
      principle: f.principle || '',
      wcag_sc: f.wcagRef || [],
      en301549: f.en301549Ref || [],
      impact: f.impact || '',
      weight: weightForImpact(f.impact || ''),
      count: 1,
      selector: (f.selectors || []).join(' '),
      snippet_trunc: (f.snippet || '').replace(/\s+/g,' ').slice(0, 1500),
      fg_color: f.fgColor || '',
      bg_color: f.bgColor || '',
      contrast_ratio: f.contrastRatio ?? null,
      state: f.state || 'normal',
      needsManualCheck: !!f.needsManualCheck,
      explanation: f.explanation || null,
      partialScan: !!data.partial
    })),
    watermark: 'ARDASIA Software'
  };
  const jsonStr = JSON.stringify(obj, null, 2);
  const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(jsonStr);
  return { dataUrl: url, filename: 'eaa-wcag-audit.json' };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "offscreen-ping") {
    console.info("[offscreen] ping received");
    sendResponse({ ok: true });
    return false; // synchronous response
  }
  (async () => {
    if (msg?.type === "offscreen-export") {
      console.info("[offscreen] export request: format=", msg.format);
      try {
        if (msg.format === "doc") {
          const res = await exportDOC(msg.data);
          sendResponse({ ok: true, ...res });
        } else if (msg.format === 'csv') {
          const res = exportCSV(msg.data);
          sendResponse({ ok: true, ...res });
        } else if (msg.format === 'json') {
          const res = exportJSON(msg.data);
          sendResponse({ ok: true, ...res });
        } else throw new Error("Unsupported format.");
      } catch (e) {
        console.error("[offscreen] export error:", e);
        try { chrome.runtime.sendMessage({ type: "offscreen-log", stage: "error", error: String(e?.message || e) }); } catch (_) {}
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
      return;
    }
  })();
  return true;
});
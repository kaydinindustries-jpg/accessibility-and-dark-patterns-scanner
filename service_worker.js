// service_worker.js (MV3 module)

// Chargement du mapping statique au démarrage
let MAPPING = null;
(async () => {
  try {
    const res = await fetch(chrome.runtime.getURL("mapping.json"));
    MAPPING = await res.json();
  } catch (e) {
    console.error("Mapping not loaded:", e);
    MAPPING = { axe_to_wcag: {} };
  }
})();

// Gestion Offscreen Document
async function ensureOffscreen() {
  try {
    if (chrome.offscreen?.hasDocument) {
      const has = await chrome.offscreen.hasDocument();
      if (has) return true;
    }
  } catch (_) {}
  try {
    console.info('[sw] creating offscreen');
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL("offscreen.html"),
      reasons: ["DOM_PARSER", "BLOBS"],
      justification: "Génération de rapports DOC/CSV/JSON et parsing DOM sans réseau."
    });
    return true;
  } catch (e) {
    console.warn("[sw] offscreen creation failed:", e);
    return false;
  }
}

async function ensureOffscreenReady(timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const resp = await chrome.runtime.sendMessage({ type: "offscreen-ping" });
      if (resp?.ok) return true;
    } catch (e) {
      // ignore and retry
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("Offscreen non prêt");
}

// Fermer l'offscreen s'il existe (utile pour recharger exporter.js après mise à jour)
async function closeOffscreenIfAny() {
  try {
    if (chrome.offscreen?.hasDocument) {
      const has = await chrome.offscreen.hasDocument();
      if (has && chrome.offscreen?.closeDocument) {
        await chrome.offscreen.closeDocument();
      }
    }
  } catch (_) {}
}

async function ensureOffscreenAvailable() {
  // 1) Try to reuse existing offscreen document if any
  try {
    const ok = await chrome.runtime.sendMessage({ type: "offscreen-ping" });
    if (ok?.ok) return true;
  } catch (_) {}
  // 2) Otherwise, create and wait
  await ensureOffscreen();
  await ensureOffscreenReady();
  return true;
}

function sendToOffscreenWithTimeout(message, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return; done = true;
      reject(new Error('Timeout offscreen'));
    }, timeoutMs);
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        if (done) return;
        clearTimeout(t);
        if (chrome.runtime.lastError) {
          console.error('[sw] offscreen message error:', chrome.runtime.lastError);
          done = true;
          reject(chrome.runtime.lastError);
          return;
        }
        done = true;
        resolve(resp);
      });
    } catch (e) {
      clearTimeout(t);
      reject(e);
    }
  });
}

// IndexedDB (via storage.js)
import { saveScan, getLastScanForUrl, saveDarkScan, getLastDarkScanForUrl } from "./storage.js";
import { loadConfig } from "./config.js";

// Utilitaires
function mapPrincipleFromTags(tags = []) {
  // Robust si ARIA/name-role-value ou parsing
  if (tags.includes("cat.name-role-value") || tags.includes("cat.parsing")) return "Robust";
  if (tags.includes("cat.keyboard")) return "Operable";
  if (tags.includes("cat.color") || tags.includes("cat.text-alternatives") || tags.includes("cat.time-and-media")) return "Perceivable";
  if (tags.includes("cat.forms") || tags.includes("cat.language") || tags.includes("cat.structure")) return "Understandable";
  return "Robust";
}

const isRestrictedUrl = (tabUrl) => {
  return !tabUrl ||
    /^chrome:\/\//i.test(tabUrl) ||
    /^chrome-extension:\/\//i.test(tabUrl) ||
    /^edge:\/\//i.test(tabUrl) ||
    /^about:/i.test(tabUrl) ||
    /chromewebstore\.google\.com/i.test(tabUrl);
};

function normalizeImpact(impact) {
  if (impact === "critical") return "Critique";
  if (impact === "serious") return "Majeure";
  if (impact === "moderate") return "Moyenne";
  if (impact === "minor") return "Mineure";
  return "Unclassified";
}

function weightForImpact(frLabel) {
  // Weights: critical=4, serious=3, moderate=2, minor=1
  if (frLabel === "Critique") return 4;
  if (frLabel === "Majeure") return 3;
  if (frLabel === "Moyenne") return 2;
  if (frLabel === "Mineure") return 1;
  return 0;
}

function computeScores(findings) {
  // Exclure du scoring: needs-mapping et advice:true
  const scored = findings.filter(f => f.status === 'violation' || f.status === 'incomplete').filter(f => !(f.needsMapping || f.advice === true));
  const violations = scored.filter(f => f.status === 'violation');
  const incompletes = scored.filter(f => f.status === 'incomplete');
  const principles = ["Perceivable", "Operable", "Understandable", "Robust"];
  const W = { Perceivable: 0, Operable: 0, Understandable: 0, Robust: 0 };

  for (const f of violations) {
    W[f.principle || "Robust"] += weightForImpact(f.impact);
  }
  // Penalty +0.5 per incomplete, capped to +20 per principle
  const incByPrinciple = { Perceivable: 0, Operable: 0, Understandable: 0, Robust: 0 };
  for (const f of incompletes) {
    const p = f.principle || 'Robust';
    incByPrinciple[p] += 0.5;
  }
  for (const p of principles) {
    W[p] += Math.min(20, incByPrinciple[p]);
  }

  const scoreP = (Wp) => 100 - Math.round(100 * (Wp) / (Wp + 20));
  const principleScores = {};
  for (const p of principles) principleScores[p] = scoreP(W[p]);

  // Cap Perceivable if AA contrast fails (axe or custom)
  const hasAAContrastFail = violations.some(v => (v.principle === 'Perceivable') && Array.isArray(v.wcagRef) && v.wcagRef.some(sc => /^1\.4\.(3|11)(\b|$)/.test(sc)));
  if (hasAAContrastFail && principleScores.Perceivable > 89) principleScores.Perceivable = 89;

  const scoreGlobal = Math.round((principles.reduce((a, p) => a + principleScores[p], 0)) / principles.length);
  return { scoreGlobal, principleScores, weights: W };
}

async function injectDarkModule(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["darkPatternsContent.js"],
    world: "ISOLATED"
  });
}

async function collectDarkCandidatesOnTab(tabId, cfg) {
  await injectDarkModule(tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: (opts) => {
      const mod = globalThis.ardasiaDarkPatterns;
      if (!mod || typeof mod.collectDarkPatternCandidates !== "function") {
        throw new Error("Dark pattern collector unavailable");
      }
      return mod.collectDarkPatternCandidates(document, opts);
    },
    args: [{
      maxCandidatesPerPage: cfg.maxCandidatesPerPage,
      maxCharsPerSnippet: cfg.maxCharsPerSnippet,
      pageUrl: cfg.pageUrl || null,
      viewport: cfg.viewport || "desktop",
      scanId: cfg.scanId || undefined
    }]
  });
  return result;
}

function mockAnalyzeDarkPatterns(payload) {
  const findings = (payload.candidates || []).map((c, idx) => {
    const hint = (c.meta && c.meta.patternHint) || "none";
    const patternType = hint;
    const riskLevel = ["low", "medium", "high"][idx % 3];
    return {
      candidateId: c.id,
      isDarkPattern: hint !== "none",
      patternType,
      riskLevel,
      explanation: `Mock classification for ${c.role || "element"} (${patternType}).`,
      suggestedFix: "Review wording, visibility, and provide a clear opt-out.",
      legalRefs: ["DSA Art. 25"],
      confidence: 0.55 + (idx % 3) * 0.1
    };
  });
  const summary = {
    totalCandidates: payload.candidates?.length || 0,
    totalPatterns: findings.filter(f => f.isDarkPattern).length,
    countsByPatternType: findings.reduce((acc, f) => {
      acc[f.patternType] = (acc[f.patternType] || 0) + 1;
      return acc;
    }, { cookie_nudge: 0, roach_motel: 0, preselected_addon: 0, hidden_information: 0, misleading_label: 0, ai_manipulation: 0, none: 0 }),
    countsByRisk: findings.reduce((acc, f) => {
      acc[f.riskLevel] = (acc[f.riskLevel] || 0) + 1;
      return acc;
    }, { low: 0, medium: 0, high: 0 })
  };
  return {
    scanId: payload.scanId,
    findings,
    summary,
    modelVersion: "mock-v1",
    processingMs: 5
  };
}

async function analyzeDarkPatterns(payload, cfg) {
  const backend = (cfg.backendUrl || "").trim();
  const shouldMock =
    cfg.useMockBackend ||
    !backend ||
    /example\.com/i.test(backend);

  if (shouldMock) {
    return mockAnalyzeDarkPatterns(payload);
  }

  const url = backend.replace(/\/$/, "") + "/api/analyze-ui";
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), cfg.requestTimeoutMs || 10000);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return data;
  } catch (e) {
    // Fallback mock si le backend est indisponible
    if (cfg.useMockBackend || !backend) {
      console.warn("[sw] analyzeDarkPatterns falling back to mock backend:", e);
      return mockAnalyzeDarkPatterns(payload);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function highlightDarkCandidate(tabId, selector) {
  await injectDarkModule(tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: (sel) => {
      const mod = globalThis.ardasiaDarkPatterns;
      if (!mod || typeof mod.highlightCandidate !== "function") {
        return { ok: false, error: "Highlighter unavailable" };
      }
      return mod.highlightCandidate(sel, { durationMs: 3500 });
    },
    args: [selector]
  });
  return result;
}

async function scanActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("Aucun onglet actif.");

  // Bloquer les pages internes du navigateur (non scannables)
  const tabUrl = String(tab.url || "");
  const isRestricted = !tabUrl ||
    /^chrome:\/\//i.test(tabUrl) ||
    /^chrome-extension:\/\//i.test(tabUrl) ||
    /^edge:\/\//i.test(tabUrl) ||
    /^about:/i.test(tabUrl) ||
    /chromewebstore\.google\.com/i.test(tabUrl);
  if (isRestricted) {
    return { ok: false, error: "Page non scannable (onglet interne du navigateur). Ouvrez la page à auditer puis cliquez sur Scan." };
  }

  // 1) Injecter axe-core (isolated world)
  let injectOk = false; let lastErr = null;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["libs/axe.min.js"],
      world: "ISOLATED"
    });
    injectOk = true;
  } catch (e1) {
    lastErr = e1;
    // Fallback path if libs/axe.min.js is not found
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["libs/dequelabs-axe-core-f49c1c4/axe.min.js"],
        world: "ISOLATED"
      });
      injectOk = true;
    } catch (e2) { lastErr = e2 || e1; }
  }
  if (!injectOk) {
    const msg = (lastErr && lastErr.message) ? lastErr.message : "inconnue";
    return { ok: false, error: `axe-core injection failed: ${msg}` };
  }

  // 2) Run axe scan + custom contrast audit
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "ISOLATED",
    func: () => {
      const meta = { partial: false, crossOriginIframes: 0 };
      try {
        const iframes = Array.from(document.querySelectorAll("iframe"));
        for (const f of iframes) {
          try { void f.contentDocument; } catch { meta.crossOriginIframes += 1; }
        }
        if (meta.crossOriginIframes > 0) meta.partial = true;
      } catch {}

      if (!window.axe || typeof window.axe.run !== 'function') {
        return { error: 'axe-core not present. Please provide libs/axe.min.js', meta };
      }

      function parseRgb(str) {
        const m = String(str || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/);
        if (!m) return { r: 0, g: 0, b: 0, a: 0 };
        return { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4] };
      }
      function composite(dst, src) {
        // src over dst
        const a = src.a + dst.a * (1 - src.a);
        if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
        const r = Math.round((src.r * src.a + dst.r * dst.a * (1 - src.a)) / a);
        const g = Math.round((src.g * src.a + dst.g * dst.a * (1 - src.a)) / a);
        const b = Math.round((src.b * src.a + dst.b * dst.a * (1 - src.a)) / a);
        return { r, g, b, a };
      }
      function rgbToL(rgb) {
        const srgb = [rgb.r, rgb.g, rgb.b].map(v => v / 255).map(v => v <= 0.03928 ? v/12.92 : Math.pow((v + 0.055)/1.055, 2.4));
        return 0.2126*srgb[0] + 0.7152*srgb[1] + 0.0722*srgb[2];
      }
      function contrastRatio(fg, bg) {
        const L1 = rgbToL(fg);
        const L2 = rgbToL(bg);
        const lighter = Math.max(L1, L2), darker = Math.min(L1, L2);
        return (lighter + 0.05) / (darker + 0.05);
      }
      function getEffectiveBackground(el) {
        let needsManualCheck = false;
        let acc = { r: 0, g: 0, b: 0, a: 0 };
        let cur = el;
        while (cur) {
          const cs = getComputedStyle(cur);
          if (cs.backgroundImage && cs.backgroundImage !== 'none') { needsManualCheck = true; break; }
          if (['VIDEO','CANVAS'].includes(cur.tagName)) { needsManualCheck = true; break; }
          const bg = parseRgb(cs.backgroundColor);
        // compose from closest ancestor to root: existing composite (acc) is the top, new bg is below
          acc = composite(bg, acc);
          if (acc.a >= 0.99) break;
          cur = cur.parentElement;
        }
        if (acc.a < 0.99) acc = composite({ r: 255, g: 255, b: 255, a: 1 }, acc);
        return { color: acc, needsManualCheck };
      }
      function isLargeText(cs) {
        const px = parseFloat(cs.fontSize) || 0;
        const bold = (parseInt(cs.fontWeight, 10) || 400) >= 700;
        return px >= 24 || (bold && px >= 18.66);
      }
      function visibleText(el) {
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') return false;
        // Limiter aux nœuds avec childTextNodes non vides
        let hasDirectText = false;
        for (const n of el.childNodes) {
          if (n.nodeType === Node.TEXT_NODE && String(n.textContent || '').trim().length > 0) { hasDirectText = true; break; }
        }
        if (!hasDirectText) return false;
        return true;
      }
      function hasFocusIndicator(el) {
        const beforeOutline = getComputedStyle(el).outlineStyle;
        const beforeShadow = getComputedStyle(el).boxShadow;
        try { el.focus({ preventScroll: true }); } catch (_) {}
        const cs = getComputedStyle(el);
        const afterOutline = cs.outlineStyle;
        const afterShadow = cs.boxShadow;
        return (afterOutline && afterOutline !== 'none') || (afterShadow && afterShadow !== 'none');
      }
      function toHex(c){ const v = Math.max(0, Math.min(255, Math.round(c))); return v.toString(16).padStart(2,'0'); }
      function rgbObjToHex(rgb){ return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`; }

      function measureState(el, state) {
        let cleanup = () => {};
        try {
          if (state === 'hover') {
            el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            cleanup = () => { try { el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); } catch(_){} };
          } else if (state === 'focus') {
            try { el.focus({ preventScroll: true }); } catch(_){}
            cleanup = () => { try { el.blur(); } catch(_){} };
          }
        } catch(_){}
        const cs = getComputedStyle(el);
        const fg = parseRgb(cs.color);
        const bgEff = getEffectiveBackground(el);
        const large = isLargeText(cs);
        const ratio = contrastRatio(fg, bgEff.color);
        const threshold = large ? 3 : 4.5;
        const pass = ratio >= threshold;
        cleanup();
        return {
          ratio: Number(ratio.toFixed(2)),
          large,
          needsManualCheck: bgEff.needsManualCheck,
          pass,
          threshold,
          fgHex: rgbObjToHex(fg),
          bgHex: rgbObjToHex(bgEff.color),
          state
        };
      }

      return new Promise((resolve) => {
        const runOptions = { resultTypes: ["violations", "incomplete"], reporter: "v2", preload: false };
        window.axe
          .run(document, runOptions)
          .then(async (axeRes) => {
            // Custom contrast audit for normal|hover|focus, keep worst case
            const checks = [];
            const all = Array.from(document.querySelectorAll('*'));
            const seen = new Set();
            const maxChecks = 3000;

            const selFrom = (el) => el.id ? `#${el.id}` : (el.className ? `${el.tagName.toLowerCase()}.${String(el.className).split(' ').join('.')}` : el.tagName.toLowerCase());
            const idleWait = () => new Promise(r => {
              if (typeof requestIdleCallback === 'function') {
                requestIdleCallback(() => r(), { timeout: 200 });
              } else {
                setTimeout(() => r(), 16);
              }
            });

            let sliceStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            for (const el of all) {
              if (checks.length >= maxChecks) break;
              if (!visibleText(el)) continue;
              const selector = selFrom(el);
              if (seen.has(selector)) continue; // dedupe by selector
              seen.add(selector);

              let focusIndicatorPresent = null;
              try {
                if (el.tabIndex >= 0 || ['A','BUTTON','INPUT','SELECT','TEXTAREA'].includes(el.tagName)) {
                  focusIndicatorPresent = hasFocusIndicator(el);
                }
              } catch (_) {}

              const states = [ 'normal', 'hover', 'focus' ];
              let worst = null;
              for (const st of states) {
                const m = measureState(el, st);
                if (!worst || m.ratio < worst.ratio) worst = m;
              }

              checks.push({
                selector,
                ratio: worst.ratio,
                large: worst.large,
                needsManualCheck: worst.needsManualCheck,
                pass: worst.pass,
                threshold: worst.threshold,
                focusIndicatorPresent,
                fgHex: worst.fgHex,
                bgHex: worst.bgHex,
                state: worst.state
              });

              const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
              if (now - sliceStart > 1500) { // time-budget par tranche
                await idleWait();
                sliceStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
              }
            }
            resolve({ axeRes, meta, contrast: { checks } });
          })
          .catch((e) => {
            let msg = (e && e.message) ? e.message : String(e);
            if (/\[object ProgressEvent\]/.test(msg) || /preload/i.test(msg)) {
              msg = 'Preloading of assets failed (likely CORS/timeout). The scan was interrupted by axe-core. Preloading is now disabled to avoid this.';
            }
            resolve({ error: msg, meta });
          });
      });
    }
  });

  if (result?.error) {
    return { ok: false, error: result.error, meta: result.meta };
  }

  const { axeRes, meta, contrast } = result;
  const findings = [];
  let needsMapping = false;
  const unknownRules = new Set();

  // 3) Construire la liste des constats (violations + incomplete), mais le scoring n'utilisera que les violations
  const pushItems = (bucket, status) => {
    for (const item of (bucket || [])) {
      const ruleId = item.id;
      const map = (MAPPING?.axe_to_wcag || {})[ruleId] || null;
      const wcagRefRaw = (map?.wcag || []).slice();
      const isAdvice = !!(map && map.advice === true);
      const wcagMissing = !map || (wcagRefRaw.length === 0 && !isAdvice);
      const wcagRef = wcagMissing ? ["needs-mapping"] : wcagRefRaw;
      const enRef = (map?.en301549 || map?.en || []).slice();
      const tags = Array.from(new Set([...(item.tags || []), ...(map?.tags || [])]));
      let principle = map?.principle || mapPrincipleFromTags(tags);
      if (wcagRefRaw.some(sc => /^1\.4\./.test(sc))) principle = 'Perceivable';
      if (wcagMissing) {
        needsMapping = true;
        unknownRules.add(ruleId);
      }

      for (const node of item.nodes || []) {
        // Enrich help message for specific rules (shown in DOC/JSON)
        let help = item.help || "";
        if (ruleId === 'meta-viewport') {
          help += " — ACT: user-scalable=no or maximum-scale<2 = failure (1.4.4 Resize text).";
        }
        if (ruleId === 'meta-viewport-large') {
          help += " — Recommendation: allow significant zoom (e.g. ≥ 200%).";
        }
        const f = {
          id: ruleId,
          wcagRef,
          en301549Ref: enRef,
          impact: normalizeImpact(node.impact || item.impact),
          selectors: node.target || [],
          snippet: node.html || "",
          help,
          tags,
          principle,
          status,
          needsManualCheck: status === 'incomplete',
          explanation: status === 'incomplete' ? 'Besoin de vérification manuelle (axe: incomplete).' : '',
          advice: !!(map && map.advice === true),
          needsMapping: !!wcagMissing
        };
        // If axe provides a reliable contrast ratio, capture it from checks[].data
        if (ruleId === 'color-contrast') {
          const allChecks = [ ...(node.any || []), ...(node.all || []) ];
          const withRatio = allChecks.find(c => c && c.data && typeof c.data.contrastRatio === 'number');
          if (withRatio) {
            f.contrastRatio = withRatio.data.contrastRatio;
            if (withRatio.data.fgColor) f.fgColor = withRatio.data.fgColor;
            if (withRatio.data.bgColor) f.bgColor = withRatio.data.bgColor;
            f.contrastSource = 'axe';
          }
        }
        findings.push(f);
    } // fin boucle nodes
    } // fin boucle items
  };

  pushItems(axeRes?.violations, 'violation');
  pushItems(axeRes?.incomplete, 'incomplete');

  // Contrast index by selector
  const cks = contrast?.checks || [];
  const bySel = new Map();
  for (const c of cks) { if (c.selector) bySel.set(c.selector, c); }
  const pickContrastFor = (selArr = []) => {
    for (const s of selArr) {
      // Chercher match exact ou partiel
      if (bySel.has(s)) return bySel.get(s);
      for (const [k, v] of bySel.entries()) { if (s.includes(k)) return v; }
    }
    return null;
  };
  // Enrichir findings avec contraste/couleurs/focus/state
  for (const f of findings) {
    const ck = pickContrastFor(f.selectors || []);
    if (ck) {
      if (f.contrastRatio == null) { f.contrastRatio = ck.ratio; if (!f.contrastSource) f.contrastSource = 'custom'; }
      if (!f.fgColor) f.fgColor = ck.fgHex;
      if (!f.bgColor) f.bgColor = ck.bgHex;
      if (f.isLargeText == null) f.isLargeText = !!ck.large;
      if (!f.state) f.state = ck.state || 'normal';
      f.needsManualCheck = f.needsManualCheck || !!ck.needsManualCheck;
      if (f.focusVisible == null) f.focusVisible = ck.focusIndicatorPresent == null ? null : !!ck.focusIndicatorPresent;
    } else {
      if (!f.state) f.state = 'normal';
      if (f.focusVisible == null) f.focusVisible = null;
    }
  }
  // Synthetic finding if custom contrast failures are detected
  {
    const failsCount = (contrast?.checks || []).filter(c => !c.needsManualCheck && !c.pass).length;
    if (failsCount > 0) {
      findings.push({
        id: 'color-contrast-custom',
        wcagRef: ['1.4.3', '1.4.11'],
        en301549Ref: ['9.1.4.3', '9.1.4.11'],
        impact: 'Majeure',
        selectors: [],
        snippet: '',
        help: 'Custom contrast measurement (normal/hover/focus).',
        tags: ['cat.color'],
        principle: 'Perceivable',
        status: 'violation',
        needsManualCheck: false,
        explanation: 'At least one AA contrast failure detected by the custom measurement.'
      });
    }
  }

  const { scoreGlobal, principleScores } = computeScores(findings);

  const counters = { Critique: 0, Majeure: 0, Moyenne: 0, Mineure: 0, "Unclassified": 0 };
  for (const f of findings) if (f.status === 'violation' && !(f.needsMapping || f.advice === true)) counters[f.impact] = (counters[f.impact] || 0) + 1;

  const last = await getLastScanForUrl(tab.url || "");
  const serializeKey = (f) => `${f.id}|${(f.selectors || []).join(",")}`;
  const prevSet = new Set((last?.findings || []).map(serializeKey));
  const currSet = new Set(findings.map(serializeKey));
  const added = findings.filter((f) => !prevSet.has(serializeKey(f))).length;
  const removed = (last?.findings || []).filter((f) => !currSet.has(serializeKey(f))).length;

  // Contrast summary
  const contrastSummary = (() => {
    const checks = contrast?.checks || [];
    const needsManual = checks.filter(c => c.needsManualCheck).length;
    const fails = checks.filter(c => !c.needsManualCheck && !c.pass).length;
    const total = checks.length;
    return { total, fails, needsManual };
  })();

  // WCAG-EM sampling: load metadata from chrome.storage.local (optional)
  let sampleList = [tab.url || ""];
  let perimeter = "Page active (CSP/iframes peuvent limiter l’analyse)";
  let sampleSavedAt = null;
  try {
    const stored = await chrome.storage.local.get(['meta_sample', 'meta_perimeter', 'meta_sample_saved_at']);
    const arr = Array.isArray(stored.meta_sample) ? stored.meta_sample.filter(u => typeof u === 'string' && u.trim()) : [];
    if (arr.length) sampleList = arr.slice(0, 50);
    if (typeof stored.meta_perimeter === 'string' && stored.meta_perimeter.trim()) perimeter = stored.meta_perimeter.trim();
    if (typeof stored.meta_sample_saved_at === 'number') sampleSavedAt = stored.meta_sample_saved_at;
  } catch (_) {}

  // Compute sample summary via IndexedDB (latest scans per URL)
  let sampleStats = null;
  try {
    const scores = [];
    const seenUrls = new Set();
    for (const u of sampleList) {
      const url = String(u || '').trim();
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      const s = await getLastScanForUrl(url);
      if (s && typeof s.scoreGlobal === 'number') scores.push(s.scoreGlobal);
    }
    // Include current score if active URL has not yet been persisted
    if ((tab.url || '') && !scores.length) scores.push(scoreGlobal);
    if (scores.length >= 1) {
      const sorted = scores.slice().sort((a,b) => a - b);
      const min = sorted[0];
      const max = sorted[sorted.length - 1];
      const median = sorted.length % 2 ? sorted[(sorted.length - 1)/2] : Math.round((sorted[sorted.length/2 - 1] + sorted[sorted.length/2]) / 2);
      const mean = Math.round(sorted.reduce((a,b) => a + b, 0) / sorted.length);
      sampleStats = { count: sorted.length, min, max, median, mean };
    }
  } catch(_) {}

  const payload = {
    timestamp: Date.now(),
    url: tab.url,
    perimeter: perimeter,
    sample: sampleList,
    sampleSavedAt,
    sampleStats,
    partial: !!(meta && meta.partial),
    crossOriginIframes: (meta && typeof meta.crossOriginIframes === 'number') ? meta.crossOriginIframes : 0,
    findings,
    counters,
    scoreGlobal,
    principleScores,
    contrast: contrastSummary,
    needsMapping: needsMapping && Array.from(unknownRules).some(r => !((MAPPING.axe_to_wcag[r]||{}).advice === true)),
    unknownRules: Array.from(unknownRules).filter(r => !((MAPPING.axe_to_wcag[r]||{}).advice === true))
  };

  await saveScan(payload);

  return { ok: true, ...payload };
}

  // Incoming messages from popup / side panel
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Synchronous branches: respond immediately and DO NOT return true
  if (msg?.type === "offscreen-ready") {
    console.info("[sw] offscreen signaled ready");
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "offscreen-log") {
    // Avoid loops: if already relayed by the SW, ignore
    if (msg.from === 'sw') { sendResponse({ ok: true }); return false; }
    console.info("[sw] offscreen:", msg.stage || "log", msg);
    try {
      chrome.runtime.sendMessage({ type: 'offscreen-log', stage: msg.stage, error: msg.error, from: 'sw' }, () => { const _ = chrome.runtime.lastError; });
    } catch (_) {}
    sendResponse({ ok: true });
    return false;
  }

  // Branches ASYNCHRONES: on retourne true car on répondra plus tard
  if (msg?.type === "scan") {
    (async () => {
      try {
        const res = await scanActiveTab();
        sendResponse(res);
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }

  if (msg?.type === "dark-scan") {
    (async () => {
      try {
        const cfg = await loadConfig();
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error("Aucun onglet actif.");
        if (isRestrictedUrl(String(tab.url || ""))) {
          sendResponse({ ok: false, error: "Page non scannable (onglet interne du navigateur)." });
          return;
        }
        const collectPayload = await collectDarkCandidatesOnTab(tab.id, {
          ...cfg,
          pageUrl: tab.url,
          viewport: msg?.viewport || "desktop",
          scanId: msg?.scanId
        });
        if (!collectPayload?.candidates?.length) {
          sendResponse({ ok: true, stage: "collect", data: { ...collectPayload, findings: [], summary: { totalCandidates: 0, totalPatterns: 0, countsByPatternType: {}, countsByRisk: {} } } });
          return;
        }
        const analysis = await analyzeDarkPatterns(collectPayload, cfg);
        const combined = {
          ...analysis,
          scanId: analysis?.scanId || collectPayload.scanId,
          pageUrl: collectPayload.pageUrl,
          timestamp: collectPayload.timestamp,
          candidates: collectPayload.candidates
        };
        await saveDarkScan(combined);
        sendResponse({ ok: true, data: combined });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }

  if (msg?.type === "dark-last-scan") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.url) throw new Error("Aucune URL active");
        const last = await getLastDarkScanForUrl(tab.url);
        sendResponse({ ok: true, data: last });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }

  if (msg?.type === "dark-highlight" && msg?.selector) {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error("Aucun onglet actif");
        const res = await highlightDarkCandidate(tab.id, msg.selector);
        sendResponse(res);
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }

  if (msg?.type === "export") {
    (async () => {
      const { format, data } = msg;
      // Tous les formats passent par offscreen pour respecter MV3
      if (format === "json" || format === "csv" || format === "doc") {
        try {
          await ensureOffscreenAvailable();
          console.info('[sw] requesting offscreen export:', format);
          let resp = await sendToOffscreenWithTimeout({ type: "offscreen-export", format, data }, 600000);
          if (!(resp?.ok && resp.dataUrl)) {
            console.warn('[sw] offscreen replied without dataUrl', resp, '— refreshing offscreen and retrying once');
            await closeOffscreenIfAny();
            await ensureOffscreen();
            await ensureOffscreenReady();
            resp = await sendToOffscreenWithTimeout({ type: "offscreen-export", format, data }, 600000);
          }
          if (resp?.ok && resp.dataUrl) {
            try {
              const suggested = format === 'doc' ? 'eaa-wcag-audit.doc' : (format === 'csv' ? 'eaa-wcag-audit.csv' : 'eaa-wcag-audit.json');
              console.info('[sw] downloading', suggested, 'dataUrl length=', resp.dataUrl.length);
              await chrome.downloads.download({ url: resp.dataUrl, filename: resp.filename || suggested, saveAs: true });
              sendResponse({ ok: true });
            } catch (err) {
              console.error('[sw] download error:', err);
              sendResponse({ ok: false, error: String(err?.message || err) });
            }
          } else {
            console.warn('[sw] offscreen retry failed without dataUrl', resp);
            sendResponse(resp || { ok: false, error: "Offscreen export failed" });
          }
        } catch (e) {
          try {
            console.warn('[sw] export error on first attempt:', e, '— refreshing offscreen and retrying once');
            await closeOffscreenIfAny();
            await ensureOffscreen();
            await ensureOffscreenReady();
            const resp = await sendToOffscreenWithTimeout({ type: "offscreen-export", format, data }, 600000);
            if (resp?.ok && resp.dataUrl) {
              const suggested = format === 'doc' ? 'eaa-wcag-audit.doc' : (format === 'csv' ? 'eaa-wcag-audit.csv' : 'eaa-wcag-audit.json');
              console.info('[sw] downloading', suggested, 'dataUrl length=', resp.dataUrl.length);
              await chrome.downloads.download({ url: resp.dataUrl, filename: resp.filename || suggested, saveAs: true });
              sendResponse({ ok: true });
            } else {
              console.warn('[sw] offscreen retry failed without dataUrl', resp);
              sendResponse(resp || { ok: false, error: String(e?.message || e) });
            }
          } catch (e2) {
            console.error('[sw] export pipeline error after retry:', e2);
            sendResponse({ ok: false, error: String(e2?.message || e2) });
          }
        }
        return;
      }

      sendResponse({ ok: false, error: "Unsupported export format." });
    })();
    return true;
  }

  // Default (synchronous)
  sendResponse({ ok: false, error: "Unsupported message type." });
  return false;
}); // Fin du listener chrome.runtime.onMessage

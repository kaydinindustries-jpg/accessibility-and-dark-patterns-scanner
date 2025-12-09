// service_worker.js (MV3 module)

// Chargement du mapping statique au démarrage
let MAPPING = null;
(async () => {
  try {
    const res = await fetch(chrome.runtime.getURL("mapping.json"));
    MAPPING = await res.json();
  } catch (e) {
    console.error("Mapping non chargé:", e);
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
    console.warn("[sw] Création offscreen échouée:", e);
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
  // 1) Essayer de réutiliser s’il existe déjà
  try {
    const ok = await chrome.runtime.sendMessage({ type: "offscreen-ping" });
    if (ok?.ok) return true;
  } catch (_) {}
  // 2) Sinon, créer puis attendre
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
import { saveScan, getLastScanForUrl } from "./storage.js";

// Utilitaires
function mapPrincipleFromTags(tags = []) {
  // Robust si ARIA/name-role-value ou parsing
  if (tags.includes("cat.name-role-value") || tags.includes("cat.parsing")) return "Robust";
  if (tags.includes("cat.keyboard")) return "Operable";
  if (tags.includes("cat.color") || tags.includes("cat.text-alternatives") || tags.includes("cat.time-and-media")) return "Perceivable";
  if (tags.includes("cat.forms") || tags.includes("cat.language") || tags.includes("cat.structure")) return "Understandable";
  return "Robust";
}

function normalizeImpact(impact) {
  if (impact === "critical") return "Critique";
  if (impact === "serious") return "Majeure";
  if (impact === "moderate") return "Moyenne";
  if (impact === "minor") return "Mineure";
  return "Non classé";
}

function weightForImpact(frLabel) {
  // Pondérations: critical=4, serious=3, moderate=2, minor=1
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
  // Pénalité +0.5 par incomplete, plafonnée à +20 par principe
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

  // Cap Perceivable si échec AA contraste (axe ou custom)
  const hasAAContrastFail = violations.some(v => (v.principle === 'Perceivable') && Array.isArray(v.wcagRef) && v.wcagRef.some(sc => /^1\.4\.(3|11)(\b|$)/.test(sc)));
  if (hasAAContrastFail && principleScores.Perceivable > 89) principleScores.Perceivable = 89;

  const scoreGlobal = Math.round((principles.reduce((a, p) => a + principleScores[p], 0)) / principles.length);
  return { scoreGlobal, principleScores, weights: W };
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
    // Chemin de secours si libs/axe.min.js n'est pas trouvé
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
    return { ok: false, error: `Injection axe-core échouée: ${msg}` };
  }

  // 2) Exécuter le scan axe + audit contraste custom
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
        return { error: 'axe-core non présent. Veuillez déposer libs/axe.min.js', meta };
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
            // Contrast audit custom pour états normal|hover|focus, on retient le pire cas
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
              if (seen.has(selector)) continue; // dédup par sélecteur
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
              msg = 'Le préchargement des assets a échoué (probable CORS/timeout). Le scan a été interrompu par axe-core. Nous désactivons désormais le préchargement pour éviter ce blocage.';
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
        // Enrichir le message d'aide pour certaines règles (affiché dans DOC/JSON)
        let help = item.help || "";
        if (ruleId === 'meta-viewport') {
          help += " — ACT: user-scalable=no ou maximum-scale<2 = échec (1.4.4 Resize text).";
        }
        if (ruleId === 'meta-viewport-large') {
          help += " — Recommandation: permettre un zoom significatif (p.ex. ≥ 200%).";
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
        // Si axe fournit un ratio fiable pour color-contrast, le capturer depuis checks[].data
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

  // Index de contraste par sélecteur
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
  // Finding synthétique si des échecs contrastes custom sont détectés
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
        help: 'Mesure de contraste custom (normal/hover/focus).',
        tags: ['cat.color'],
        principle: 'Perceivable',
        status: 'violation',
        needsManualCheck: false,
        explanation: 'Au moins un échec de contraste AA détecté par la mesure custom.'
      });
    }
  }

  const { scoreGlobal, principleScores } = computeScores(findings);

  const counters = { Critique: 0, Majeure: 0, Moyenne: 0, Mineure: 0, "Non classé": 0 };
  for (const f of findings) if (f.status === 'violation' && !(f.needsMapping || f.advice === true)) counters[f.impact] = (counters[f.impact] || 0) + 1;

  const last = await getLastScanForUrl(tab.url || "");
  const serializeKey = (f) => `${f.id}|${(f.selectors || []).join(",")}`;
  const prevSet = new Set((last?.findings || []).map(serializeKey));
  const currSet = new Set(findings.map(serializeKey));
  const added = findings.filter((f) => !prevSet.has(serializeKey(f))).length;
  const removed = (last?.findings || []).filter((f) => !currSet.has(serializeKey(f))).length;

  // Résumé contraste
  const contrastSummary = (() => {
    const checks = contrast?.checks || [];
    const needsManual = checks.filter(c => c.needsManualCheck).length;
    const fails = checks.filter(c => !c.needsManualCheck && !c.pass).length;
    const total = checks.length;
    return { total, fails, needsManual };
  })();

  // Échantillonnage WCAG-EM: récupérer meta depuis chrome.storage.local
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

  // Calcul du résumé d’échantillon via IndexedDB (derniers scans connus pour chaque URL)
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
    // Inclure le score courant si l’URL active n’a pas encore été persistée
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

// Messages entrants du popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Branches synchrones: on répond tout de suite et on ne retourne PAS true
  if (msg?.type === "offscreen-ready") {
    console.info("[sw] offscreen signaled ready");
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "offscreen-log") {
    // Éviter les boucles: si déjà relayé par le SW, ignorer
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
            sendResponse(resp || { ok: false, error: "Offscreen export a échoué" });
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

      sendResponse({ ok: false, error: "Format export non pris en charge." });
    })();
    return true;
  }

  // Par défaut (synchrone)
  sendResponse({ ok: false, error: "Type de message non pris en charge." });
  return false;
}); // Fin du listener chrome.runtime.onMessage

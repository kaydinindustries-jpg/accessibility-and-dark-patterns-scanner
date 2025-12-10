(function (root) {
  const DEFAULTS = {
    maxCandidatesPerPage: 40,
    maxCharsPerSnippet: 1200,
    viewport: "desktop"
  };

  const CANDIDATE_ROLES = {
    COOKIE_BANNER: "cookie_banner",
    CHECKOUT: "checkout",
    SUBSCRIPTION: "subscription_flow",
    CANCELLATION: "cancellation_flow",
    PRICING: "pricing_section",
    AI_WIDGET: "ai_widget",
    GENERIC: "generic"
  };

  const PATTERN_TYPES = {
    COOKIE_NUDGE: "cookie_nudge",
    ROACH_MOTEL: "roach_motel",
    PRESELECTED_ADDON: "preselected_addon",
    HIDDEN_INFORMATION: "hidden_information",
    MISLEADING_LABEL: "misleading_label",
    AI_MANIPULATION: "ai_manipulation",
    NONE: "none"
  };

  const urgencyWords = ["last chance", "only", "hurry", "urgent", "today only", "now", "soon", "limited", "deal ends", "expires"];
  const cookieKeywords = ["cookie", "cookies", "privacy", "tracking", "consent"];
  const cookieButtons = ["accept", "agree", "allow", "ok", "reject", "decline", "refuse", "manage", "settings", "preferences"];
  const addonKeywords = ["extra", "add", "addon", "add-on", "insurance", "protection", "trial", "subscribe", "subscription", "premium", "upgrade", "extended", "warranty"];
  const cancelKeywords = ["cancel", "unsubscribe", "delete account", "close account", "stop subscription", "end membership", "terminate", "remove plan"];
  const hiddenInfoKeywords = ["non-refundable", "no refund", "auto-renew", "automatically renews", "renewal", "minimum term", "cancellation fee", "early termination"];
  const misleadingPatterns = ["no, i don't", "no, i do not", "no thanks, i prefer to pay full price", "no thanks", "i'll risk", "i will risk", "i don't want a discount"];
  const aiKeywords = ["ai", "assistant", "copilot", "smart suggestions", "recommended for you", "ai assistant", "chatbot", "chat bot", "recommendation engine"];

  function normalizeText(text) {
    return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function truncate(str, max) {
    if (!str) return "";
    if (str.length <= max) return str;
    return str.slice(0, max) + "…";
  }

  function stableId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "dp-" + Math.random().toString(36).slice(2, 10);
  }

  function elementText(el, max = 800) {
    try {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      const parts = [];
      while (walker.nextNode()) {
        const t = walker.currentNode;
        const val = String(t.nodeValue || "").replace(/\s+/g, " ").trim();
        if (val) parts.push(val);
        if (parts.join(" ").length > max) break;
      }
      return truncate(parts.join(" "), max);
    } catch {
      return "";
    }
  }

  function outerHtmlTrunc(el, max = 1200) {
    try {
      return truncate(el.outerHTML || "", max);
    } catch {
      return "";
    }
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || parseFloat(style.opacity || "1") === 0) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    return true;
  }

  function pickSelector(el) {
    if (!el || !(el instanceof Element)) return "";
    if (el.id) return `#${CSS.escape(el.id)}`;
    const dataKey = Array.from(el.attributes || []).find(a => a.name.startsWith("data-") && a.value);
    if (dataKey) return `${el.tagName.toLowerCase()}[${CSS.escape(dataKey.name)}="${CSS.escape(dataKey.value)}"]`;
    const classes = Array.from(el.classList || []);
    if (classes.length) return `${el.tagName.toLowerCase()}.${classes.map(c => CSS.escape(c)).join(".")}`;
    // Fallback to XPath-like path
    let path = el.tagName.toLowerCase();
    let cur = el;
    while (cur && cur.parentElement && path.length < 120) {
      const parent = cur.parentElement;
      const siblings = Array.from(parent.children).filter(ch => ch.tagName === cur.tagName);
      const idx = siblings.indexOf(cur);
      path = `${parent.tagName.toLowerCase()}/${path}${siblings.length > 1 ? `[${idx + 1}]` : ""}`;
      cur = parent;
    }
    return path;
  }

  function collectButtons(el) {
    const labels = [];
    el.querySelectorAll("button, a, input[type=submit], input[type=button]").forEach(btn => {
      const t = normalizeText(btn.textContent || btn.value || "");
      if (t) labels.push(t);
    });
    return Array.from(new Set(labels)).slice(0, 12);
  }

  function hasUrgency(el) {
    const txt = normalizeText(elementText(el, 200));
    return urgencyWords.some(w => txt.includes(w));
  }

  function markMeta(base, extra) {
    return { ...base, ...extra };
  }

  function buildCandidate(el, role, opts) {
    const { maxCharsPerSnippet, pageUrl, path, viewport } = opts;
    return {
      id: stableId(),
      role,
      htmlSnippet: outerHtmlTrunc(el, maxCharsPerSnippet),
      visibleText: elementText(el, maxCharsPerSnippet),
      url: pageUrl,
      path,
      xpathOrSelector: pickSelector(el),
      meta: {
        viewport,
        buttonLabels: collectButtons(el),
        isModal: !!(el.getAttribute("role") === "dialog" || el.getAttribute("aria-modal") === "true"),
        isOverlay: el.hasAttribute("aria-modal") || (getComputedStyle(el).position === "fixed" && getComputedStyle(el).zIndex > 10),
        containsUrgencyWords: hasUrgency(el)
      }
    };
  }

  function detectCookieBanners(doc, opts) {
    const res = [];
    const nodes = doc.querySelectorAll('[role="dialog"], [aria-modal="true"], .cookie, .cookies, .consent, [data-cookie]');
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      const txt = normalizeText(elementText(el, 400));
      if (!cookieKeywords.some(w => txt.includes(w))) continue;
      const cand = buildCandidate(el, CANDIDATE_ROLES.COOKIE_BANNER, opts);
      const btns = cand.meta.buttonLabels || [];
      cand.meta.hasAccept = btns.some(b => cookieButtons.some(w => b.includes(w) && (w === "accept" || w === "agree" || w === "allow" || w === "ok")));
      cand.meta.hasReject = btns.some(b => cookieButtons.some(w => b.includes("reject") || b.includes("decline") || b.includes("refuse")));
      cand.meta.patternHint = PATTERN_TYPES.COOKIE_NUDGE;
      res.push(cand);
      if (res.length >= opts.maxCandidatesPerPage) break;
    }
    return res;
  }

  function detectPreselectedAddons(doc, opts) {
    const res = [];
    const boxes = doc.querySelectorAll('input[type="checkbox"]');
    for (const cb of boxes) {
      if (!cb.checked && !cb.defaultChecked) continue;
      const label = cb.closest("label") || doc.querySelector(`label[for="${cb.id}"]`);
      const scope = label || cb.parentElement || cb;
      if (!isVisible(scope)) continue;
      const txt = normalizeText(elementText(scope, 400));
      if (!addonKeywords.some(w => txt.includes(w))) continue;
      const cand = buildCandidate(scope, CANDIDATE_ROLES.CHECKOUT, opts);
      cand.meta.hasPrecheckedCheckbox = true;
      cand.meta.containsPrice = /\d[\d\s.,]*(\$|€|£)|\$(\d|\s|,|\.)+|€(\d|\s|,|\.)+|£(\d|\s|,|\.)+/.test(scope.textContent || "");
      cand.meta.patternHint = PATTERN_TYPES.PRESELECTED_ADDON;
      res.push(cand);
      if (res.length >= opts.maxCandidatesPerPage) break;
    }
    return res;
  }

  function detectRoachMotel(doc, opts) {
    const res = [];
    const nodes = doc.querySelectorAll('a, button');
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      const txt = normalizeText(el.textContent || "");
      if (!cancelKeywords.some(w => txt.includes(w))) continue;
      const cand = buildCandidate(el, CANDIDATE_ROLES.CANCELLATION, opts);
      const styles = getComputedStyle(el);
      const small = (parseFloat(styles.fontSize) || 12) < 13 || styles.opacity < 0.7 || styles.color === styles.backgroundColor;
      cand.meta.isSmallOrLowContrast = small;
      cand.meta.patternHint = PATTERN_TYPES.ROACH_MOTEL;
      res.push(cand);
      if (res.length >= opts.maxCandidatesPerPage) break;
    }
    return res;
  }

  function detectHiddenInformation(doc, opts) {
    const res = [];
    const nodes = doc.querySelectorAll("p, small, span, div, details, summary, li");
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      const txt = normalizeText(elementText(el, 400));
      if (!hiddenInfoKeywords.some(w => txt.includes(w))) continue;
      const cand = buildCandidate(el, CANDIDATE_ROLES.PRICING, opts);
      const cs = getComputedStyle(el);
      const smallFont = (parseFloat(cs.fontSize) || 14) < 13 || (el.className || "").includes("small") || (el.className || "").includes("fine-print");
      const isCollapsed = el.tagName === "DETAILS" && !el.open;
      const ariaHidden = el.getAttribute("aria-hidden") === "true";
      cand.meta.isHiddenLike = smallFont || isCollapsed || ariaHidden;
      cand.meta.patternHint = PATTERN_TYPES.HIDDEN_INFORMATION;
      res.push(cand);
      if (res.length >= opts.maxCandidatesPerPage) break;
    }
    return res;
  }

  function detectMisleadingLabels(doc, opts) {
    const res = [];
    const nodes = doc.querySelectorAll("button, a, label, input[type=submit], input[type=button]");
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      const txt = normalizeText(el.textContent || el.value || "");
      if (!misleadingPatterns.some(w => txt.includes(w))) continue;
      const cand = buildCandidate(el, CANDIDATE_ROLES.CHECKOUT, opts);
      cand.meta.patternHint = PATTERN_TYPES.MISLEADING_LABEL;
      res.push(cand);
      if (res.length >= opts.maxCandidatesPerPage) break;
    }
    return res;
  }

  function detectAiManipulation(doc, opts) {
    const res = [];
    const nodes = doc.querySelectorAll("section, div, aside, button, a");
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      const txt = normalizeText(elementText(el, 500));
      if (!aiKeywords.some(w => txt.includes(w))) continue;
      const cand = buildCandidate(el, CANDIDATE_ROLES.AI_WIDGET, opts);
      cand.meta.patternHint = PATTERN_TYPES.AI_MANIPULATION;
      res.push(cand);
      if (res.length >= opts.maxCandidatesPerPage) break;
    }
    return res;
  }

  function mergeCandidates(lists, max) {
    const out = [];
    const seen = new Set();
    for (const list of lists) {
      for (const c of list) {
        const key = c.xpathOrSelector || c.htmlSnippet || c.visibleText;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(c);
        if (out.length >= max) return out;
      }
    }
    return out;
  }

  function collectDarkPatternCandidates(doc = document, options = {}) {
    const cfg = { ...DEFAULTS, ...(options || {}) };
    const pageUrl = cfg.pageUrl || (typeof location !== "undefined" ? location.href : "");
    const path = (() => {
      try {
        const loc = typeof location !== "undefined" ? location : { pathname: "", search: "" };
        return `${loc.pathname || ""}${loc.search || ""}`;
      } catch {
        return "";
      }
    })();

    const detectionOpts = { ...cfg, pageUrl, path };
    const groups = [
      detectCookieBanners(doc, detectionOpts),
      detectPreselectedAddons(doc, detectionOpts),
      detectRoachMotel(doc, detectionOpts),
      detectHiddenInformation(doc, detectionOpts),
      detectMisleadingLabels(doc, detectionOpts),
      detectAiManipulation(doc, detectionOpts)
    ];

    const candidates = mergeCandidates(groups, cfg.maxCandidatesPerPage);
    const scanId = cfg.scanId || stableId();
    return {
      scanId,
      pageUrl,
      timestamp: new Date().toISOString(),
      candidates
    };
  }

  function findElementBySelector(selector) {
    if (!selector) return null;
    if (selector.startsWith("#") || selector.startsWith(".") || /[.[\s]/.test(selector)) {
      try {
        const el = document.querySelector(selector);
        if (el) return el;
      } catch (_) {}
    }
    try {
      const xp = document.evaluate(selector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      if (xp?.singleNodeValue instanceof Element) return xp.singleNodeValue;
    } catch (_) {}
    try {
      return document.querySelector(selector);
    } catch (_) {
      return null;
    }
  }

  function highlightCandidate(selector, opts = {}) {
    const el = findElementBySelector(selector);
    if (!el) return { ok: false, error: "Element not found" };
    const prevOutline = el.style.outline;
    const prevScroll = opts.scroll !== false;
    if (prevScroll && el.scrollIntoView) {
      try { el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (_) {}
    }
    el.style.outline = "3px solid rgba(239,68,68,0.9)";
    el.style.outlineOffset = "2px";
    const overlay = document.createElement("div");
    overlay.style.position = "absolute";
    const rect = el.getBoundingClientRect();
    overlay.style.left = `${rect.left + window.scrollX}px`;
    overlay.style.top = `${rect.top + window.scrollY}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    overlay.style.border = "2px solid rgba(239,68,68,0.6)";
    overlay.style.boxSizing = "border-box";
    overlay.style.zIndex = "2147483646";
    overlay.style.pointerEvents = "none";
    document.body.appendChild(overlay);
    setTimeout(() => {
      el.style.outline = prevOutline;
      overlay.remove();
    }, opts.durationMs || 3000);
    return { ok: true };
  }

  root.ardasiaDarkPatterns = {
    collectDarkPatternCandidates,
    detectCookieBanners,
    detectPreselectedAddons,
    detectRoachMotel,
    detectHiddenInformation,
    detectMisleadingLabels,
    detectAiManipulation,
    highlightCandidate
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.ardasiaDarkPatterns;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);


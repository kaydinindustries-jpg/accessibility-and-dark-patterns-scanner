// Runtime config with storage override for backend URL and flags
const DEFAULT_CONFIG = {
  backendUrl: "",
  enableAccessibilityScan: true,
  enableDarkPatternScan: true,
  maxCandidatesPerPage: 40,
  maxCharsPerSnippet: 1200,
  requestTimeoutMs: 10000,
  useMockBackend: true
};

async function loadConfig() {
  const cfg = { ...DEFAULT_CONFIG };
  try {
    const store = await chrome.storage?.sync?.get?.([
      "backendUrl",
      "enableAccessibilityScan",
      "enableDarkPatternScan",
      "useMockBackend"
    ]);
    if (store) {
      if (typeof store.backendUrl === "string" && store.backendUrl.trim()) cfg.backendUrl = store.backendUrl.trim();
      if (typeof store.enableAccessibilityScan === "boolean") cfg.enableAccessibilityScan = store.enableAccessibilityScan;
      if (typeof store.enableDarkPatternScan === "boolean") cfg.enableDarkPatternScan = store.enableDarkPatternScan;
      if (typeof store.useMockBackend === "boolean") cfg.useMockBackend = store.useMockBackend;
    }
  } catch (_) {}
  return cfg;
}

async function saveConfig(partial) {
  try {
    await chrome.storage?.sync?.set?.(partial || {});
    return true;
  } catch (e) {
    console.warn("[config] save failed", e);
    return false;
  }
}

export { DEFAULT_CONFIG, loadConfig, saveConfig };


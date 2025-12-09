// storage.js - IndexedDB minimal pour historique/diffs

const DB_NAME = "eaa_auditor_db";
const STORE = "scans";
const VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        os.createIndex("by_url", "url", { unique: false });
        os.createIndex("by_time", "timestamp", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveScan(scan) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).add(scan);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getLastScanForUrl(url) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const idx = tx.objectStore(STORE).index("by_url");
    const req = idx.getAll(IDBKeyRange.only(url));
    req.onsuccess = () => {
      const rows = req.result || [];
      rows.sort((a, b) => b.timestamp - a.timestamp);
      resolve(rows[0] || null);
    };
    req.onerror = () => reject(req.error);
  });
}
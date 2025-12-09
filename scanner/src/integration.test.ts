import JSZip from 'jszip';
import { spawn } from 'child_process';

const BASE_URL = process.env.SCANNER_BASE_URL || 'http://localhost:3000';

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

async function waitForHealth(timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE_URL}/healthz`);
      if (r.ok) {
        const j: any = await r.json();
        if (j.status === 'ok') return true;
      }
    } catch {}
    await sleep(2000);
  }
  throw new Error('health_timeout');
}

async function postJSON<T>(url: string, body: any): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`POST ${url} failed: ${r.status}`);
  return r.json() as Promise<T>;
}

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} failed: ${r.status}`);
  return r.json() as Promise<T>;
}

async function download(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} failed: ${r.status}`);
  const ab = await r.arrayBuffer();
  return new Uint8Array(ab);
}

async function assertDocxContainsWatermark(buf: Uint8Array, needle: string) {
  const zip = await JSZip.loadAsync(buf);
  const files = Object.keys(zip.files);
  for (const key of files) {
    if (!key.endsWith('.xml')) continue;
    const content = await zip.files[key].async('text');
    if (content.includes(needle)) return; // pass
  }
  throw new Error(`DOCX watermark not found: ${needle}`);
}

async function main() {
  // Start server if not already running
  const child = spawn('node', ['dist/index.js'], { stdio: 'inherit', env: { ...process.env, ENABLE_TEST_SEED: '1', IN_MEMORY_MODE: '1', FREE_MODE: '1' } });
  let childStarted = true;

  const cleanup = () => { if (childStarted) { try { child.kill(); } catch {} } };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(1); });

  console.log('[test] waiting for health...');
  await waitForHealth();

  const orgId = 'test-org';

  console.log('[test] checking billing status in FREE_MODE');
  const bill = await getJSON<{ orgId: string; subscription: any; free?: boolean }>(`${BASE_URL}/billing/status?orgId=${encodeURIComponent(orgId)}`);
  if (!bill || bill.free !== true) throw new Error('expected_free_mode_true');
  if (bill.subscription !== null) throw new Error('expected_subscription_null_in_free_mode');

  console.log('[test] checking billing checkout is disabled in FREE_MODE');
  {
    const r = await fetch(`${BASE_URL}/billing/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgId }) });
    if (r.status !== 403) throw new Error(`expected_checkout_403_in_free_mode, got ${r.status}`);
    const txt = await r.text();
    if (!txt.includes('free_mode')) throw new Error('expected_free_mode_marker_in_checkout_response');
  }

  const body = {
    orgId,
    siteId: 'test-site',
    urls: ['https://example.com'],
    viewport: { w: 1366, h: 768 },
  };

  console.log('[test] seeding test scans');
  const seedRes = await postJSON<{ ok: boolean; siteId: string; scanIds: string[] }>(`${BASE_URL}/test/seed`, body);
  if (!seedRes.ok || !seedRes.scanIds || seedRes.scanIds.length !== 3) throw new Error('seed_failed');

  console.log('[test] verifying list scans majors and timeline');
  const list = await getJSON<{ items: Array<{ id: string; status: string; createdAt: string; metrics: any; majors: number }> }>(`${BASE_URL}/sites/${encodeURIComponent(seedRes.siteId)}/scans?limit=10&orgId=${encodeURIComponent(orgId)}`);
  if (!list.items || list.items.length < 3) throw new Error('list_scans_insufficient');
  const majorsSum = list.items.reduce((acc, it) => acc + (it.majors || 0), 0);
  if (majorsSum < 1) throw new Error('majors_expected_at_least_1');

  console.log('[test] verifying diff for last scan');
  const lastScanId = list.items[0].id;
  const diff = await getJSON<{ summary: { new: number; resolved: number; regressions: number; newMajors: number; byPrinciple: any } }>(`${BASE_URL}/scans/${encodeURIComponent(lastScanId)}/diff?orgId=${encodeURIComponent(orgId)}`);
  if (!diff.summary) throw new Error('diff_summary_missing');

  console.log('[test] SUCCESS (free-mode billing + seed + list + diff)');
  cleanup();
}

main().catch(e => {
  console.error('[test] FAILED', e);
  process.exit(1);
});
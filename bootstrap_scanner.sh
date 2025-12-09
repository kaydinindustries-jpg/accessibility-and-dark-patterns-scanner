#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCANNER_DIR="$ROOT_DIR/scanner"
mkdir -p "$SCANNER_DIR/src"

# package.json
cat > "$SCANNER_DIR/package.json" << 'EOF'
{
  "name": "scanner",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "dev": "node --loader ts-node/esm src/index.ts"
  },
  "dependencies": {
    "axe-core": "^4.10.0",
    "bullmq": "^5.7.14",
    "express": "^4.19.2",
    "ioredis": "^5.4.1",
    "pg": "^8.12.0",
    "puppeteer": "^23.4.1",
    "uuid": "^9.0.1"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^20.11.30",
    "ts-node": "^10.9.2",
    "typescript": "^5.6.2"
  }
}
EOF

# tsconfig.json
cat > "$SCANNER_DIR/tsconfig.json" << 'EOF'
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "sourceMap": true
  },
  "include": ["src"]
}
EOF

# Dockerfile
cat > "$SCANNER_DIR/Dockerfile" << 'EOF'
# Use Node 20 base image
FROM node:20-bookworm

# Install Chromium and dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxau6 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    xdg-utils && \
    rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    CHROME_PATH=/usr/bin/chromium

WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY src ./src
RUN npm run build

EXPOSE 3000
CMD ["node", "dist/index.js"]
EOF

# docker-compose.yml
cat > "$ROOT_DIR/docker-compose.yml" << 'EOF'
version: "3.9"
services:
  postgres:
    image: postgres:15
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: scanner
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  scanner:
    build: ./scanner
    environment:
      REDIS_URL: redis://redis:6379
      DATABASE_URL: postgres://postgres:postgres@postgres:5432/scanner
      CHROME_PATH: /usr/bin/chromium
      AXE_VERSION: 4.10.0
      NODE_ENV: production
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    ports:
      - "3000:3000"
    restart: unless-stopped
EOF

# src/index.ts
cat > "$SCANNER_DIR/src/index.ts" << 'EOF'
import express from 'express';
import { Queue, Worker, QueueEvents, JobsOptions } from 'bullmq';
import IORedis from 'ioredis';
import { Pool } from 'pg';
import puppeteer, { Browser, Page, PuppeteerLaunchOptions } from 'puppeteer';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';

// Env
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/scanner';
const CHROME_PATH = process.env.CHROME_PATH;
const AXE_VERSION = process.env.AXE_VERSION || 'latest';

// Simple JSON logger
function log(event: string, data: Record<string, unknown> = {}) {
  const entry = { ts: new Date().toISOString(), level: 'info', event, ...data };
  console.log(JSON.stringify(entry));
}
function logError(event: string, err: unknown, extra: Record<string, unknown> = {}) {
  const e = err as any;
  const entry = { ts: new Date().toISOString(), level: 'error', event, msg: e?.message, stack: e?.stack, ...extra };
  console.error(JSON.stringify(entry));
}

// PG
const pool = new Pool({ connectionString: DATABASE_URL });

async function ensureSchema() {
  await pool.query(`
  CREATE TABLE IF NOT EXISTS scans (
    id UUID PRIMARY KEY,
    org_id TEXT NOT NULL,
    site_id TEXT NOT NULL,
    status TEXT NOT NULL,
    partial BOOLEAN DEFAULT false,
    counts JSONB,
    scores JSONB,
    sample_stats JSONB,
    meta JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  `);
  await pool.query(`
  CREATE TABLE IF NOT EXISTS findings (
    id BIGSERIAL PRIMARY KEY,
    scan_id UUID REFERENCES scans(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    sc TEXT,
    impact TEXT,
    selectors JSONB,
    excerpt TEXT,
    contrast_ratio NUMERIC,
    advice TEXT,
    partial BOOLEAN DEFAULT false
  );
  `);
}

// Redis / BullMQ
const connection = new IORedis(REDIS_URL);
const scansQueue = new Queue('scans', { connection });
const scansEvents = new QueueEvents('scans', { connection });

// Types
interface Viewport { w: number; h: number; deviceScaleFactor?: number }
interface AuthBasic { type: 'basic'; username: string; password: string }
interface AuthBearer { type: 'bearer'; token: string }
interface ScanRequestBody {
  orgId: string;
  siteId: string;
  urls: string[];
  viewport: Viewport;
  headers?: Record<string, string>;
  auth?: AuthBasic | AuthBearer;
}

interface Finding {
  url: string;
  rule_id: string;
  sc?: string;
  impact?: string;
  selectors: string[];
  excerpt?: string;
  contrast_ratio?: number | null;
  advice?: string;
  partial: boolean;
}

interface Scores { Perceivable: number; Operable: number; Understandable: number; Robust: number; Overall: number; }
interface Counts { critical: number; serious: number; moderate: number; minor: number; incomplete: number; totalViolations: number }
interface SampleStats { min: number; median: number; mean: number; max: number; n: number }

// Helpers
function percentile50(sorted: number[]): number { const m = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2 }
function computeScores(findings: Finding[]): { scores: Scores; counts: Counts } {
  const impactWeights: Record<string, number> = { critical: 5, serious: 3, moderate: 2, minor: 1 };
  const counts: Counts = { critical: 0, serious: 0, moderate: 0, minor: 0, incomplete: 0, totalViolations: 0 };
  findings.forEach(f => {
    if (f.impact && (f.impact in impactWeights)) {
      // @ts-ignore
      counts[f.impact] += 1;
      counts.totalViolations += 1;
    } else if (f.impact === undefined) {
      counts.incomplete += 1;
    }
  });
  const base = 100;
  const deduction = counts.critical * 5 + counts.serious * 3 + counts.moderate * 2 + counts.minor * 1;
  const overall = Math.max(0, base - deduction);
  // Very rough mapping of rules to WCAG principles based on rule_id keywords
  const buckets: Record<keyof Omit<Scores, 'Overall'>, number> = { Perceivable: 0, Operable: 0, Understandable: 0, Robust: 0 };
  findings.forEach(f => {
    const r = f.rule_id;
    let key: keyof typeof buckets = 'Robust';
    if (/color|image|text-alt|contrast|audio|video|time|pause|blink/i.test(r)) key = 'Perceivable';
    else if (/keyboard|focus|link|target|timing|gesture|pointer|trap|bypass/i.test(r)) key = 'Operable';
    else if (/label|name|language|error|help|instructions|heading|structure/i.test(r)) key = 'Understandable';
    else key = 'Robust';
    buckets[key] += (f.impact && impactWeights[f.impact]) ? impactWeights[f.impact] : 1;
  });
  const toScore = (d: number) => Math.max(0, base - d);
  const scores: Scores = {
    Perceivable: toScore(buckets.Perceivable),
    Operable: toScore(buckets.Operable),
    Understandable: toScore(buckets.Understandable),
    Robust: toScore(buckets.Robust),
    Overall: overall
  };
  return { scores, counts };
}

async function scanUrl(url: string, viewport: Viewport, headers?: Record<string, string>, auth?: ScanRequestBody['auth']): Promise<{ findings: Finding[]; partial: boolean; pageScore: number }> {
  const launchOpts: PuppeteerLaunchOptions = {
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    executablePath: CHROME_PATH
  };
  const browser: Browser = await puppeteer.launch(launchOpts);
  let partial = false;
  try {
    const page: Page = await browser.newPage();
    page.setDefaultNavigationTimeout(30_000);
    page.setDefaultTimeout(30_000);
    await page.setViewport({ width: viewport.w, height: viewport.h, deviceScaleFactor: viewport.deviceScaleFactor || 1 });

    if (headers) {
      await page.setExtraHTTPHeaders(headers);
    }
    if (auth && auth.type === 'basic') {
      await page.authenticate({ username: auth.username, password: auth.password });
    }
    if (auth && auth.type === 'bearer') {
      const h = headers || {};
      h['Authorization'] = `Bearer ${auth.token}`;
      await page.setExtraHTTPHeaders(h);
    }

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });

    // Inject axe-core
    const axePath = await import.meta.resolve ? (import.meta as any).resolve('axe-core/axe.min.js') : require.resolve('axe-core/axe.min.js');
    try {
      await page.addScriptTag({ path: axePath });
    } catch (e) {
      partial = true; // likely CSP preventing injection
      log('axe_injection_failed', { url, reason: (e as any)?.message });
    }

    // Run axe
    let results: any = null;
    try {
      results = await page.evaluate(async () => {
        // @ts-ignore
        if (!(window as any).axe) {
          throw new Error('axe not available');
        }
        // @ts-ignore
        const r = await (window as any).axe.run(document, {
          resultTypes: ['violations', 'incomplete'],
          iframes: true
        });
        return r;
      });
    } catch (e) {
      partial = true;
      log('axe_run_failed', { url, reason: (e as any)?.message });
      results = { violations: [], incomplete: [] };
    }

    const findings: Finding[] = [];

    const extractFindings = (items: any[], isViolation: boolean) => {
      for (const v of items) {
        const rule_id = v.id as string;
        const advice = v.helpUrl || v.help || undefined;
        const sc = Array.isArray(v.tags) ? (v.tags.find((t: string) => /wcag(\d{1,2}([a-z]?))/.test(t)) || undefined) : undefined;
        for (const n of v.nodes || []) {
          const selectors: string[] = Array.isArray(n.target) ? n.target : [];
          const excerpt: string | undefined = typeof n.html === 'string' ? (n.html.length > 500 ? n.html.slice(0, 500) : n.html) : undefined;
          let contrastRatio: number | null = null;
          try {
            // some checks expose ratio in any[].data.contrastRatio
            const anyArr = Array.isArray(n.any) ? n.any : [];
            for (const a of anyArr) {
              if (a?.data?.contrastRatio) { contrastRatio = Number(a.data.contrastRatio); break; }
            }
          } catch {}
          findings.push({
            url,
            rule_id,
            sc,
            impact: isViolation ? v.impact : undefined,
            selectors,
            excerpt,
            contrast_ratio: contrastRatio,
            advice,
            partial
          });
        }
      }
    };

    extractFindings(results.violations || [], true);
    extractFindings(results.incomplete || [], false);

    const { scores, counts } = computeScores(findings);
    return { findings, partial, pageScore: scores.Overall };
  } finally {
    await browser.close();
  }
}

async function persistScan(scanId: string, orgId: string, siteId: string, urls: string[], viewport: Viewport, headers?: Record<string, string>, auth?: ScanRequestBody['auth']) {
  await pool.query('INSERT INTO scans (id, org_id, site_id, status, meta) VALUES ($1,$2,$3,$4,$5)', [
    scanId,
    orgId,
    siteId,
    'processing',
    { urls, viewport, headers: headers || null, auth: auth || null, axe_version: AXE_VERSION }
  ]);
}

async function updateScan(scanId: string, data: { status?: string; partial?: boolean; counts?: Counts; scores?: Scores; sample_stats?: SampleStats; meta?: any }) {
  const existing = await pool.query('SELECT meta FROM scans WHERE id = $1', [scanId]);
  const metaMerged = { ...(existing.rows[0]?.meta || {}), ...(data.meta || {}) };
  await pool.query('UPDATE scans SET status = COALESCE($2,status), partial = COALESCE($3,partial), counts = COALESCE($4,counts), scores = COALESCE($5,scores), sample_stats = COALESCE($6,sample_stats), meta = $7 WHERE id = $1', [
    scanId,
    data.status ?? null,
    data.partial ?? null,
    data.counts ? (data.counts as any) : null,
    data.scores ? (data.scores as any) : null,
    data.sample_stats ? (data.sample_stats as any) : null,
    metaMerged
  ]);
}

async function insertFindings(scanId: string, findings: Finding[]) {
  if (findings.length === 0) return;
  const values: any[] = [];
  const chunks: string[] = [];
  findings.forEach((f, i) => {
    const idx = i * 9;
    chunks.push(`($${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7}, $${idx + 8}, $${idx + 9})`);
    values.push(scanId, f.url, f.rule_id, f.sc || null, f.impact || null, JSON.stringify(f.selectors || []), f.excerpt || null, f.contrast_ratio ?? null, f.advice || null);
  });
  const sql = `INSERT INTO findings (scan_id, url, rule_id, sc, impact, selectors, excerpt, contrast_ratio, advice) VALUES ${chunks.join(',')}`;
  await pool.query(sql, values);
}

// Worker
const worker = new Worker<ScanRequestBody>('scans', async job => {
  const { orgId, siteId, urls, viewport, headers, auth } = job.data;
  const scanId = uuidv4();
  log('job_started', { jobId: job.id, scanId, orgId, siteId, urlCount: urls.length });
  await persistScan(scanId, orgId, siteId, urls, viewport, headers, auth);
  const allFindings: Finding[] = [];
  const perPageScores: number[] = [];
  let partial = false;

  for (const url of urls) {
    try {
      const { findings, partial: p, pageScore } = await scanUrl(url, viewport, headers, auth);
      if (p) partial = true;
      allFindings.push(...findings);
      perPageScores.push(pageScore);
    } catch (e) {
      partial = true;
      logError('scan_url_error', e, { url });
    }
  }

  const { scores, counts } = computeScores(allFindings);
  const sorted = [...perPageScores].sort((a, b) => a - b);
  const n = sorted.length;
  const stats: SampleStats = { min: n ? sorted[0] : 0, median: n ? percentile50(sorted) : 0, mean: n ? Number((sorted.reduce((s, v) => s + v, 0) / n).toFixed(2)) : 0, max: n ? sorted[n - 1] : 0, n };

  await insertFindings(scanId, allFindings);
  await updateScan(scanId, { status: 'completed', partial, counts, scores, sample_stats: stats, meta: { jobId: job.id } });

  log('job_completed', { jobId: job.id, scanId });
  return { scanId };
}, {
  connection,
  concurrency: 3,
  // 30s/page handled inside scanUrl; add overall job timeout safeguard
  lockDuration: 60_000
});

worker.on('failed', async (job, err) => {
  logError('job_failed', err, { jobId: job?.id });
});

// API
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', async (_req, res) => {
  try {
    const pgOk = await pool.query('SELECT 1');
    const redisOk = await connection.ping();
    res.json({ status: 'ok', postgres: pgOk?.rows?.[0]?.['?column?'] === 1 || true, redis: redisOk === 'PONG' });
  } catch (e) {
    logError('healthz_error', e);
    res.status(500).json({ status: 'error' });
  }
});

app.post('/scans', async (req, res) => {
  const body = req.body as ScanRequestBody;
  if (!body || !body.orgId || !body.siteId || !Array.isArray(body.urls) || body.urls.length === 0 || !body.viewport || typeof body.viewport.w !== 'number' || typeof body.viewport.h !== 'number') {
    return res.status(400).json({ error: 'Invalid body' });
  }
  const jobsOptions: JobsOptions = { attempts: 2, removeOnComplete: true, removeOnFail: false };
  try {
    const job = await scansQueue.add('scan', body, jobsOptions);
    log('job_enqueued', { jobId: job.id, orgId: body.orgId, siteId: body.siteId, urlCount: body.urls.length });
    res.json({ jobId: job.id });
  } catch (e) {
    logError('enqueue_error', e);
    res.status(500).json({ error: 'Failed to enqueue job' });
  }
});

async function start() {
  await ensureSchema();
  app.listen(PORT, () => {
    log('api_started', { port: PORT });
  });
}

start().catch(e => {
  logError('startup_error', e);
  process.exit(1);
});
EOF

chmod +x "$ROOT_DIR/bootstrap_scanner.sh"
echo "Bootstrap script created. Run: bash ./bootstrap_scanner.sh && cd scanner && npm install && npm run build && npm start" >&2
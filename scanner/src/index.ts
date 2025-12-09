import express from 'express';
import { Queue, Worker, QueueEvents, JobsOptions } from 'bullmq';
import IORedis from 'ioredis';
import { Pool } from 'pg';
import puppeteer, { Browser, Page, PuppeteerLaunchOptions } from 'puppeteer';
import { v4 as uuidv4 } from 'uuid';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
// Ajouts exports
import { writeFile, mkdir, readFile, readdir, stat } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import JSZip from 'jszip';
import { parse as parseCookie, serialize as serializeCookie } from 'cookie';
import { createRemoteJWKSet, jwtVerify, SignJWT, JWTPayload } from 'jose';
// import { Document, Packer, Paragraph, TextRun, HeadingLevel, Header } from 'docx';

// Env
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/scanner';
const CHROME_PATH = process.env.CHROME_PATH;
const AXE_VERSION = process.env.AXE_VERSION || 'latest';
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || path.join(process.cwd(), 'artifacts');
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const EMAIL_FROM = process.env.EMAIL_FROM || 'no-reply@example.com';
const SIGNING_SECRET = process.env.EXPORTS_SIGNING_SECRET || 'dev-secret';
const IN_MEMORY_MODE = process.env.IN_MEMORY_MODE === '1';
const FREE_MODE = process.env.FREE_MODE === '1';
const ALERT_SCORE_DROP_PCT = process.env.ALERT_SCORE_DROP_PCT ? Number(process.env.ALERT_SCORE_DROP_PCT) : 5;
// Auth / OIDC env
const AUTH_ENABLED = process.env.AUTH_ENABLED === '1';
const SESSION_JWT_SECRET = process.env.SESSION_JWT_SECRET || (IN_MEMORY_MODE ? 'dev-session-secret' : '');
const CLOCK_SKEW_SEC = process.env.CLOCK_SKEW_SEC ? Number(process.env.CLOCK_SKEW_SEC) : 300;
const OIDC_DEV_MODE = process.env.OIDC_DEV_MODE === '1';
// Google
const OIDC_GOOGLE_CLIENT_ID = process.env.OIDC_GOOGLE_CLIENT_ID || '';
const OIDC_GOOGLE_CLIENT_SECRET = process.env.OIDC_GOOGLE_CLIENT_SECRET || '';
const OIDC_GOOGLE_REDIRECT_URI = process.env.OIDC_GOOGLE_REDIRECT_URI || '';
// Microsoft Entra
const OIDC_MS_TENANT = process.env.OIDC_MS_TENANT || 'common';
const OIDC_MS_CLIENT_ID = process.env.OIDC_MS_CLIENT_ID || '';
const OIDC_MS_CLIENT_SECRET = process.env.OIDC_MS_CLIENT_SECRET || '';
const OIDC_MS_REDIRECT_URI = process.env.OIDC_MS_REDIRECT_URI || '';
// Stripe Billing env
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PRICE_PRO_29 = process.env.STRIPE_PRICE_PRO_29 || '';
const STRIPE_PRICE_TEAM_49 = process.env.STRIPE_PRICE_TEAM_49 || '';
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:4000';
// Initialize Stripe via require to avoid ESM import churn
const StripeLib: any = require('stripe');
const stripe: any = STRIPE_SECRET_KEY ? new StripeLib(STRIPE_SECRET_KEY) : null;
// Concurrency & timeouts controls
const SCAN_PAGE_CONCURRENCY = Math.max(1, Math.min(5, Number(process.env.SCAN_PAGE_CONCURRENCY || '3')));
const PAGE_TIMEOUT_MS = process.env.PAGE_TIMEOUT_MS ? Number(process.env.PAGE_TIMEOUT_MS) : 30_000;
const NAV_TIMEOUT_MS = process.env.NAV_TIMEOUT_MS ? Number(process.env.NAV_TIMEOUT_MS) : PAGE_TIMEOUT_MS;
// History module
import { computeAndPersistDiffForScan, saveMetricsForScan, listScansForSite, getOrComputeDiffForScan } from './history.js';

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
// Stores mémoire pour le mode test
const scansMem: any[] = [];
const findingsMem = new Map<string, Finding[]>();
const alertsMem: Array<{ scanId: string; siteId: string; triggers: string[]; dropPct?: number }> = [];
// In-memory auth stores for dev mode (avoid Postgres dependency during OIDC_DEV_MODE)
const accountsMem = new Map<string, string>(); // key: `${provider}:${sub}` -> userId
const usersMem = new Map<string, { email?: string; name?: string }>();
const usersByEmailMem = new Map<string, string>();

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

  await pool.query(`
  CREATE TABLE IF NOT EXISTS artifacts (
    id BIGSERIAL PRIMARY KEY,
    scan_id UUID REFERENCES scans(id) ON DELETE CASCADE,
    type TEXT NOT NULL, -- json|csv|docx
    filename TEXT NOT NULL,
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  `);

  // History / metrics
  await pool.query(`
  CREATE TABLE IF NOT EXISTS scan_metrics (
    scan_id UUID PRIMARY KEY REFERENCES scans(id) ON DELETE CASCADE,
    global NUMERIC,
    perceivable NUMERIC,
    operable NUMERIC,
    understandable NUMERIC,
    robust NUMERIC
  );
  `);

  await pool.query(`
  CREATE TABLE IF NOT EXISTS scan_diffs (
    id BIGSERIAL PRIMARY KEY,
    site_id TEXT NOT NULL,
    scan_id UUID NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
    diff JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scan_diffs_site_scan ON scan_diffs (site_id, scan_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scans_site_created ON scans (site_id, created_at DESC);`);

  await pool.query(`
  CREATE TABLE IF NOT EXISTS schedules (
    id UUID PRIMARY KEY,
    org_id TEXT NOT NULL,
    site_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('every','cron')),
    every_ms BIGINT,
    cron TEXT,
    timezone TEXT,
    active BOOLEAN DEFAULT true,
    run_limit INT,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_schedules_site_active ON schedules (site_id, active);`);

  // Auth-related tables
  await pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  `);
  await pool.query(`
  CREATE TABLE IF NOT EXISTS accounts (
    provider TEXT NOT NULL CHECK (provider IN ('google','microsoft')),
    sub TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (provider, sub)
  );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts (user_id);`);
  await pool.query(`
  CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    jwt TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);`);
  await pool.query(`
  CREATE TABLE IF NOT EXISTS org_members (
    org_id TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('member','admin','owner')),
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (org_id, user_id)
  );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members (user_id);`);

  // Subscriptions table for Stripe Billing
  await pool.query(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    org_id TEXT PRIMARY KEY,
    stripe_customer_id TEXT,
    status TEXT NOT NULL DEFAULT 'incomplete',
    current_period_end TIMESTAMPTZ,
    price_id TEXT,
    qty INT DEFAULT 1,
    updated_at TIMESTAMPTZ DEFAULT now(),
    created_at TIMESTAMPTZ DEFAULT now()
  );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions (status);`);
}

// Auth helpers
function b64url(input: Buffer | string) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function signHmac(data: string) {
  return b64url(crypto.createHmac('sha256', SESSION_JWT_SECRET || 'missing-secret').update(data).digest());
}
function setCookie(res: any, name: string, value: string, options: any = {}) {
  const cookie = serializeCookie(name, value, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    ...options,
  });
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', cookie);
  else if (Array.isArray(prev)) res.setHeader('Set-Cookie', [...prev, cookie]);
  else res.setHeader('Set-Cookie', [prev as string, cookie]);
}
function clearCookie(res: any, name: string) {
  const cookie = serializeCookie(name, '', { path: '/', httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 0 });
  res.setHeader('Set-Cookie', cookie);
}
function parseCookies(req: any): Record<string, string | undefined> {
  const raw = req.headers?.cookie || '';
  return parseCookie(raw || '') as Record<string, string | undefined>;
}
async function issueSession(userId: string, email: string, ttlSec = 7 * 24 * 3600) {
  const jti = uuidv4();
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({ uid: userId, email } as JWTPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setJti(jti)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSec)
    .sign(Buffer.from(SESSION_JWT_SECRET || 'dev-session-secret'));
  const expDate = new Date((now + ttlSec) * 1000);
  if (!IN_MEMORY_MODE) {
    await pool.query(`INSERT INTO sessions (id, user_id, jwt, expires_at) VALUES ($1,$2,$3,$4)`, [jti, userId, jwt, expDate]);
  }
  return { jwt, jti, expDate };
}
async function getSessionFromReq(req: any): Promise<null | { userId: string; email: string; jti?: string } > {
  try {
    const cookies = parseCookies(req);
    const token = cookies['session'];
    if (!token) return null;
    const { payload } = await jwtVerify(token, Buffer.from(SESSION_JWT_SECRET || 'dev-session-secret'), { clockTolerance: CLOCK_SKEW_SEC });
    const userId = (payload as any).uid as string;
    const email = (payload as any).email as string;
    const jti = (payload as any).jti as string | undefined;
    if (!IN_MEMORY_MODE && jti) {
      const r = await pool.query(`SELECT revoked, expires_at FROM sessions WHERE id=$1`, [jti]);
      if (r.rows.length && (r.rows[0].revoked === true || new Date(r.rows[0].expires_at) < new Date())) return null;
    }
    return { userId, email, jti };
  } catch {
    return null;
  }
}
async function requireOrgMemberFromReq(req: any, res: any, orgId: string): Promise<boolean> {
  if (!AUTH_ENABLED) return true;
  const session = await getSessionFromReq(req);
  if (!session) { res.status(401).json({ error: 'unauthorized' }); return false; }
  // In in-memory development mode, bypass org membership check after authentication for easier local testing
  if (IN_MEMORY_MODE) { (req as any).user = session; return true; }
  const r = await pool.query(`SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2`, [orgId, session.userId]);
  if (r.rows.length === 0) { res.status(403).json({ error: 'forbidden' }); return false; }
  (req as any).user = session;
  return true;
}
function buildAuthorizeUrl(provider: 'google'|'microsoft', state: string, nonce: string) {
  const scope = 'openid email profile';
  if (provider === 'google') {
    const params = new URLSearchParams({
      client_id: OIDC_GOOGLE_CLIENT_ID,
      redirect_uri: OIDC_GOOGLE_REDIRECT_URI,
      response_type: 'code',
      scope,
      state,
      nonce,
      access_type: 'offline',
      include_granted_scopes: 'true',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  } else {
    const params = new URLSearchParams({
      client_id: OIDC_MS_CLIENT_ID,
      redirect_uri: OIDC_MS_REDIRECT_URI,
      response_type: 'code',
      scope,
      state,
      nonce,
      response_mode: 'query',
    });
    return `https://login.microsoftonline.com/${encodeURIComponent(OIDC_MS_TENANT)}/oauth2/v2.0/authorize?${params.toString()}`;
  }
}
async function exchangeCodeForTokens(provider: 'google'|'microsoft', code: string) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' } as any;
  let body: string;
  let tokenUrl: string;
  if (provider === 'google') {
    tokenUrl = 'https://oauth2.googleapis.com/token';
    body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: OIDC_GOOGLE_CLIENT_ID,
      client_secret: OIDC_GOOGLE_CLIENT_SECRET,
      redirect_uri: OIDC_GOOGLE_REDIRECT_URI,
    }).toString();
  } else {
    tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(OIDC_MS_TENANT)}/oauth2/v2.0/token`;
    body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: OIDC_MS_CLIENT_ID,
      client_secret: OIDC_MS_CLIENT_SECRET,
      redirect_uri: OIDC_MS_REDIRECT_URI,
    }).toString();
  }
  const resp = await fetch(tokenUrl, { method: 'POST', headers, body });
  if (!resp.ok) throw new Error('token_exchange_failed');
  const json = await resp.json();
  return json as { id_token: string; access_token?: string; refresh_token?: string };
}
async function verifyProviderIdToken(provider: 'google'|'microsoft', idToken: string, expectedNonce: string) {
  let jwksUrl: string;
  if (provider === 'google') {
    jwksUrl = 'https://www.googleapis.com/oauth2/v3/certs';
  } else {
    jwksUrl = `https://login.microsoftonline.com/${encodeURIComponent(OIDC_MS_TENANT)}/discovery/v2.0/keys`;
  }
  const JWKS = createRemoteJWKSet(new URL(jwksUrl));
  const { payload } = await jwtVerify(idToken, JWKS, { clockTolerance: CLOCK_SKEW_SEC });
  const aud = payload.aud as string | string[] | undefined;
  const nonce = payload.nonce as string | undefined;
  const email = (payload.email as string) || undefined;
  const name = (payload.name as string) || undefined;
  if (provider === 'google' && !(Array.isArray(aud) ? aud.includes(OIDC_GOOGLE_CLIENT_ID) : aud === OIDC_GOOGLE_CLIENT_ID)) throw new Error('invalid_audience');
  if (provider === 'microsoft' && !(Array.isArray(aud) ? aud.includes(OIDC_MS_CLIENT_ID) : aud === OIDC_MS_CLIENT_ID)) throw new Error('invalid_audience');
  if (!nonce || nonce !== expectedNonce) throw new Error('invalid_nonce');
  return { sub: payload.sub as string, email, name, iss: payload.iss as string };
}
async function upsertUserAndAccount(provider: 'google'|'microsoft', sub: string, email?: string, name?: string) {
  if (IN_MEMORY_MODE) {
    const key = `${provider}:${sub}`;
    let userId = accountsMem.get(key);
    // Try to reuse user by email
    if (!userId && email) {
      const existing = usersByEmailMem.get(email);
      if (existing) userId = existing;
    }
    if (!userId) {
      userId = uuidv4();
      usersMem.set(userId, { email, name });
      if (email) usersByEmailMem.set(email, userId);
    } else {
      const current = usersMem.get(userId) || {};
      usersMem.set(userId, { email: email ?? current.email, name: name ?? current.name });
      if (email) usersByEmailMem.set(email, userId);
    }
    accountsMem.set(key, userId);
    return userId;
  }
  const acc = await pool.query(`SELECT user_id FROM accounts WHERE provider=$1 AND sub=$2`, [provider, sub]);
  if (acc.rows.length) {
    const userId = acc.rows[0].user_id as string;
    if (email || name) await pool.query(`UPDATE users SET email = COALESCE($2,email), name = COALESCE($3,name) WHERE id = $1`, [userId, email || null, name || null]);
    return userId;
  }
  let userId: string | null = null;
  if (email) {
    const u = await pool.query(`SELECT id FROM users WHERE email=$1`, [email]);
    if (u.rows.length) userId = u.rows[0].id as string;
  }
  if (!userId) {
    userId = uuidv4();
    await pool.query(`INSERT INTO users (id, email, name) VALUES ($1,$2,$3)`, [userId, email || `user-${provider}-${sub}@example.invalid`, name || null]);
  }
  await pool.query(`INSERT INTO accounts (provider, sub, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [provider, sub, userId]);
  return userId;
}

// Redis / BullMQ
let connection: any = null;
let scansQueue: Queue<ScanRequestBody> | null = null;
let scansEvents: QueueEvents | null = null;
let exportsQueue: Queue<ExportJobData> | null = null;
let exportsEvents: QueueEvents | null = null;
if (!IN_MEMORY_MODE) {
  const IORedisCjs = require('ioredis');
  connection = new IORedisCjs(REDIS_URL, { maxRetriesPerRequest: null as any });
  scansQueue = new Queue<ScanRequestBody>('scans', { connection });
  scansEvents = new QueueEvents('scans', { connection });
  exportsQueue = new Queue<ExportJobData>('exports', { connection });
  exportsEvents = new QueueEvents('exports', { connection });
}

// Scheduling helpers
async function getLatestScanTemplateForSite(siteId: string): Promise<null | { urls: string[]; viewport: Viewport; headers?: Record<string, string>; auth?: ScanRequestBody['auth']; webhookUrl?: string; email?: { to: string[]; attach?: boolean } } > {
  if (IN_MEMORY_MODE) return null;
  const r = await pool.query(
    `SELECT meta FROM scans WHERE site_id = $1 AND status = 'completed' ORDER BY created_at DESC LIMIT 1`,
    [siteId]
  );
  if (r.rows.length === 0) return null;
  const meta = r.rows[0].meta || {};
  const urls = Array.isArray(meta.urls) ? meta.urls : [];
  const viewport = meta.viewport as Viewport | undefined;
  if (!urls.length || !viewport) return null;
  return {
    urls,
    viewport,
    headers: meta.headers || undefined,
    auth: meta.auth || undefined,
    webhookUrl: meta.webhookUrl || undefined,
    email: meta.email || undefined,
  };
}

function buildRepeatOpts(s: { type: 'every'|'cron'; every_ms?: number | null; cron?: string | null; timezone?: string | null; limit?: number | null }): any {
  if (s.type === 'every') {
    if (!s.every_ms || s.every_ms <= 0) throw new Error('invalid_every_ms');
    const repeat: any = { every: Number(s.every_ms) };
    if (s.limit && s.limit > 0) repeat.limit = s.limit;
    return repeat;
  } else {
    if (!s.cron) throw new Error('invalid_cron');
    const repeat: any = { pattern: s.cron } as any;
    if (s.timezone) {
      // BullMQ v5 uses tz for cron-parser options
      (repeat as any).tz = s.timezone;
    }
    if (s.limit && s.limit > 0) repeat.limit = s.limit;
    return repeat;
  }
}

async function upsertSchedulerForRow(row: any) {
  if (IN_MEMORY_MODE || !scansQueue) return;
  if (!row.active) return;
  const template = await getLatestScanTemplateForSite(row.site_id);
  if (!template) {
    log('schedule_skip_upsert', { reason: 'no_template', siteId: row.site_id, scheduleId: row.id });
    return;
  }
  const repeatOpts = buildRepeatOpts({ type: row.type, every_ms: row.every_ms, cron: row.cron, timezone: row.timezone, limit: row.limit });
  await scansQueue.upsertJobScheduler(
    row.id,
    repeatOpts,
    {
      name: 'scheduled-scan',
      data: {
        orgId: row.org_id,
        siteId: row.site_id,
        urls: template.urls,
        viewport: template.viewport,
        headers: template.headers,
        auth: template.auth,
        webhookUrl: template.webhookUrl,
        email: template.email,
      },
      opts: {} as JobsOptions
    }
  );
  log('schedule_upserted', { scheduleId: row.id, type: row.type, every_ms: row.every_ms, cron: row.cron, timezone: row.timezone, limit: row.limit });
}

async function removeSchedulerById(id: string) {
  if (IN_MEMORY_MODE || !scansQueue) return false;
  try {
    const removed = await scansQueue.removeJobScheduler(id);
    log('schedule_removed', { scheduleId: id, removed });
    return removed;
  } catch (e) {
    logError('schedule_remove_error', e, { scheduleId: id });
    return false;
  }
}

async function bootstrapActiveSchedules() {
  if (IN_MEMORY_MODE) return;
  try {
    const r = await pool.query(`SELECT id, org_id, site_id, type, every_ms, cron, timezone, active, run_limit AS limit FROM schedules WHERE active = true`);
    for (const row of r.rows) {
      try {
        await upsertSchedulerForRow(row);
      } catch (e) {
        logError('schedule_bootstrap_error', e, { scheduleId: row.id });
      }
    }
  } catch (e) {
    logError('schedule_bootstrap_query_error', e);
  }
}

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
  webhookUrl?: string;
  email?: { to: string[]; attach?: boolean };
  scanId?: string;
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

interface ExportJobData { scanId: string }

function percentile50(sorted: number[]) { const m = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2; }

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
  const buckets = { Perceivable: 0, Operable: 0, Understandable: 0, Robust: 0 } as Scores & Record<string, number>;
  findings.forEach(f => {
    const r = f.rule_id;
    let key: keyof Scores = 'Robust';
    if (/color|image|text-alt|contrast|audio|video|time|pause|blink/i.test(r)) key = 'Perceivable';
    else if (/keyboard|focus|link|target|timing|gesture|pointer|trap|bypass/i.test(r)) key = 'Operable';
    else if (/label|name|language|error|help|instructions|heading|structure/i.test(r)) key = 'Understandable';
    else key = 'Robust';
    const w = f.impact === 'critical' ? 5 : f.impact === 'serious' ? 3 : f.impact === 'moderate' ? 2 : f.impact === 'minor' ? 1 : 1;
    buckets[key] += w;
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

async function scanUrl(url: string, viewport: Viewport, headers?: Record<string, string>, auth?: ScanRequestBody['auth']): Promise<{ findings: Finding[]; partial: boolean; pageScore: number; browserVersion?: string }> {
  const launchOpts: PuppeteerLaunchOptions = {
    headless: 'new' as any,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--headless=new'],
    executablePath: CHROME_PATH
  };
  const browser: Browser = await puppeteer.launch(launchOpts);
  let partial = false;
  try {
    const browserVersion = await browser.version();
    const page: Page = await browser.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);
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
    await page.goto(url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
    // Inject axe-core
    const axePath = require.resolve('axe-core/axe.min.js');
    try {
      await page.addScriptTag({ path: axePath });
    } catch (e: any) {
      partial = true; // likely CSP preventing injection
      log('axe_injection_failed', { url, reason: e?.message });
    }
    // Run axe
    let results: any = null;
    try {
      results = await page.evaluate(async () => {
        // @ts-ignore
        if (!window.axe) {
          throw new Error('axe not available');
        }
        // @ts-ignore
        const r = await window.axe.run(document, {
          resultTypes: ['violations', 'incomplete'],
          iframes: true
        });
        return r;
      });
    } catch (e: any) {
      partial = true;
      log('axe_run_failed', { url, reason: e?.message });
      results = { violations: [], incomplete: [] };
    }

    const findings: Finding[] = [];
    const extractFindings = (items: any[], isViolation: boolean) => {
      for (const v of items) {
        const rule_id = v.id as string;
        const advice = (v.helpUrl || v.help || undefined) as string | undefined;
        const sc = Array.isArray(v.tags) ? (v.tags.find((t: string) => /wcag(\d{1,2}([a-z]?))/.test(t)) || undefined) : undefined;
        for (const n of v.nodes || []) {
          const selectors = Array.isArray(n.target) ? n.target : [];
          const excerpt = typeof n.html === 'string' ? (n.html.length > 500 ? n.html.slice(0, 500) : n.html) : undefined;
          let contrastRatio: number | null = null;
          try {
            const anyArr = Array.isArray(n.any) ? n.any : [];
            for (const a of anyArr) {
              if (a?.data?.contrastRatio) {
                contrastRatio = Number(a.data.contrastRatio);
                break;
              }
            }
          } catch {}
          findings.push({
            url,
            rule_id,
            sc,
            impact: isViolation ? (v.impact as string) : undefined,
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
    const { scores } = computeScores(findings);
    return { findings, partial, pageScore: scores.Overall, browserVersion };
  } finally {
    await browser.close();
  }
}

async function persistScan(scanId: string, orgId: string, siteId: string, urls: string[], viewport: Viewport, headers?: Record<string, string>, auth?: ScanRequestBody['auth'], extraMeta: any = {}) {
  if (IN_MEMORY_MODE) {
    scansMem.push({
      id: scanId,
      org_id: orgId,
      site_id: siteId,
      status: 'processing',
      partial: false,
      counts: null,
      scores: null,
      sample_stats: null,
      meta: { urls, viewport, headers: headers || null, auth: auth || null, axe_version: AXE_VERSION, ...extraMeta },
      created_at: new Date().toISOString(),
    });
    return;
  }
  await pool.query('INSERT INTO scans (id, org_id, site_id, status, meta) VALUES ($1,$2,$3,$4,$5)', [
    scanId,
    orgId,
    siteId,
    'processing',
    { urls, viewport, headers: headers || null, auth: auth || null, axe_version: AXE_VERSION, ...extraMeta }
  ]);
}

async function updateScan(scanId: string, data: { status?: string; partial?: boolean; counts?: Counts; scores?: Scores; sample_stats?: SampleStats; meta?: any }) {
  if (IN_MEMORY_MODE) {
    const idx = scansMem.findIndex(s => s.id === scanId);
    if (idx !== -1) {
      const existing = scansMem[idx];
      const mergedMeta = { ...(existing.meta || {}), ...(data.meta || {}) };
      scansMem[idx] = {
        ...existing,
        status: data.status ?? existing.status,
        partial: data.partial ?? existing.partial,
        counts: data.counts ?? existing.counts,
        scores: data.scores ?? existing.scores,
        sample_stats: data.sample_stats ?? existing.sample_stats,
        meta: mergedMeta,
      };
    }
    return;
  }
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
  if (IN_MEMORY_MODE) {
    if (findings.length === 0) return;
    const current = findingsMem.get(scanId) || [];
    findingsMem.set(scanId, current.concat(findings.map(f => ({ ...f }))));
    return;
  }
  if (findings.length === 0) return;
  const values: any[] = [];
  const chunks: string[] = [];
  findings.forEach((f, i) => {
    const idx = i * 10;
    chunks.push(`($${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7}, $${idx + 8}, $${idx + 9}, $${idx + 10})`);
    values.push(
      scanId,
      f.url,
      f.rule_id,
      f.sc || null,
      f.impact || null,
      JSON.stringify(f.selectors || []),
      f.excerpt || null,
      f.contrast_ratio ?? null,
      f.advice || null,
      f.partial ?? false
    );
  });
  const sql = `INSERT INTO findings (scan_id, url, rule_id, sc, impact, selectors, excerpt, contrast_ratio, advice, partial) VALUES ${chunks.join(',')}`;
  await pool.query(sql, values);
}

async function getScanById(scanId: string) {
  if (IN_MEMORY_MODE) {
    return scansMem.find(s => s.id === scanId) || null;
  }
  const r = await pool.query('SELECT * FROM scans WHERE id = $1', [scanId]);
  return r.rows[0] || null;
}
async function getFindingsByScan(scanId: string): Promise<Finding[]> {
  if (IN_MEMORY_MODE) {
    return (findingsMem.get(scanId) || []).map(f => ({ ...f }));
  }
  const r = await pool.query('SELECT url, rule_id, sc, impact, selectors, excerpt, contrast_ratio, advice, false as partial FROM findings WHERE scan_id = $1', [scanId]);
  return r.rows as any;
}

// Worker SCAN
if (!IN_MEMORY_MODE) {
const worker = new Worker<ScanRequestBody>('scans', async job => {
  const { orgId, siteId, urls, viewport, headers, auth, webhookUrl, email, scanId: provided } = job.data;
  const scanId = provided || uuidv4();
  log('job_started', { jobId: job.id, scanId, orgId, siteId, urlCount: urls.length, pageConcurrency: SCAN_PAGE_CONCURRENCY, timeouts: { page: PAGE_TIMEOUT_MS, nav: NAV_TIMEOUT_MS } });
  await persistScan(scanId, orgId, siteId, urls, viewport, headers, auth, { webhookUrl, email });
  const allFindings: Finding[] = [];
  const perPageScores: number[] = [];
  let partial = false;
  let chromeVersion: string | null = null;

  const queue = [...urls];
  const workers = Array.from({ length: Math.min(SCAN_PAGE_CONCURRENCY, queue.length) }, () => (async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) break;
      try {
        const { findings, partial: p, pageScore, browserVersion } = await scanUrl(next, viewport, headers, auth);
        if (p) partial = true;
        allFindings.push(...findings);
        perPageScores.push(pageScore);
        if (!chromeVersion && browserVersion) chromeVersion = browserVersion;
      } catch (e) {
        partial = true;
        logError('scan_url_error', e, { url: next });
      }
    }
  })());
  await Promise.all(workers);

  const { scores, counts } = computeScores(allFindings);
  const sorted = [...perPageScores].sort((a, b) => a - b);
  const n = sorted.length;
  const stats: SampleStats = { min: n ? sorted[0] : 0, median: n ? percentile50(sorted) : 0, mean: n ? Number((sorted.reduce((s, v) => s + v, 0) / n).toFixed(2)) : 0, max: n ? sorted[n - 1] : 0, n };

  await insertFindings(scanId, allFindings);
  await updateScan(scanId, { status: 'completed', partial, counts, scores, sample_stats: stats, meta: { jobId: job.id, chrome_version: chromeVersion || null } });
  // Persist metrics and diff
  try {
    await saveMetricsForScan(pool, scanId, scores);
    await computeAndPersistDiffForScan(pool, scanId);
  } catch (e) {
    logError('history_persist_error', e, { scanId });
  }

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
}

// Exports helpers
async function ensureArtifactsDir(scanId: string) {
  const dir = path.join(ARTIFACTS_DIR, scanId);
  await mkdir(dir, { recursive: true });
  return dir;
}
function sha256OfBuffer(buf: Buffer) {
  const h = crypto.createHash('sha256');
  h.update(buf);
  return h.digest('hex');
}
function hmacToken(scanId: string, filename: string, exp: number) {
  return crypto.createHmac('sha256', SIGNING_SECRET).update(`${scanId}|${filename}|${exp}`).digest('hex');
}
function makeSignedUrl(baseUrl: string, scanId: string, filename: string, ttlSec = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ttlSec;
  const sig = hmacToken(scanId, filename, exp);
  return `${baseUrl}/scans/${scanId}/artifacts/${encodeURIComponent(filename)}?exp=${exp}&sig=${sig}`;
}
function impactWeight(impact?: string) {
  return impact === 'critical' ? 5 : impact === 'serious' ? 3 : impact === 'moderate' ? 2 : impact === 'minor' ? 1 : 1;
}
function ruleToPrinciple(ruleId: string): 'Perceivable' | 'Operable' | 'Understandable' | 'Robust' {
  if (/color|image|text-alt|contrast|audio|video|time|pause|blink/i.test(ruleId)) return 'Perceivable';
  if (/keyboard|focus|link|target|timing|gesture|pointer|trap|bypass/i.test(ruleId)) return 'Operable';
  if (/label|name|language|error|help|instructions|heading|structure/i.test(ruleId)) return 'Understandable';
  return 'Robust';
}
async function loadWcagMapping(): Promise<Record<string, string>> {
  try {
    const mappingPath = path.resolve(process.cwd(), '..', 'mapping.json');
    const content = await readFile(mappingPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function saveArtifact(scanId: string, type: 'json' | 'csv' | 'docx' | 'zip' | 'declaration', filename: string, buffer: Buffer) {
  await ensureArtifactsDir(scanId);
  const fullPath = path.join(ARTIFACTS_DIR, scanId, filename);
  await writeFile(fullPath, buffer);
  const sha256 = sha256OfBuffer(buffer);
  if (!IN_MEMORY_MODE) {
    await pool.query('INSERT INTO artifacts (scan_id, filename, type, path, sha256) VALUES ($1,$2,$3,$4,$5)', [scanId, filename, type, fullPath, sha256]);
  }
  return { filename, type, path: fullPath, sha256 };
}

async function generateJsonArtifact(scan: any, findings: Finding[]) {
  const payload = {
    meta: {
      orgId: scan.org_id,
      siteId: scan.site_id,
      urls: scan.meta?.urls || [],
      sampleStats: scan.sample_stats || null,
      timestamp: new Date().toISOString(),
      versions: { axe: AXE_VERSION }
    },
    scores: scan.scores || null,
    findings
  };
  const buf = Buffer.from(JSON.stringify(payload, null, 2), 'utf-8');
  return buf;
}

async function generateCsvArtifact(scan: any, findings: Finding[]) {
  const headers = ['ruleId','sc','principe','impact','selectors','excerpt','advice','weight','contrastSource','ratio'];
  const lines = [headers.join(',')];
  for (const f of findings) {
    const principle = ruleToPrinciple(f.rule_id);
    const weight = impactWeight(f.impact);
    const contrastSource = f.contrast_ratio != null ? 'axe' : '';
    const ratio = f.contrast_ratio != null ? String(f.contrast_ratio) : '';
    const row = [
      f.rule_id,
      f.sc || '',
      principle,
      f.impact || '',
      JSON.stringify(f.selectors || []),
      (f.excerpt || '').replace(/\n/g, ' ').slice(0, 200).replace(/"/g, '""'),
      (f.advice || '').replace(/\n/g, ' ').slice(0, 200).replace(/"/g, '""'),
      String(weight),
      contrastSource,
      ratio
    ];
    lines.push(row.map(v => /[",\n]/.test(v) ? `"${v.replace(/"/g,'""')}"` : v).join(','));
  }
  return Buffer.from(lines.join('\n'), 'utf-8');
}

async function generateDocxArtifact(scan: any, findings: Finding[]) {
  // Génère un DOCX minimal (OOXML) via JSZip, sans dépendances externes.
  const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const scores = scan.scores || {};
  const stats: SampleStats | undefined = scan.sample_stats;
  // Versions — privilégier celles persistées dans le scan, avec repli sur l'env
  const axeVersion: string = (scan.meta?.axe_version ?? AXE_VERSION ?? 'unknown');
  const chromeRaw: string | undefined | null = scan.meta?.chrome_version ?? undefined;
  const chromeVersion: string = chromeRaw ? (chromeRaw.match(/\d+(?:\.\d+)*/)?.[0] ?? chromeRaw) : 'unknown';
  const pagesCount: number | undefined = Array.isArray(scan.urls) ? scan.urls.length : (Array.isArray(scan.meta?.urls) ? scan.meta.urls.length : (typeof scan.meta?.urls_count === 'number' ? scan.meta.urls_count : undefined));
  const lines: string[] = [
    'Pré-audit d’accessibilité',
    `Organisation: ${scan.org_id}`,
    `Site: ${scan.site_id}`,
    `Périmètre: ${pagesCount ?? 'N/A'} pages`,
    `Date: ${new Date().toISOString()}`,
    `Score global: ${scores.Overall ?? 'N/A'}`,
    `Scores par principe — Perceivable: ${scores.Perceivable ?? 'N/A'}, Operable: ${scores.Operable ?? 'N/A'}, Understandable: ${scores.Understandable ?? 'N/A'}, Robust: ${scores.Robust ?? 'N/A'}`,
    `SampleStats — n: ${stats?.n ?? 'N/A'}, min: ${stats?.min ?? 'N/A'}, median: ${stats?.median ?? 'N/A'}, mean: ${stats?.mean ?? 'N/A'}, max: ${stats?.max ?? 'N/A'}`,
    `Nombre de constats: ${findings.length}`,
    `Version axe: ${axeVersion}`,
    `Version Chrome: ${chromeVersion}`
  ];

  const docXmlHeader = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const wNs = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const p = (text: string) => `\n    <w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p>`;
  const body = `  <w:body>${lines.map(p).join('')}\n  </w:body>`;
  const documentXml = `${docXmlHeader}\n<w:document xmlns:w="${wNs}">\n${body}\n</w:document>`;

  const contentTypes = `${docXmlHeader}\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n  <Default Extension="xml" ContentType="application/xml"/>\n  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>\n</Types>`;
  const rels = `${docXmlHeader}\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>\n</Relationships>`;

  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypes);
  zip.folder('_rels')!.file('.rels', rels);
  zip.folder('word')!.file('document.xml', documentXml);

  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  return buf;
}


async function getPreviousMajorSet(siteId: string, excludeScanId: string) {
  const r = await pool.query(`SELECT id FROM scans WHERE site_id = $1 AND status = 'completed' AND id <> $2 ORDER BY created_at DESC LIMIT 1`, [siteId, excludeScanId]);
  if (r.rows.length === 0) return new Set<string>();
  const prevId = r.rows[0].id as string;
  const prev = await pool.query(`SELECT url, rule_id, impact FROM findings WHERE scan_id = $1 AND impact IN ('critical','serious')`, [prevId]);
  const set = new Set<string>();
  for (const row of prev.rows) set.add(`${row.url}|${row.rule_id}`);
  return set;
}

async function countNewMajors(scan: any): Promise<number> {
  const prevSet = await getPreviousMajorSet(scan.site_id, scan.id);
  const cur = await pool.query(`SELECT url, rule_id FROM findings WHERE scan_id = $1 AND impact IN ('critical','serious')`, [scan.id]);
  let c = 0;
  for (const row of cur.rows) {
    const key = `${row.url}|${row.rule_id}`;
    if (!prevSet.has(key)) c++;
  }
  return c;
}

async function getPreviousCompletedScan(siteId: string, excludeScanId: string): Promise<any | null> {
  const r = await pool.query(
    `SELECT id, scores FROM scans WHERE site_id = $1 AND status = 'completed' AND id <> $2 ORDER BY created_at DESC LIMIT 1`,
    [siteId, excludeScanId]
  );
  return r.rows.length ? r.rows[0] : null;
}

function computeScoreDropPct(prevOverall?: number, curOverall?: number): number {
  if (prevOverall == null || curOverall == null) return 0;
  if (prevOverall <= 0) return 0;
  const drop = ((prevOverall - curOverall) / prevOverall) * 100;
  return Number(Math.max(0, drop).toFixed(2));
}

async function countNewSCViolations(scan: any, scList: string[]): Promise<number> {
  const prevSet = await getPreviousMajorSet(scan.site_id, scan.id);
  const cur = await pool.query(
    `SELECT url, rule_id, sc FROM findings WHERE scan_id = $1 AND impact IN ('critical','serious') AND sc = ANY($2)`,
    [scan.id, scList]
  );
  let c = 0;
  for (const row of cur.rows) {
    const key = `${row.url}|${row.rule_id}`;
    if (!prevSet.has(key)) c++;
  }
  return c;
}

async function postToSlack(webhookUrl: string, title: string, overall: number | undefined, newMajors: number, artifactsText: string, triggers: string[] = [], dropPct?: number) {
  // Slack incoming webhooks: POST JSON to a single URL. Avoid sensitive data in payloads.
  const parts: string[] = [];
  parts.push(`${title}`);
  parts.push(`Score global: ${overall ?? 'N/A'}`);
  parts.push(`Nouveaux majeurs: ${newMajors}`);
  if (triggers.length) parts.push(`Déclencheurs: ${triggers.join(', ')}`);
  if (dropPct != null && dropPct > 0) parts.push(`Baisse de score: -${dropPct}%`);
  parts.push(`Téléchargements: ${artifactsText}`);
  const body = { text: parts.join(' — ') };
  try {
    await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    logError('slack_webhook_error', e);
  }
}

async function sendEmail(to: string[], subject: string, htmlBody: string, attachments?: { filename: string; content: Buffer }[]) {
  // For production deliverability, configure real SMTP with SPF/DKIM/DMARC at your domain; Nodemailer is only the client.
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    log('email_skip', { reason: 'smtp_not_configured' });
    return;
  }
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  await transporter.sendMail({ from: EMAIL_FROM, to, subject, html: htmlBody, attachments });
}

// Worker EXPORTS
if (!IN_MEMORY_MODE) {
const exportsWorker = new Worker<ExportJobData>('exports', async job => {
  const { scanId } = job.data;
  const scan = await getScanById(scanId);
  if (!scan) throw new Error('scan_not_found');
  if (scan.status !== 'completed') throw new Error('scan_not_completed');
  const findings = await getFindingsByScan(scanId);

  // Generate artifacts
  const jsonBuf = await generateJsonArtifact(scan, findings);
  const csvBuf = await generateCsvArtifact(scan, findings);
  const docxBuf = await generateDocxArtifact(scan, findings);
  const jsonMeta = await saveArtifact(scanId, 'json', `report-${scanId}.json`, jsonBuf);
  const csvMeta = await saveArtifact(scanId, 'csv', `report-${scanId}.csv`, csvBuf);
  const docxMeta = await saveArtifact(scanId, 'docx', `report-${scanId}.docx`, docxBuf);

  // Alerts & notifications context
  const baseUrl = process.env.PUBLIC_BASE_URL || '';
  let artifactsText = `/scans/${scanId}/artifacts`;
  if (baseUrl) {
    const jsonUrl = makeSignedUrl(baseUrl, scanId, jsonMeta.filename, 24 * 3600);
    const csvUrl = makeSignedUrl(baseUrl, scanId, csvMeta.filename, 24 * 3600);
    const docxUrl = makeSignedUrl(baseUrl, scanId, docxMeta.filename, 24 * 3600);
    artifactsText = `JSON: ${jsonUrl} | CSV: ${csvUrl} | DOCX: ${docxUrl}`;
  }

  const newMajors = await countNewMajors(scan);
  const prev = await getPreviousCompletedScan(scan.site_id, scan.id);
  const dropPct = computeScoreDropPct(prev?.scores?.Overall, scan.scores?.Overall);
  const triggers: string[] = [];
  if (newMajors > 0) triggers.push(`majors.new:${newMajors}`);
  if (dropPct >= ALERT_SCORE_DROP_PCT) triggers.push(`score.drop:${dropPct}%`);
  const sc143 = await countNewSCViolations(scan, ['1.4.3']);
  if (sc143 > 0) triggers.push(`wcag.1.4.3.new:${sc143}`);
  const sc1411 = await countNewSCViolations(scan, ['1.4.11']);
  if (sc1411 > 0) triggers.push(`wcag.1.4.11.new:${sc1411}`);

  if (scan.meta?.webhookUrl) {
    await postToSlack(scan.meta.webhookUrl, `Scan ${scanId} terminé`, scan.scores?.Overall, newMajors, artifactsText, triggers, dropPct);
  }

  if (scan.meta?.email?.to && Array.isArray(scan.meta.email.to) && scan.meta.email.to.length > 0) {
    const attach = scan.meta.email.attach !== false; // attach by default
    const subject = 'Pré-audit terminé';
    let html = `Votre pré-audit est terminé. Score global: ${scan.scores?.Overall ?? 'N/A'}.`;
    if (triggers.length) {
      html += `<br/>Déclencheurs: ${triggers.join(', ')}`;
    }
    let attachments: { filename: string; content: Buffer }[] | undefined;
    if (attach) {
      html += `<br/>Les rapports sont joints à ce message.`;
      attachments = [
        { filename: jsonMeta.filename, content: jsonBuf },
        { filename: csvMeta.filename, content: csvBuf },
        { filename: docxMeta.filename, content: docxBuf }
      ];
    } else if (baseUrl) {
      const jsonUrl = makeSignedUrl(baseUrl, scanId, jsonMeta.filename, 24 * 3600);
      const csvUrl = makeSignedUrl(baseUrl, scanId, csvMeta.filename, 24 * 3600);
      const docxUrl = makeSignedUrl(baseUrl, scanId, docxMeta.filename, 24 * 3600);
      html += `<br/>Téléchargements (liens signés 24h):<br/>
        JSON: <a href="${jsonUrl}">${jsonMeta.filename}</a><br/>
        CSV: <a href="${csvUrl}">${csvMeta.filename}</a><br/>
        DOCX: <a href="${docxUrl}">${docxMeta.filename}</a><br/>`;
    } else {
      html += `<br/>Aucun PUBLIC_BASE_URL configuré, veuillez joindre les fichiers ou exposer l'API.`;
    }
    await sendEmail(scan.meta.email.to, subject, html, attachments);
  }

  log('exports_completed', { scanId, artifacts: [jsonMeta, csvMeta, docxMeta] });
  return { artifacts: [jsonMeta, csvMeta, docxMeta] };
}, { connection, concurrency: 2 });

exportsWorker.on('failed', async (job, err) => {
  logError('exports_failed', err, { jobId: job?.id });
});
}

// API
const app = express()
app.use((req, res, next) => {
  if (req.path === '/billing/webhook') return next();
  (req as any).freeMode = FREE_MODE;
  return (express.json({ limit: '1mb' }) as any)(req, res, next);
});

// Auth endpoints
if (AUTH_ENABLED) {
  app.get('/auth/me', async (req, res) => {
    const session = await getSessionFromReq(req);
    if (!session) return res.status(200).json({ user: null });
    res.json({ user: { id: session.userId, email: session.email } });
  });

  app.post('/auth/logout', async (req, res) => {
    const session = await getSessionFromReq(req);
    if (session?.jti && !IN_MEMORY_MODE) {
      await pool.query(`UPDATE sessions SET revoked = true WHERE id = $1`, [session.jti]);
    }
    clearCookie(res, 'session');
    res.json({ ok: true });
  });

  app.get('/auth/login/:provider', async (req, res) => {
    try {
      const provider = (req.params.provider as 'google'|'microsoft');
      if (provider !== 'google' && provider !== 'microsoft') return res.status(400).json({ error: 'invalid_provider' });

      const state = uuidv4();
      const nonce = uuidv4();
      const combo = `${state}.${nonce}`;
      const sig = signHmac(combo);
      setCookie(res, 'oidc_state', `${combo}.${sig}`, { maxAge: 600 });

      if (OIDC_DEV_MODE) {
        const email = provider === 'google' ? 'test.user@gmail.com' : 'test.user@microsoft.com';
        const sub = `dev-${provider}-sub-${state}`;
        const userId = await upsertUserAndAccount(provider, sub, email, 'Test User');
        const { jwt } = await issueSession(userId, email);
        setCookie(res, 'session', jwt, { maxAge: 7*24*3600 });
        return res.redirect(302, '/');
      }

      const url = buildAuthorizeUrl(provider, state, nonce);
      res.redirect(302, url);
    } catch (e) {
      logError('auth_login_error', e);
      res.status(500).json({ error: 'login_failed' });
    }
  });

  app.get('/auth/callback/:provider', async (req, res) => {
    try {
      const provider = (req.params.provider as 'google'|'microsoft');
      if (provider !== 'google' && provider !== 'microsoft') return res.status(400).json({ error: 'invalid_provider' });
      const code = req.query.code as string | undefined;
      const state = req.query.state as string | undefined;
      if (!code || !state) return res.status(400).json({ error: 'missing_code_or_state' });

      const cookies = parseCookies(req);
      const cookieState = cookies['oidc_state'];
      if (!cookieState) return res.status(400).json({ error: 'state_cookie_missing' });
      const parts = cookieState.split('.');
      if (parts.length < 3) return res.status(400).json({ error: 'state_invalid' });
      const combo = `${parts[0]}.${parts[1]}`;
      const sig = parts.slice(2).join('.');
      if (signHmac(combo) !== sig) return res.status(400).json({ error: 'state_tampered' });
      if (parts[0] !== state) return res.status(400).json({ error: 'state_mismatch' });

      if (OIDC_DEV_MODE) {
        const email = provider === 'google' ? 'test.user@gmail.com' : 'test.user@microsoft.com';
        const sub = `dev-${provider}-sub-${state}`;
        const userId = await upsertUserAndAccount(provider, sub, email, 'Test User');
        const { jwt } = await issueSession(userId, email);
        setCookie(res, 'session', jwt, { maxAge: 7*24*3600 });
        clearCookie(res, 'oidc_state');
        return res.redirect(302, '/');
      }

      const tokens = await exchangeCodeForTokens(provider, code);
      const cookieNonce = parts[1];
      const { sub, email, name } = await verifyProviderIdToken(provider, tokens.id_token, cookieNonce);

      const userId = await upsertUserAndAccount(provider, sub, email, name);
      const { jwt } = await issueSession(userId, email || 'user@example.com');
      setCookie(res, 'session', jwt, { maxAge: 7*24*3600 });
      clearCookie(res, 'oidc_state');
      res.redirect(302, '/');
    } catch (e) {
      logError('auth_callback_error', e);
      res.status(500).json({ error: 'callback_failed' });
    }
  });
}

// Billing helpers
async function getOrCreateStripeCustomer(orgId: string): Promise<string | null> {
  if (!stripe) return null;
  // Check subscriptions table for existing customer id
  const r = await pool.query(`SELECT stripe_customer_id FROM subscriptions WHERE org_id = $1`, [orgId]);
  const cur = r.rows[0];
  if (cur?.stripe_customer_id) return cur.stripe_customer_id as string;
  // Create a bare customer (email optional as we tie by org later)
  const customer = await stripe.customers.create({ metadata: { orgId } });
  const cid = customer.id as string;
  await pool.query(`INSERT INTO subscriptions (org_id, stripe_customer_id, status) VALUES ($1,$2,$3)
    ON CONFLICT (org_id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id`, [orgId, cid, 'incomplete']);
  return cid;
}
async function isOrgSubscriptionActive(orgId: string): Promise<boolean> {
  if (FREE_MODE) return true;
  const q = await pool.query(`SELECT status, current_period_end FROM subscriptions WHERE org_id = $1`, [orgId]);
  if (q.rows.length === 0) return false;
  const { status, current_period_end } = q.rows[0];
  if (status !== 'active') return false;
  if (current_period_end && new Date(current_period_end).getTime() < Date.now()) return false;
  return true;
}

// Billing routes
app.post('/billing/checkout', async (req, res) => {
  try {
    if (FREE_MODE) return res.status(403).json({ error: 'free_mode' });
    if (!stripe) return res.status(503).json({ error: 'stripe_not_configured' });
    const { orgId: bodyOrgId, priceId, qty = 1 } = req.body || {};
    const orgId = bodyOrgId || (req.headers['x-org-id'] as string);
    if (!orgId) return res.status(400).json({ error: 'orgId_required' });
    const pId = priceId || STRIPE_PRICE_PRO_29;
    if (!pId) return res.status(400).json({ error: 'priceId_required' });

    // Access control (optional): require auth membership when enabled
    if (AUTH_ENABLED) {
      const ok = await requireOrgMemberFromReq(req, res, orgId);
      if (!ok) return;
    }

    const customerId = await getOrCreateStripeCustomer(orgId);
    const success_url = `${DASHBOARD_URL}/billing/success?orgId=${encodeURIComponent(orgId)}`;
    const cancel_url = `${DASHBOARD_URL}/billing/cancel?orgId=${encodeURIComponent(orgId)}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId || undefined,
      line_items: [{ price: pId, quantity: qty }],
      success_url,
      cancel_url,
      metadata: { orgId },
    });
    res.json({ url: session.url });
  } catch (e) {
    logError('billing_checkout_error', e);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Stripe webhook: use raw body for signature verification
app.post('/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    if (FREE_MODE) return res.status(503).json({ error: 'free_mode' });
    if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(503).json({ error: 'stripe_not_configured' });
    const sig = req.headers['stripe-signature'];
    let event: any;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig as any, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      logError('stripe_webhook_signature_error', err);
      return res.status(400).send(`Webhook Error: ${(err as any)?.message || 'invalid_signature'}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const orgId = session.metadata?.orgId as string | undefined;
      const customerId = session.customer as string | undefined;
      if (orgId && customerId) {
        await pool.query(`INSERT INTO subscriptions (org_id, stripe_customer_id, status)
          VALUES ($1,$2,$3)
          ON CONFLICT (org_id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id, status = EXCLUDED.status`, [orgId, customerId, 'active']);
      }
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.created') {
      const sub = event.data.object;
      const customerId = sub.customer as string;
      const priceId = (sub.items?.data?.[0]?.price?.id) as string | undefined;
      const status = sub.status as string;
      const current_period_end = new Date((sub.current_period_end as number) * 1000).toISOString();
      const qty = sub.items?.data?.[0]?.quantity || 1;
      // Find org by customer id
      const q = await pool.query(`SELECT org_id FROM subscriptions WHERE stripe_customer_id = $1`, [customerId]);
      const orgId = q.rows[0]?.org_id as string | undefined;
      if (orgId) {
        await pool.query(`INSERT INTO subscriptions (org_id, stripe_customer_id, status, current_period_end, price_id, qty)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (org_id) DO UPDATE SET status=EXCLUDED.status, current_period_end=EXCLUDED.current_period_end, price_id=EXCLUDED.price_id, qty=EXCLUDED.qty`, [orgId, customerId, status, current_period_end, priceId ?? null, qty]);
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const customerId = sub.customer as string;
      const q = await pool.query(`SELECT org_id FROM subscriptions WHERE stripe_customer_id = $1`, [customerId]);
      const orgId = q.rows[0]?.org_id as string | undefined;
      if (orgId) {
        await pool.query(`UPDATE subscriptions SET status = $2 WHERE org_id = $1`, [orgId, 'canceled']);
      }
    }

    res.json({ received: true });
  } catch (e) {
    logError('stripe_webhook_error', e);
    res.status(500).json({ error: 'webhook_failed' });
  }
});

// Public billing status (used by dashboard)
app.get('/billing/status', async (req, res) => {
  try {
    const orgId = (req.query.orgId as string) || (req.headers['x-org-id'] as string);
    if (!orgId) return res.status(400).json({ error: 'orgId_required' });
    if (FREE_MODE) {
      return res.json({ orgId, subscription: null, free: true });
    }
    if (IN_MEMORY_MODE) {
      return res.json({ orgId, subscription: null, free: false });
    }
    const q = await pool.query(`SELECT status, current_period_end, price_id, qty FROM subscriptions WHERE org_id = $1`, [orgId]);
    const row = q.rows[0] || null;
    res.json({ orgId, subscription: row, free: false });
  } catch (e) {
    logError('billing_status_error', e);
    res.status(500).json({ error: 'Failed to get billing status' });
  }
});

app.get('/healthz', async (_req, res) => {
  if (IN_MEMORY_MODE) {
    return res.json({ status: 'ok', postgres: true, redis: true });
  }
  try {
    const pgOk = await pool.query('SELECT 1');
    const redisOk = await connection?.ping();
    res.json({ status: 'ok', postgres: pgOk?.rows?.[0]?.['?column?'] === 1 || true, redis: redisOk === 'PONG' });
  } catch (e) {
    logError('healthz_error', e);
    res.status(500).json({ status: 'error' });
  }
});

// Test seed endpoint (protected by ENABLE_TEST_SEED)
app.post('/test/seed', async (req, res) => {
  if (process.env.ENABLE_TEST_SEED !== '1') {
    return res.status(403).json({ error: 'seed_disabled' });
  }
  try {
    const orgId: string = (req.body?.orgId as string) || 'test-org';
    const siteId: string = (req.body?.siteId as string) || 'test-site';
    const viewport: Viewport = (req.body?.viewport as Viewport) || { w: 1366, h: 768 };
    const urls: string[] = Array.isArray(req.body?.urls) && req.body.urls.length > 0 ? req.body.urls : ['https://example.com'];

    const scanIds: string[] = [];

    const makeCounts = (critical: number, serious: number, moderate: number, minor: number, incomplete: number) => ({
      critical, serious, moderate, minor, incomplete,
      totalViolations: critical + serious + moderate + minor,
    });
    const makeScores = (overall: number): Scores => ({
      Perceivable: overall,
      Operable: overall,
      Understandable: overall,
      Robust: overall,
      Overall: overall,
    });

    // Seed three scans with varying impact to exercise diffs and majors
    for (let i = 0; i < 3; i++) {
      const scanId = uuidv4();
      await persistScan(scanId, orgId, siteId, urls, viewport, undefined, undefined, { seeded: true, index: i });

      let counts = makeCounts(0, 0, 0, 0, 0);
      let scores = makeScores(90);
      let findings: Finding[] = [];

      if (i === 0) {
        counts = makeCounts(0, 1, 0, 0, 0);
        scores = makeScores(88);
        findings = [{ url: urls[0], rule_id: 'color-contrast', sc: '1.4.3', impact: 'serious', selectors: [], excerpt: 'Low contrast', contrast_ratio: 2.0, advice: 'Increase contrast', partial: false }];
      } else if (i === 1) {
        counts = makeCounts(0, 0, 0, 0, 0);
        scores = makeScores(92);
        findings = [];
      } else {
        counts = makeCounts(1, 0, 0, 0, 0);
        scores = makeScores(80);
        findings = [{ url: urls[0], rule_id: 'link-name', sc: '2.4.4', impact: 'critical', selectors: [], excerpt: 'Link with no accessible name', contrast_ratio: null, advice: 'Add aria-label or descriptive text', partial: false }];
      }

      if (findings.length > 0) {
        await insertFindings(scanId, findings);
      }
      await updateScan(scanId, {
        status: 'completed',
        counts,
        scores,
        sample_stats: { min: 70, median: 85, mean: 85, max: 95, n: urls.length },
        meta: { seeded: true, chrome_version: 'HeadlessChrome/123.0.0.0' },
      });

      if (!IN_MEMORY_MODE) {
        await saveMetricsForScan(pool, scanId, scores);
        await computeAndPersistDiffForScan(pool, scanId);
      }

      scanIds.push(scanId);
    }

    res.json({ ok: true, siteId, scanIds });
  } catch (e) {
    logError('test_seed_error', e);
    res.status(500).json({ error: 'seed_failed' });
  }
});

app.post('/scans', async (req, res) => {
  if (IN_MEMORY_MODE) {
    return res.status(503).json({ error: 'disabled_in_memory' });
  }
  const body = req.body as ScanRequestBody;
  if (!body || !body.orgId || !body.siteId || !Array.isArray(body.urls) || body.urls.length === 0 || !body.viewport || typeof body.viewport.w !== 'number' || typeof body.viewport.h !== 'number') {
    return res.status(400).json({ error: 'Invalid body' });
  }
  const perPageMs = 30_000;
  const jobTimeout = Math.max(60_000, perPageMs * body.urls.length + 15_000);
  const jobsOptions: JobsOptions = { attempts: 2, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: true, removeOnFail: false };
  // Enforce org membership if auth enabled
  if (!(await requireOrgMemberFromReq(req, res, body.orgId))) {
    return;
  }
  try {
    const scanId = uuidv4();
    if (!scansQueue) throw new Error('queue_unavailable');
    const job = await scansQueue.add('scan', { ...body, scanId }, jobsOptions);
    log('job_enqueued', { jobId: job.id, orgId: body.orgId, siteId: body.siteId, urlCount: body.urls.length, timeoutHint: jobTimeout, scanId });
    res.json({ jobId: job.id, scanId });
  } catch (e) {
    logError('enqueue_failed', e);
    res.status(500).json({ error: 'Failed to enqueue job' });
  }
});

app.post('/scans/:id/export', async (req, res) => {
  if (IN_MEMORY_MODE) {
    return res.status(503).json({ error: 'disabled_in_memory' });
  }
  try {
    const scanId = req.params.id as string;
    // Load scan to obtain orgId and enforce membership
    const scan = await getScanById(scanId);
    if (!scan) return res.status(404).json({ error: 'scan_not_found' });
    if (!(await requireOrgMemberFromReq(req, res, scan.org_id))) {
      return;
    }
    if (!exportsQueue) throw new Error('queue_unavailable');
    const job = await exportsQueue.add('export', { scanId }, { removeOnComplete: true, attempts: 1 });
    res.json({ jobId: job.id });
  } catch (e) {
    logError('enqueue_export_failed', e);
    res.status(500).json({ error: 'Failed to enqueue export' });
  }
});

app.get('/scans/:id/artifacts', async (req, res) => {
  const { id } = req.params as { id: string };
  const orgId = (req.query.orgId as string) || (req.headers['x-org-id'] as string);
  if (!orgId) return res.status(400).json({ error: 'orgId_required' });
  try {
    const scan = await getScanById(id);
    if (!scan) return res.status(404).json({ error: 'scan_not_found' });
    if (!(await requireOrgMemberFromReq(req, res, scan.org_id))) {
      return;
    }

    if (IN_MEMORY_MODE) {
      try {
        const dir = path.join(ARTIFACTS_DIR, id);
        const names = await readdir(dir);
        const itemsPromises = names.map(async (name) => {
          const fp = path.join(dir, name);
          const s = await stat(fp);
          if (!s.isFile()) return null;
          const ext = path.extname(name).toLowerCase().replace('.', '');
          const type = ['json', 'csv', 'docx', 'zip'].includes(ext) ? ext : 'file';
          const buf = await readFile(fp);
          const hash = sha256OfBuffer(buf);
          return { name, type, hash, createdAt: s.mtime.toISOString() };
        });
        const items = (await Promise.all(itemsPromises)).filter(Boolean);
        return res.json({ items });
      } catch (err) {
        logError('artifacts_list_mem_error', err, { id });
        return res.json({ items: [] });
      }
    }

    const r = await pool.query('SELECT filename, type, sha256, created_at FROM artifacts WHERE scan_id = $1 ORDER BY created_at DESC', [id]);
    res.json({ items: r.rows.map((x: any) => ({ name: x.filename, type: x.type, hash: x.sha256, createdAt: x.created_at })) });
  } catch (e) {
    logError('artifacts_list_error', e);
    res.status(500).json({ error: 'Failed to list artifacts' });
  }
});
app.get('/scans/:id/artifacts/:filename', async (req, res) => {
  const { id, filename } = req.params as { id: string; filename: string };
  try {
    // If signed link is provided, validate it; otherwise require orgId and ownership
    const expStr = req.query.exp as string | undefined;
    const sig = req.query.sig as string | undefined;

    if (!(expStr && sig)) {
      const orgId = (req.query.orgId as string) || (req.headers['x-org-id'] as string);
      if (!orgId) return res.status(400).json({ error: 'orgId_required' });
      const scan = await getScanById(id);
      if (!scan) return res.status(404).json({ error: 'scan_not_found' });
      if (!(await requireOrgMemberFromReq(req, res, scan.org_id))) {
        return;
      }
    } else {
      const exp = Number(expStr);
      if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
        return res.status(403).json({ error: 'link_expired' });
      }
      const expected = hmacToken(id, filename, exp);
      if (expected !== sig) {
        return res.status(403).json({ error: 'invalid_signature' });
      }
    }

    if (IN_MEMORY_MODE) {
      const safeName = path.basename(filename);
      const filePath = path.join(ARTIFACTS_DIR, id, safeName);
      return res.sendFile(path.resolve(filePath));
    }

    const r = await pool.query('SELECT path FROM artifacts WHERE scan_id = $1 AND filename = $2 LIMIT 1', [id, filename]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'artifact_not_found' });
    const filePath = r.rows[0].path as string;

    res.sendFile(path.resolve(filePath));
  } catch (e) {
    logError('artifact_download_error', e, { id, filename });
    res.status(500).json({ error: 'Failed to download artifact' });
  }
});

app.get('/sites/:id/scans', async (req, res) => {
  const { id } = req.params as { id: string };
  const orgId = (req.query.orgId as string) || (req.headers['x-org-id'] as string);
  if (!orgId) return res.status(400).json({ error: 'orgId_required' });
  const limit = Math.max(1, Math.min(100, Number((req.query.limit as string) || '50')));
  if (!(await requireOrgMemberFromReq(req, res, orgId))) {
    return;
  }
  try {
    if (IN_MEMORY_MODE) {
      const items = scansMem
        .filter(s => s.site_id === id && s.org_id === orgId)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, limit)
        .map(s => ({
          id: s.id,
          status: s.status,
          createdAt: s.created_at,
          metrics: {
            global: s.scores?.Overall ?? null,
            perceivable: s.scores?.Perceivable ?? null,
            operable: s.scores?.Operable ?? null,
            understandable: s.scores?.Understandable ?? null,
            robust: s.scores?.Robust ?? null,
          },
          majors: ((s.counts?.critical || 0) + (s.counts?.serious || 0)) || 0,
        }));
      return res.json({ items });
    }
    const items = await listScansForSite(pool, id, limit, orgId);
    res.json({ items });
  } catch (e) {
    logError('list_scans_error', e, { siteId: id });
    res.status(500).json({ error: 'Failed to list scans' });
  }
});

app.get('/scans/:id/diff', async (req, res) => {
  const { id } = req.params as { id: string };
  const orgId = (req.query.orgId as string) || (req.headers['x-org-id'] as string);
  if (!orgId) return res.status(400).json({ error: 'orgId_required' });

  // Access control: ensure requester is member of the org when auth is enabled
  if (AUTH_ENABLED) {
    const ok = await requireOrgMemberFromReq(req, res, orgId);
    if (!ok) return;
  }

  try {
    if (IN_MEMORY_MODE) {
      // Build diff from memory
      const cur = scansMem.find(s => s.id === id && s.org_id === orgId);
      if (!cur) return res.status(404).json({ error: 'Diff not found' });
      const siteId = cur.site_id;
      const prev = scansMem
        .filter(s => s.site_id === siteId && s.org_id === orgId && s.status === 'completed' && s.id !== id)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0] || null;

      const curFindings = (findingsMem.get(id) || []).map(f => ({ ...f }));
      const prevFindings = prev ? (findingsMem.get(prev.id) || []).map(f => ({ ...f })) : [];

      const key = (f: Finding) => `${f.rule_id}|${f.sc || ''}`;
      const curMap = new Map<string, Finding>();
      const prevMap = new Map<string, Finding>();
      for (const f of curFindings) curMap.set(key(f), f);
      for (const f of prevFindings) prevMap.set(key(f), f);

      const newIssues: any[] = [];
      const resolvedIssues: any[] = [];
      const regressions: any[] = [];
      const principleCounts = { Perceivable: { new: 0, resolved: 0, regressions: 0 }, Operable: { new: 0, resolved: 0, regressions: 0 }, Understandable: { new: 0, resolved: 0, regressions: 0 }, Robust: { new: 0, resolved: 0, regressions: 0 } } as Record<string, any>;
      const majorImpacts = new Set(['serious', 'critical']);
      let newMajors = 0;

      for (const [k, cf] of curMap) {
        const pf = prevMap.get(k);
        const principle = ruleToPrinciple(cf.rule_id);
        if (!pf) {
          newIssues.push({ ruleId: cf.rule_id, sc: cf.sc, impact: cf.impact, principle });
          principleCounts[principle].new++;
          if (majorImpacts.has((cf.impact || '').toLowerCase())) newMajors++;
        } else {
          const wPrev = impactWeight(pf.impact);
          const wCur = impactWeight(cf.impact);
          if (wCur > wPrev) {
            regressions.push({ ruleId: cf.rule_id, sc: cf.sc, from: pf.impact, to: cf.impact, principle });
            principleCounts[principle].regressions++;
          }
        }
      }
      for (const [k, pf] of prevMap) {
        if (!curMap.has(k)) {
          const principle = ruleToPrinciple(pf.rule_id);
          resolvedIssues.push({ ruleId: pf.rule_id, sc: pf.sc, impact: pf.impact, principle });
          principleCounts[principle].resolved++;
        }
      }

      const diff = {
        siteId,
        scanId: id,
        previousScanId: prev?.id || null,
        summary: {
          new: newIssues.length,
          resolved: resolvedIssues.length,
          regressions: regressions.length,
          newMajors,
          byPrinciple: principleCounts,
        },
        newIssues,
        resolvedIssues,
        regressions,
      };
      return res.json(diff);
    }

    const scan = await getScanById(id);
    if (!scan) return res.status(404).json({ error: 'scan_not_found' });
    if (scan.org_id !== orgId) return res.status(403).json({ error: 'forbidden' });

    const diff = await getOrComputeDiffForScan(pool, id);
    if (!diff) return res.status(404).json({ error: 'Diff not found' });
    res.json(diff);
  } catch (e) {
    logError('get_diff_error', e, { scanId: id });
    res.status(500).json({ error: 'Failed to get diff' });
  }
});

// Evidence pack ZIP
app.post('/scans/:id/evidence', async (req, res) => {
  if (IN_MEMORY_MODE) {
    return res.status(503).json({ error: 'disabled_in_memory' });
  }
  try {
    const scanId = req.params.id as string;
    const orgId = (req.query.orgId as string) || (req.headers['x-org-id'] as string);
    if (!orgId) return res.status(400).json({ error: 'orgId_required' });

    // Access control: ensure requester is member of the org when auth is enabled
    if (AUTH_ENABLED) {
      const ok = await requireOrgMemberFromReq(req, res, orgId);
      if (!ok) return;
    }

    const scan = await getScanById(scanId);
    if (!scan) return res.status(404).json({ error: 'scan_not_found' });
    if (scan.org_id !== orgId) return res.status(403).json({ error: 'forbidden' });
    if (scan.status !== 'completed') return res.status(400).json({ error: 'scan_not_completed' });

    const findings = await getFindingsByScan(scanId);

    // Generate artifacts buffers
    const jsonBuf = await generateJsonArtifact(scan, findings);
    const csvBuf = await generateCsvArtifact(scan, findings);
    const docxBuf = await generateDocxArtifact(scan, findings);

    const jsonSha = sha256OfBuffer(jsonBuf);
    const csvSha = sha256OfBuffer(csvBuf);
    const docxSha = sha256OfBuffer(docxBuf);

    const zip = new JSZip();
    zip.file(`report-${scanId}.json`, jsonBuf);
    zip.file(`report-${scanId}.csv`, csvBuf);
    zip.file(`report-${scanId}.docx`, docxBuf);

    const manifest = {
      scanId,
      createdAt: new Date().toISOString(),
      axeVersion: AXE_VERSION,
      chromeVersion: scan.meta?.chrome_version || null,
      files: [
        { filename: `report-${scanId}.json`, sha256: jsonSha },
        { filename: `report-${scanId}.csv`, sha256: csvSha },
        { filename: `report-${scanId}.docx`, sha256: docxSha },
      ],
    };
    const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2));
    zip.file('manifest.json', manifestBuf);

    const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });
    const meta = await saveArtifact(scanId, 'zip', `evidence-${scanId}.zip`, zipBuf);

    const baseUrl = process.env.PUBLIC_BASE_URL || '';
    if (!baseUrl) return res.json({ filename: meta.filename });

    const url = makeSignedUrl(baseUrl, scanId, meta.filename, 24 * 3600);
    res.json({ url });
  } catch (e) {
    logError('evidence_error', e);
    res.status(500).json({ error: 'Failed to generate evidence pack' });
  }
});

// Declaration DOCX
app.post('/scans/:id/declaration', async (req, res) => {
  try {
    const scanId = req.params.id as string;
    const orgId = (req.query.orgId as string) || (req.headers['x-org-id'] as string);
    if (!orgId) return res.status(400).json({ error: 'orgId_required' });

    // Access control: ensure requester is member of the org when auth is enabled
    if (AUTH_ENABLED) {
      const ok = await requireOrgMemberFromReq(req, res, orgId);
      if (!ok) return;
    }

    const scan = await getScanById(scanId);
    if (!scan) return res.status(404).json({ error: 'scan_not_found' });
    if (scan.org_id !== orgId) return res.status(403).json({ error: 'forbidden' });
    if (scan.status !== 'completed') return res.status(400).json({ error: 'scan_not_completed' });

    const findings = await getFindingsByScan(scanId);
    const docxBuf = await generateDocxArtifact(scan, findings);
    const meta = await saveArtifact(scanId, 'docx', `declaration-${scanId}.docx`, docxBuf);

    const baseUrl = process.env.PUBLIC_BASE_URL || '';
    if (!baseUrl) return res.json({ filename: meta.filename });

    const url = makeSignedUrl(baseUrl, scanId, meta.filename, 24 * 3600);
    res.json({ url });
  } catch (e) {
    logError('declaration_error', e);
    res.status(500).json({ error: 'Failed to generate declaration' });
  }
});

// Schedules CRUD
app.post('/schedules', async (req, res) => {
  try {
    if (IN_MEMORY_MODE) return res.status(503).json({ error: 'disabled_in_memory' });
    const { orgId: bodyOrgId, siteId, type, every_ms, cron, timezone, active = true, limit } = req.body || {};
    const orgId = bodyOrgId || (req.headers['x-org-id'] as string);
    if (!orgId) return res.status(400).json({ error: 'orgId_required' });
    if (!siteId) return res.status(400).json({ error: 'siteId_required' });
    if (type !== 'every' && type !== 'cron') return res.status(400).json({ error: 'invalid_type' });
    if (type === 'every' && (!every_ms || Number(every_ms) <= 0)) return res.status(400).json({ error: 'invalid_every_ms' });
    if (type === 'cron' && !cron) return res.status(400).json({ error: 'invalid_cron' });

    // Access control: ensure requester is member of the org when auth is enabled
    if (AUTH_ENABLED) {
      const ok = await requireOrgMemberFromReq(req, res, orgId);
      if (!ok) return;
    }
    // Gatekeeping: allow only active subscription to create schedules
    const subActive = await isOrgSubscriptionActive(orgId);
    if (!subActive) return res.status(402).json({ error: 'subscription_inactive' });

    const id = uuidv4();
    const r = await pool.query(
      `INSERT INTO schedules (id, org_id, site_id, type, every_ms, cron, timezone, active, run_limit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, org_id, site_id, type, every_ms, cron, timezone, active, run_limit AS limit, created_at`,
      [id, orgId, siteId, type, every_ms ?? null, cron ?? null, timezone ?? null, active === true, limit ?? null]
    );
    const row = r.rows[0];
    await upsertSchedulerForRow(row);
    res.status(201).json(row);
  } catch (e) {
    logError('schedules_create_error', e);
    res.status(500).json({ error: 'Failed to create schedule' });
  }
});

app.patch('/schedules/:id', async (req, res) => {
  try {
    if (IN_MEMORY_MODE) return res.status(503).json({ error: 'disabled_in_memory' });
    const id = req.params.id as string;
    const { orgId: bodyOrgId } = req.body || {};
    const orgId = bodyOrgId || (req.headers['x-org-id'] as string);
    if (!orgId) return res.status(400).json({ error: 'orgId_required' });

    // Access control: ensure requester is member of the org when auth is enabled
    if (AUTH_ENABLED) {
      const ok = await requireOrgMemberFromReq(req, res, orgId);
      if (!ok) return;
    }

    const curQ = await pool.query(`SELECT * FROM schedules WHERE id = $1`, [id]);
    if (curQ.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    const cur = curQ.rows[0];
    if (cur.org_id !== orgId) return res.status(403).json({ error: 'forbidden' });

    const u = req.body || {};
    const next = {
      type: u.type ?? cur.type,
      every_ms: u.every_ms ?? cur.every_ms,
      cron: u.cron ?? cur.cron,
      timezone: u.timezone ?? cur.timezone,
      active: u.active ?? cur.active,
      limit: u.limit ?? cur.limit,
    };
    if (next.type !== 'every' && next.type !== 'cron') return res.status(400).json({ error: 'invalid_type' });
    if (next.type === 'every' && (!next.every_ms || Number(next.every_ms) <= 0)) return res.status(400).json({ error: 'invalid_every_ms' });
    if (next.type === 'cron' && !next.cron) return res.status(400).json({ error: 'invalid_cron' });

    // Gatekeeping: if enabling or keeping schedule active, require active subscription
    const canProceed = await isOrgSubscriptionActive(orgId);
    if (!canProceed && next.active === true) return res.status(402).json({ error: 'subscription_inactive' });

    const r = await pool.query(
      `UPDATE schedules SET type=$2, every_ms=$3, cron=$4, timezone=$5, active=$6, run_limit=$7 WHERE id=$1 RETURNING id, org_id, site_id, type, every_ms, cron, timezone, active, run_limit AS limit, created_at`,
      [id, next.type, next.every_ms ?? null, next.cron ?? null, next.timezone ?? null, next.active === true, next.limit ?? null]
    );
    const row = r.rows[0];
    if (row.active) await upsertSchedulerForRow(row); else await removeSchedulerById(id);
    res.json(row);
  } catch (e) {
    logError('schedules_patch_error', e);
    res.status(500).json({ error: 'Failed to update schedule' });
  }
});

app.delete('/schedules/:id', async (req, res) => {
  try {
    if (IN_MEMORY_MODE) return res.status(503).json({ error: 'disabled_in_memory' });
    const id = req.params.id as string;
    const orgId = (req.query.orgId as string) || (req.headers['x-org-id'] as string);
    if (!orgId) return res.status(400).json({ error: 'orgId_required' });

    // Access control: ensure requester is member of the org when auth is enabled
    if (AUTH_ENABLED) {
      const ok = await requireOrgMemberFromReq(req, res, orgId);
      if (!ok) return;
    }

    const curQ = await pool.query(`SELECT * FROM schedules WHERE id = $1`, [id]);
    if (curQ.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    const cur = curQ.rows[0];
    if (cur.org_id !== orgId) return res.status(403).json({ error: 'forbidden' });

    // No gatekeeping needed for delete (allowed even if inactive)
    await pool.query(`DELETE FROM schedules WHERE id = $1`, [id]);
    await removeSchedulerById(id);
    res.json({ ok: true });
  } catch (e) {
    logError('schedules_delete_error', e);
    res.status(500).json({ error: 'Failed to delete schedule' });
  }
});

// START: Artifact purge utilities
const ARTIFACTS_RETENTION_DAYS = process.env.ARTIFACTS_RETENTION_DAYS ? Number(process.env.ARTIFACTS_RETENTION_DAYS) : 365;
const ARTIFACTS_PURGE_INTERVAL_HOURS = process.env.ARTIFACTS_PURGE_INTERVAL_HOURS ? Number(process.env.ARTIFACTS_PURGE_INTERVAL_HOURS) : 24;

async function purgeExpiredArtifacts() {
  const cutoff = new Date(Date.now() - ARTIFACTS_RETENTION_DAYS * 24 * 3600 * 1000);
  try {
    // Always attempt filesystem cleanup
    const { readdir, stat, unlink, rm } = await import('fs/promises');
    const scanDirs = await readdir(ARTIFACTS_DIR, { withFileTypes: true }).catch(() => [] as any);
    for (const dirent of scanDirs) {
      if (!dirent.isDirectory()) continue;
      const scanId = dirent.name;
      const dirPath = path.join(ARTIFACTS_DIR, scanId);
      const files = await readdir(dirPath, { withFileTypes: true }).catch(() => [] as any);
      for (const file of files) {
        if (!file.isFile()) continue;
        const filePath = path.join(dirPath, file.name);
        try {
          const st = await stat(filePath);
          if (st.mtime < cutoff) {
            await unlink(filePath).catch(() => {});
          }
        } catch {
          // ignore fs errors for individual files
        }
      }
      // Remove directory if empty
      try {
        const remaining = await readdir(dirPath);
        if (!remaining.length) {
          await rm(dirPath, { recursive: true, force: true }).catch(() => {});
        }
      } catch {
        // ignore
      }
    }

    // If DB mode, also delete records
    if (!IN_MEMORY_MODE) {
      const res = await pool.query('SELECT id, scan_id, path FROM artifacts WHERE created_at < $1', [cutoff]);
      const ids: number[] = res.rows.map((r: any) => r.id);
      for (const row of res.rows) {
        try {
          await import('fs/promises').then(fs => fs.unlink(row.path).catch(() => {}));
        } catch {
          // ignore
        }
      }
      if (ids.length) {
        await pool.query('DELETE FROM artifacts WHERE id = ANY($1)', [ids]);
      }
    }
    log('artifacts_purged', { before: cutoff.toISOString() });
  } catch (e) {
    logError('artifacts_purge_error', e);
  }
}

function startArtifactsPurger() {
  // Run once on boot
  purgeExpiredArtifacts();
  // Schedule periodic purge
  const intervalMs = ARTIFACTS_PURGE_INTERVAL_HOURS * 3600 * 1000;
  setInterval(purgeExpiredArtifacts, Math.max(1, intervalMs));
}
// END: Artifact purge utilities
(async () => {
  try {
    if (!IN_MEMORY_MODE) {
      await ensureSchema();
    }
    // Restore active schedules after ensuring schema
    if (!IN_MEMORY_MODE) {
      await bootstrapActiveSchedules();
    }
    // Start background purger
    startArtifactsPurger();
    app.listen(PORT, () => {
      log('server_started', { port: PORT, mode: IN_MEMORY_MODE ? 'memory' : 'db' });
    });
  } catch (e) {
    logError('server_start_error', e);
    process.exit(1);
  }
})();

export default app;

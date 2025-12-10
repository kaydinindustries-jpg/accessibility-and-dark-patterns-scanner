## Future Feature: Backend-Driven Multi-Scan (Batch Scans)

This document captures the design for a future **paid** feature: batch scanning multiple URLs via the backend, instead of doing one-page-at-a-time scans from the extension.

The goal is to support:
- Accessibility pre-audit (WCAG/EAA)
- Dark pattern analysis (Watchdog)

for **lists of URLs** in a scalable, B2B-friendly way.

---

## High-Level Idea

Instead of trying to make the **extension popup** crawl multiple pages, we:

1. Let the user define:
   - A list of URLs
   - A perimeter/label
   - A scan type:
     - `accessibility`
     - `dark_patterns`
     - `both`
2. Send this configuration to the **backend scanner**.
3. The backend:
   - Runs headless Chrome/Puppeteer on each URL
   - Executes the appropriate checks
   - Persists results in Postgres
4. A dashboard (Next.js) shows:
   - Jobs (pending/running/completed/failed)
   - Per-URL results and history
   - Aggregated metrics (scores, pattern counts)

The extension becomes:
- A **page-level inspector** (quick scans, highlights)
- A **trigger / viewer** for backend jobs (batch scans + history)

---

## Data Flow (Batch Scan)

```mermaid
flowchart LR
  Popup[Extension Popup] -->|POST /batch-scans| BackendAPI
  BackendAPI[Scanner Backend] --> Queue[Job Queue (BullMQ)]
  Queue --> Worker[Headless Chrome Workers]
  Worker --> PG[(Postgres)]
  PG --> Dashboard[Web Dashboard]
  Dashboard -->|GET /batch-scans/:id| User
```

### 1. Popup → Backend

New API (backend, scanner service):

- `POST /batch-scans`
  - Body:
    - `orgId: string`
    - `siteId: string`
    - `urls: string[]`
    - `mode: "accessibility" | "dark_patterns" | "both"`
    - `viewport: { w: number; h: number; deviceScaleFactor?: number }`
    - `label?: string` (perimeter, campaign, etc.)
  - Response:
    - `{ batchId: string }`

The extension popup will **not** scan pages directly in this mode; it will just:
- Send the configuration
- Show “Batch scan requested (see dashboard)”

### 2. Backend: Batch Scan Model

Tables (Postgres, scanner DB):

- `batch_scans`
  - `id UUID PRIMARY KEY`
  - `org_id TEXT`
  - `site_id TEXT`
  - `mode TEXT` (`'accessibility'|'dark_patterns'|'both'`)
  - `label TEXT`
  - `urls JSONB` (array of URLs)
  - `status TEXT` (`'pending'|'running'|'completed'|'failed'`)
  - `created_at TIMESTAMPTZ`
  - `completed_at TIMESTAMPTZ`

- `batch_scan_items`
  - `id BIGSERIAL PRIMARY KEY`
  - `batch_id UUID REFERENCES batch_scans(id) ON DELETE CASCADE`
  - `url TEXT`
  - `status TEXT` (`'pending'|'running'|'completed'|'failed'`)
  - `accessibility_scan_id UUID NULL` (link to `scans` table)
  - `dark_scan_id UUID NULL` (link to future `dark_scans` table or reuse)
  - `created_at TIMESTAMPTZ`
  - `updated_at TIMESTAMPTZ`

Existing tables (`scans`, `findings`, etc.) are reused for **accessibility** results.

For **dark patterns**, we either:
- Reuse existing `scans` + `findings` with a discriminator, or
- Create a dedicated table `dark_scans` (similar shape to what we store in IndexedDB now).

### 3. Job Queue

For each URL in the batch:

- Enqueue a job `batch-scan-item` with:
  - `batchId`
  - `itemId`
  - `url`
  - `mode`
  - `viewport`

Workers:

- If `mode` includes `accessibility`:
  - Run existing `scanUrl()` (Puppeteer + axe-core)
  - Persist in `scans` + `findings`
  - Update `batch_scan_items.accessibility_scan_id`

- If `mode` includes `dark_patterns`:
  - Load the page with Puppeteer
  - Inject a server-side version of `darkPatternsContent`:
    - Equivalent of `collectDarkPatternCandidates(document, options)`
    - Possibly via `page.addScriptTag({ path: "dist/darkPatternsContent.bundle.js" })`
    - Evaluate `collectDarkPatternCandidates()` in the page context
  - Call `/api/analyze-ui` with the candidates
  - Persist dark pattern result:
    - Either in a `dark_scans` table, or as JSON tied to `batch_scan_items`

Once all items are processed:
- Update `batch_scans.status = 'completed'` + `completed_at`.

---

## API Surfaces

### Backend

- `POST /batch-scans`
  - Create batch, enqueue jobs, return `batchId`.

- `GET /batch-scans/:id`
  - Summary:
    - `status`
    - `mode`
    - `urls`
    - `items[]` (with per-URL status + scores/pattern counts)

- `GET /batch-scans/:id/export`
  - Generate:
    - JSON: raw data + metadata
    - CSV: one row per URL (scores + counts)
    - DOCX/HTML: high-level report for management

### Extension

Future popup (paid version):

- New section “Batch Scan (SaaS / Enterprise)”:
  - Textarea: URLs (one per line)
  - Select: mode (Accessibility / Dark Patterns / Both)
  - Button: “Start batch scan”
  - On click:
    - Call backend `POST /batch-scans`
    - Show “Batch scan requested. Open dashboard to follow progress.”

Extension **does not manage** long-running jobs or per-URL progress. That is handled by the dashboard.

---

## Dashboard (Next.js)

Views:

1. **Batch list**
   - Paginated list of batches (org/site)
   - Columns:
     - Label / perimeter
     - Mode
     - Number of URLs
     - Status
     - Created / Completed at

2. **Batch detail**
   - List of URLs with:
     - Status (pending/running/completed/failed)
     - Accessibility score (if available)
     - Number of dark patterns (if available)
     - Links to detailed reports (existing `/scans/:id`, dark reports)

3. **Exports**
   - Buttons to download:
     - JSON
     - CSV
     - DOCX/HTML

---

## Integration with Current Codebase

- Reuse:
  - `scanUrl()` and `computeScores()` from `scanner/src/index.ts`
  - `AnalyzeUIRequest` + `/api/analyze-ui` for dark patterns LLM
  - Existing `scans` + `findings` tables for accessibility
  - Existing evidence/export machinery (JSON/CSV/DOCX/ZIP)

- New:
  - `batch_scans` + `batch_scan_items` tables
  - `batch-scan-item` worker
  - `dark_scans` table or equivalent
  - Endpoint `POST /batch-scans`
  - Basic pages in Next.js dashboard (or API-only for now)

---

## MVP Scope (Paid v1)

1. **Create batch scan from dashboard** (not from extension)
2. **Accessibility-only** batch scans (reuse existing `scanUrl`)
3. **Dark pattern batch scans** using server-side `darkPatternsContent`
4. **Summary view + exports**

Later:
1. Trigger batch scan from extension popup.
2. Enterprise features (orgs, billing, RBAC).



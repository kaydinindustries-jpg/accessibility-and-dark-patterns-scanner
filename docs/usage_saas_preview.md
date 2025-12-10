# Usage Guide - SaaS Preview

## Introduction

This guide explains how to use the **Accessibility & Dark Pattern Watchdog** for B2B pre-audit scenarios. This tool is designed for e-commerce and SaaS companies (€1M–€50M revenue) who need to:

1. **Pre-audit** their UI for WCAG/EAA accessibility compliance
2. **Detect** potential dark patterns before regulatory scrutiny
3. **Export** findings for internal compliance discussions

**Important**: This is a technical pre-audit tool, not a legal certification or compliance guarantee.

---

## Installation

### Chrome Extension

1. Clone the repository:
   ```bash
   git clone https://github.com/your-org/accessibility-and-dark-patterns-scanner.git
   cd accessibility-and-dark-patterns-scanner
   ```

2. Load the extension in Chrome:
   - Open `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the repository root folder

3. (Optional) Configure backend URL:
   - Open Chrome DevTools console
   - Run:
     ```javascript
     chrome.storage.sync.set({ backendUrl: "https://your-backend-url.com" })
     ```

### Backend Scanner (Optional)

For full dark patterns analysis with OpenAI:

1. Install dependencies:
   ```bash
   cd scanner
   npm install
   ```

2. Set environment variables:
   ```bash
   export OPENAI_API_KEY=sk-...
   export OPENAI_MODEL=gpt-4o-mini
   export PORT=3000
   ```

3. Run the server:
   ```bash
   npm run build
   npm start
   ```

4. Configure extension to use your backend (see above)

**Mock Mode** (no backend required):
```javascript
chrome.storage.sync.set({ useMockBackend: true })
```

---

## Basic Usage

### 1. Accessibility Scan

1. Navigate to your website page (e.g., homepage, checkout, product page)
2. Click the extension icon in Chrome toolbar
3. Click **"Scan"** button
4. Open **"Side Panel"** for detailed view
5. Review findings:
   - Overall score (0–100)
   - Principle scores (Perceivable, Operable, Understandable, Robust)
   - Violations by severity (Critical, Serious, Moderate, Minor)
   - WCAG/EN 301 549 references

### 2. Dark Patterns Scan

1. Navigate to the page you want to analyze
2. Open the **Side Panel**
3. Switch to **"Dark Patterns"** tab
4. Click **"Scan dark patterns"**
5. Wait for analysis (5–30 seconds depending on backend/mock mode)
6. Review findings:
   - Pattern type (cookie_nudge, roach_motel, etc.)
   - Risk level (low, medium, high)
   - Explanation (2–4 sentences)
   - Suggested fix
   - Legal references (DSA, GDPR, etc.)

### 3. Highlight in Page

For each dark pattern finding:
- Click **"Voir dans la page"** button
- The element will be highlighted with a red outline
- The page will scroll to the element
- Highlight fades after 3.5 seconds

---

## Typical Workflows

### Workflow 1: Pre-Launch Audit

**Goal**: Audit key pages before launching a new feature

**Steps**:
1. Define your WCAG-EM sample (see WCAG-EM Sampling section)
2. Scan each page in the sample:
   - Homepage
   - Product Listing Page
   - Product Detail Page
   - Cart
   - Checkout
   - Account/Settings
3. Run both **Accessibility** and **Dark Patterns** scans on each page
4. Export findings (JSON/CSV/DOC) for each page
5. Consolidate findings in internal report
6. Prioritize fixes by:
   - Accessibility: Critical + Serious violations first
   - Dark Patterns: High risk patterns first
7. Re-scan after fixes to validate improvements

**Deliverable**: Consolidated report showing scores, violations, and dark patterns across key user journeys.

---

### Workflow 2: Competitor Analysis

**Goal**: Compare your UI to competitors for compliance risk

**Steps**:
1. Scan competitor checkout flows
2. Scan competitor cookie banners
3. Scan competitor subscription/cancellation pages
4. Export findings for each competitor
5. Compare:
   - Which competitors use similar patterns?
   - What are the risk levels?
   - What fixes do they implement?
6. Document best practices observed
7. Apply learnings to your own product

**Deliverable**: Competitive landscape report with screenshots and risk analysis.

---

### Workflow 3: Ongoing Monitoring

**Goal**: Catch regressions or new issues after updates

**Steps**:
1. Establish baseline scans (before update)
2. After each release:
   - Re-scan key pages
   - Compare scores and findings to baseline
   - Flag any new violations or patterns
3. Export diff reports showing:
   - Score changes
   - New violations
   - Resolved issues
4. Review high-risk changes with Product/Legal
5. Fix critical regressions immediately

**Deliverable**: Release-over-release trend report.

---

## WCAG-EM Sampling

For comprehensive audits, define your sample using WCAG-EM methodology:

1. **Perimeter**: E-commerce flow, marketing site, admin dashboard, etc.

2. **Sample URLs**: List key pages (one per line in popup)
   - Homepage: `https://example.com/`
   - Category: `https://example.com/products/category`
   - Product: `https://example.com/products/item-123`
   - Cart: `https://example.com/cart`
   - Checkout: `https://example.com/checkout`
   - Confirmation: `https://example.com/order-confirmation`

3. **Save Sampling**: Click "Save sampling" in popup

4. **View Sample Stats**: After scanning multiple pages, the summary shows:
   - Min/median/mean/max scores across sample
   - Coverage (n pages scanned)

---

## Export Formats

### JSON Export

**Use case**: Import into BI tools, databases, or custom reporting

**Contents**:
- Metadata (timestamp, sample, perimeter)
- Scores (overall, principles)
- Findings array (rule, WCAG ref, impact, selectors, snippets, contrast)

### CSV Export

**Use case**: Excel analysis, pivot tables, filtering

**Contents**:
- One row per finding
- Columns: timestamp, URL, principle, WCAG, EN 301 549, impact, selectors, snippet, weight, contrast

### DOC Export

**Use case**: Share with stakeholders (Product, Legal, Compliance)

**Contents**:
- Executive summary (scores, counters)
- Sample & perimeter
- Findings details (grouped by severity)
- WCAG/EN 301 549 references

**Format**: HTML saved as `.doc` (opens in Word/LibreOffice)

---

## Interpreting Results

### Accessibility Scores

- **90–100**: Excellent, few issues
- **70–89**: Good, some improvements needed
- **50–69**: Fair, significant work required
- **<50**: Poor, major accessibility barriers

**Note**: A score of 100 does NOT mean full WCAG conformance. Manual testing (keyboard, screen readers, user testing) is still required.

### Dark Pattern Risk Levels

- **High**: Strong regulatory risk, likely violates DSA/GDPR/consumer law
  - **Action**: Fix immediately, escalate to Legal
- **Medium**: Potentially problematic, may confuse users
  - **Action**: Review with Product/UX, consider redesign
- **Low**: Minor concern, unlikely to be enforced
  - **Action**: Note for future improvement

### Confidence Levels

Each dark pattern finding has a confidence score:
- **0.9–1.0**: Very confident (clear pattern)
- **0.7–0.89**: Confident (likely pattern)
- **0.5–0.69**: Moderate (review recommended)
- **<0.5**: Low confidence (may be false positive)

**Manual review recommended for medium/low confidence findings**.

---

## Common Scenarios

### Scenario: Cookie Banner

**Scan**: Homepage

**Expected findings**:
- **Accessibility**: Missing focus indicators, poor contrast on buttons
- **Dark Pattern**: `cookie_nudge` if "Accept" is prominent and "Reject" is hidden

**Fix**:
- Make "Accept" and "Reject" buttons equally visible
- Ensure keyboard navigation works
- Provide clear "Reject all" option without additional clicks

---

### Scenario: Checkout Flow

**Scan**: Cart, Checkout pages

**Expected findings**:
- **Accessibility**: Form labels missing, error messages unclear
- **Dark Pattern**: `preselected_addon` if insurance/upsells are pre-checked

**Fix**:
- Uncheck all optional addons by default
- Clearly label what is included vs. optional
- Display total price prominently

---

### Scenario: Account Cancellation

**Scan**: Account settings, subscription management

**Expected findings**:
- **Accessibility**: Links not keyboard-accessible, poor focus management
- **Dark Pattern**: `roach_motel` if cancel link is tiny/hidden

**Fix**:
- Make "Cancel subscription" a clear, prominent button
- Allow cancellation in 1–2 clicks max
- Do not require phone call or email to cancel

---

## Limitations & Best Practices

### Limitations

1. **Local scans only**: Does not test server-side logic, A/B tests, or geo-targeted variants
2. **No user testing**: Cannot measure actual confusion or manipulation
3. **Heuristic-based**: May produce false positives or miss sophisticated patterns
4. **English V1**: Keyword matching is English-only in V1
5. **Static analysis**: Does not test dynamic flows or multi-step processes

### Best Practices

1. **Combine with manual testing**: Use this tool as a first pass, then test with real users
2. **Review legal references**: Findings cite DSA/GDPR/etc., but consult a lawyer for compliance
3. **Iterate**: Scan → Fix → Re-scan to validate improvements
4. **Document**: Export findings and keep audit trail for compliance evidence
5. **Don't over-rely on scores**: A high score doesn't mean full compliance, a low score doesn't mean lawsuits

---

## Getting Help

### Technical Issues

- Extension not loading: Check `chrome://extensions/` for errors
- Backend connection fails: Verify `backendUrl` in config, check CORS settings
- Scans timeout: Increase `requestTimeoutMs` in config, or use mock mode

### False Positives

If the tool flags something that's not actually a dark pattern:
- Review the confidence score (low confidence = more likely false positive)
- Check the explanation and legal refs
- Manually validate with UX/Legal team
- Provide feedback for future improvement

### Feature Requests

This is a V1 preview. Future improvements may include:
- Multi-language support
- Dynamic flow testing
- A/B test detection
- API for CI/CD integration
- White-label reports

---

## Next Steps

1. **Scan your key pages** (homepage, checkout, account)
2. **Export findings** (JSON, CSV, DOC)
3. **Review with Product/Legal** teams
4. **Prioritize fixes** (high risk + critical violations first)
5. **Re-scan after fixes** to validate improvements
6. **Document process** for audit trail

**Questions?** Contact your account manager or open an issue in the repository.


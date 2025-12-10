# Accessibility & Dark Pattern Watchdog

Chrome extension (MV3) for **B2B pre-audit** of accessibility (WCAG 2.2 / EAA) and dark patterns (DSA / consumer protection).

## Features

### 1. Accessibility Scanner (100% Local)
- **WCAG 2.2 / EN 301 549** compliance pre-audit
- Powered by **axe-core** (local, no network)
- Custom contrast measurement (normal/hover/focus states)
- Scoring by WCAG principles (Perceivable, Operable, Understandable, Robust)
- WCAG-EM sampling support
- Export: JSON, CSV, DOC

### 2. Dark Pattern Watchdog (Backend + AI)
- Detects 6 pattern types:
  - **Cookie nudge**: Manipulative consent banners
  - **Roach motel**: Hard-to-cancel subscriptions
  - **Preselected addons**: Pre-checked upsells
  - **Hidden information**: Fine print terms
  - **Misleading labels**: Confusing wording
  - **AI manipulation**: Biased AI recommendations
- Risk levels: Low, Medium, High
- Legal references: DSA Art. 25, GDPR, AI Act
- Powered by OpenAI (gpt-4o-mini) or mock mode for dev
- Highlight in-page + export findings

## Installation

### Extension

1. Clone repository:
   ```bash
   git clone https://github.com/your-org/accessibility-and-dark-patterns-scanner.git
   cd accessibility-and-dark-patterns-scanner
   ```

2. Download axe-core (if not present):
   ```bash
   # axe-core is already included in libs/axe.min.js
   ```

3. Load extension:
   - Open `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select repository root folder

### Backend (Optional, for Dark Patterns)

```bash
cd scanner
npm install
npm run build

# Set environment variables
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-4o-mini
export PORT=3000

# Start server
npm start
```

Configure extension to use your backend:
```javascript
chrome.storage.sync.set({ backendUrl: "http://localhost:3000" })
```

**Mock mode** (no backend required):
```javascript
chrome.storage.sync.set({ useMockBackend: true })
```

## Usage

### Accessibility Scan
1. Navigate to your page
2. Click extension icon → **"Scan"**
3. Open **"Side Panel"** → **"Accessibility"** tab
4. Review scores, violations, export findings

### Dark Patterns Scan
1. Navigate to your page
2. Open **"Side Panel"** → **"Dark Patterns"** tab
3. Click **"Scan dark patterns"**
4. Review findings, highlight in page, export report

## Documentation

- **[Dark Patterns V1 Taxonomy](docs/dark_patterns_v1.md)**: Pattern definitions, detection heuristics, legal references
- **[Usage Guide (SaaS Preview)](docs/usage_saas_preview.md)**: Workflows, export formats, best practices
- **[Test Pages](test-pages/README.md)**: HTML test pages for each pattern type

## Permissions

- `activeTab`: Inject scripts into current tab
- `scripting`: Run axe-core and dark pattern heuristics
- `storage`: Store scan history and config
- `downloads`: Export reports (JSON/CSV/DOC)
- `offscreen`: Generate reports in background
- `sidePanel`: Display detailed findings

## Limits & Disclaimers

### Accessibility
- **Local only**: Respects CSP, may not scan cross-origin iframes
- **Automated testing limits**: Cannot catch all WCAG issues (e.g., semantic correctness, user testing)
- **Not a certification**: This is a technical pre-audit, not legal compliance guarantee

### Dark Patterns
- **Heuristic-based**: May produce false positives or miss sophisticated patterns
- **V1 scope**: English keywords only, no multi-language support yet
- **No legal advice**: Findings cite regulations (DSA, GDPR, AI Act) but consult a lawyer for compliance
- **Context-dependent**: Same UI may be compliant or not based on context
- **No user testing**: Cannot measure actual confusion or manipulation

## Test Pages

Test the scanner with provided HTML pages:
```bash
open test-pages/cookie_nudge_bad.html
# Then scan with extension
```

## Architecture

```
├── manifest.json           # Chrome extension manifest (MV3)
├── service_worker.js       # Background script (scan orchestration)
├── darkPatternsContent.js  # Content script (DOM heuristics)
├── config.js               # Runtime config (backend URL, flags)
├── storage.js              # IndexedDB (scan history)
├── popup.html/js           # Extension popup
├── sidepanel.html/js/css   # Side panel UI (Accessibility + Dark Patterns tabs)
├── exporter.js             # Offscreen DOC/CSV/JSON generator
├── libs/axe.min.js         # axe-core library
├── scanner/                # Backend API
│   ├── src/
│   │   ├── index.ts        # Express server
│   │   ├── schema.ts       # Zod schemas
│   │   ├── routes/analyze-ui.ts  # POST /api/analyze-ui
│   │   └── services/openaiClient.ts  # OpenAI integration
│   └── package.json
├── test-pages/             # HTML test pages
└── docs/                   # Documentation
    ├── dark_patterns_v1.md
    └── usage_saas_preview.md
```

## Development

### Extension
```bash
# Make changes to extension files
# Reload extension in chrome://extensions/
```

### Backend
```bash
cd scanner
npm run build
npm start
# Or: npm run dev (ts-node)
```

### Test Pages
```bash
# Open any test page in Chrome
open test-pages/cookie_nudge_bad.html
# Scan with extension
```

## Target Audience

- **E-commerce & SaaS** companies (€1M–€50M revenue)
- **Product teams**: Pre-launch audits, design validation
- **Legal/Compliance**: Risk assessment, regulatory preparation (EAA, DSA, GDPR)
- **Developers**: WCAG + dark pattern checks in development

## Privacy & Security

- **Accessibility scans**: 100% local, no network, no telemetry
- **Dark pattern scans**: Sends DOM snippets + text to backend (hash URL in logs)
- **No API keys in extension**: OpenAI key stays on backend
- **No user tracking**: No analytics, no telemetry, no data collection

## License

[Specify your license, e.g., MIT, Apache 2.0, or proprietary]

## Contributing

[Specify contribution guidelines if open-source]

## Support

For technical issues or feature requests:
- Open an issue in this repository
- Contact: [your-email@example.com]

---

**Disclaimer**: This tool provides a technical pre-audit to help identify potential accessibility barriers and dark patterns. It does not guarantee legal compliance with WCAG, EAA, DSA, GDPR, AI Act, or any other regulation. Consult legal and accessibility professionals for certification and compliance validation.
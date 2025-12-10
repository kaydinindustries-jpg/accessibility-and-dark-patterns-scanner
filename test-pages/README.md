# Dark Patterns Test Pages

This directory contains HTML test pages demonstrating various dark patterns for testing the scanner.

## Test Pages

### Cookie Nudge
- **`cookie_nudge_bad.html`**: Cookie banner with manipulative design (prominent "Accept", hidden "Reject")
- **`cookie_nudge_good.html`**: Balanced cookie banner without dark patterns

### Preselected Addons
- **`preselected_addon_bad.html`**: Checkout with pre-selected upsells

### Roach Motel (Hard to Cancel)
- **`roach_motel_bad.html`**: Subscription page with hidden cancel option

### Hidden Information
- **`hidden_information_bad.html`**: Pricing page with critical terms in fine print

### Misleading Labels
- **`misleading_label_bad.html`**: Modal with confusing double-negative wording

## How to Test

### Manual Testing

1. Install the extension in Chrome (load unpacked from repo root)
2. Open any test page in your browser
3. Click the extension icon and open the Side Panel
4. Switch to the "Dark Patterns" tab
5. Click "Scan dark patterns"
6. Review the findings

### Expected Results

Each `*_bad.html` file should trigger detection of its corresponding pattern type:
- `cookie_nudge_bad.html` → `cookie_nudge` pattern
- `preselected_addon_bad.html` → `preselected_addon` pattern
- `roach_motel_bad.html` → `roach_motel` pattern
- `hidden_information_bad.html` → `hidden_information` pattern
- `misleading_label_bad.html` → `misleading_label` pattern

The `cookie_nudge_good.html` file should ideally return no patterns or a lower risk level.

## Backend Configuration

For these pages to work with real OpenAI analysis:

1. Start the backend scanner service:
   ```bash
   cd scanner
   npm install
   npm run build
   OPENAI_API_KEY=your-key npm start
   ```

2. Update the extension config to point to your backend:
   - Open Chrome DevTools console in the extension popup
   - Run: `chrome.storage.sync.set({ backendUrl: "http://localhost:3000" })`

3. For development/testing without OpenAI, use mock mode:
   ```javascript
   chrome.storage.sync.set({ useMockBackend: true })
   ```

## Notes

- Test pages are intentionally simple to focus on specific patterns
- Real-world pages may contain multiple patterns
- The scanner uses heuristics that may produce false positives/negatives
- These pages are for V1 pre-audit testing, not legal compliance verification


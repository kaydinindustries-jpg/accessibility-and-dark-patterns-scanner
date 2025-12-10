# Dark Patterns V1 - Taxonomy & Detection

## Overview

This document describes the V1 taxonomy of dark patterns detected by the **Accessibility & Dark Pattern Watchdog** tool. This is a **technical pre-audit tool**, not a legal compliance certification.

## Regulatory Context

The scanner focuses on patterns that may violate:
- **DSA (Digital Services Act)** - Art. 25: prohibits deceptive design
- **Consumer Protection Directives** - prohibit misleading practices
- **AI Act** - Art. 5: prohibits manipulative AI systems

## Pattern Types

### 1. Cookie Nudge (`cookie_nudge`)

**Definition**: Cookie consent interfaces designed to nudge users toward accepting all cookies, with rejection made difficult or less visible.

**Detection Heuristics**:
- Element with `role="dialog"` or `aria-modal="true"`
- Contains keywords: "cookie", "cookies", "privacy", "tracking", "consent"
- Buttons with labels: "accept", "agree", "allow", "reject", "decline", "manage"
- **Pattern indicators**:
  - "Accept" button more prominent (larger, bolder, colored)
  - "Reject" button hidden, tiny, or styled as plain text link
  - No clear "Reject all" option visible

**Risk Levels**:
- **High**: No visible reject option, or reject hidden in multiple-step process
- **Medium**: Reject present but significantly less visible than accept
- **Low**: Balanced options but minor UX asymmetry

**Example**: Large blue "Accept all" button next to tiny gray link "Manage preferences"

**Legal Refs**: GDPR Art. 7, DSA Art. 25, ePrivacy Directive

---

### 2. Roach Motel (`roach_motel`)

**Definition**: Easy to subscribe/sign up, but cancellation is hidden, cumbersome, or requires contacting support.

**Detection Heuristics**:
- Links/buttons containing: "cancel", "unsubscribe", "delete account", "close account"
- **Pattern indicators**:
  - Cancel link is plain text, very small font (<13px), low opacity
  - Cancel option buried in footer or deep in settings
  - Primary CTAs ("Keep plan", "Continue") are large and prominent

**Risk Levels**:
- **High**: Cancel requires phone call or multi-step hidden process
- **Medium**: Cancel link present but hard to find or camouflaged
- **Low**: Cancel visible but less prominent than keep/upgrade options

**Example**: Bright "Keep My Premium Plan" button at top, tiny "cancel subscription" link at page bottom in gray 10px font

**Legal Refs**: DSA Art. 25, Consumer Rights Directive

---

### 3. Preselected Addon (`preselected_addon`)

**Definition**: Extra paid options (insurance, upgrades, trials) are pre-selected by default, requiring users to opt-out.

**Detection Heuristics**:
- `input[type="checkbox"]` with `checked="true"` or `defaultChecked="true"`
- Label/text near checkbox contains: "extra", "add", "insurance", "protection", "trial", "premium", "upgrade"
- Context contains price indicators (`$`, `€`, `/month`, `/year`)

**Risk Levels**:
- **High**: Multiple pre-checked addons with significant cost, unclear total
- **Medium**: One or two pre-checked addons with visible pricing
- **Low**: Pre-checked option with minimal cost and clear disclosure

**Example**: "Add Premium Insurance +$9.99/month" checkbox pre-checked at checkout

**Legal Refs**: DSA Art. 25, Unfair Commercial Practices Directive

---

### 4. Hidden Information (`hidden_information`)

**Definition**: Essential information (total price, renewal terms, cancellation fees) is hidden in fine print, accordions, or obscure locations.

**Detection Heuristics**:
- Text containing: "non-refundable", "no refund", "auto-renew", "automatically renews", "minimum term", "cancellation fee"
- **Pattern indicators**:
  - Font size significantly smaller than average (<11px)
  - Text in `<details>` element (collapsed by default)
  - Text with `aria-hidden="true"` until interaction
  - Text far from main CTA ("Buy", "Subscribe")

**Risk Levels**:
- **High**: Critical terms (binding commitment, non-refundable) in near-invisible text
- **Medium**: Important terms in fine print but technically present
- **Low**: Terms disclosed but not prominently

**Example**: "Auto-renewal cannot be disabled. Minimum 6-month commitment." in 9px gray text at bottom

**Legal Refs**: DSA Art. 25, Consumer Rights Directive Art. 6

---

### 5. Misleading Label (`misleading_label`)

**Definition**: Button or checkbox labels use confusing, ambiguous, or manipulative wording.

**Detection Heuristics**:
- Buttons/labels containing:
  - "No, I don't want..."
  - "No, I do not..."
  - "No thanks, I prefer to pay full price"
  - "I'll risk missing out"
  - Double negatives that confuse the action

**Risk Levels**:
- **High**: Double-negative that inverts user intent
- **Medium**: Emotionally manipulative language ("risk", "lose out")
- **Low**: Mildly confusing but intent remains clear

**Example**: Button labeled "No, I don't want to save money" to decline an offer

**Legal Refs**: DSA Art. 25, Unfair Commercial Practices Directive

---

### 6. AI Manipulation (`ai_manipulation`)

**Definition**: AI assistants, chatbots, or recommendation engines that nudge users toward more expensive or riskier options without transparency.

**Detection Heuristics**:
- Elements containing: "AI", "assistant", "copilot", "smart suggestions", "recommended for you"
- Widgets with chat-like interface or recommendation lists
- **Pattern indicators**:
  - AI always suggests most expensive option
  - No disclosure of how recommendations are generated
  - Recommendations appear neutral but are biased

**Risk Levels**:
- **High**: AI presents biased options without disclosure
- **Medium**: AI recommendations favor vendor, disclosure unclear
- **Low**: AI suggestions present but alternatives clearly available

**Example**: "Our AI recommends the Pro plan for you" with no explanation of recommendation logic

**Legal Refs**: AI Act Art. 5(1)(a), DSA Art. 25

---

## Detection Methodology

### Local Heuristics (Content Script)

The extension scans the DOM for:
1. **Role identification**: Cookie banners, checkout flows, subscription pages, pricing sections
2. **Visual analysis**: Button sizes, font sizes, colors, contrast, prominence
3. **Text analysis**: Keyword matching, urgency language, confusing wording
4. **Form inspection**: Pre-checked checkboxes, hidden fields, default values

### Backend Analysis (GPT)

Candidates are sent to backend API (`/api/analyze-ui`) which:
1. **Validates** request schema
2. **Calls OpenAI** (gpt-4o-mini or configurable) with:
   - Pattern taxonomy
   - Risk level definitions
   - Candidate context (HTML snippet + visible text)
3. **Parses and validates** JSON response
4. **Returns findings** with explanations and legal references

### Confidence Scoring

Each finding includes a confidence score (0–1):
- **0.9–1.0**: Very confident (clear pattern)
- **0.7–0.89**: Confident (likely pattern)
- **0.5–0.69**: Moderate (possible pattern, manual review recommended)
- **<0.5**: Low (edge case, may be false positive)

---

## Limitations

1. **V1 scope**: English keywords only, no multi-language support yet
2. **Heuristic-based**: May produce false positives or miss sophisticated patterns
3. **No legal guarantee**: This is a technical pre-audit, not legal advice
4. **Context-dependent**: Same design may be compliant or non-compliant based on context
5. **No user testing**: Cannot measure actual confusion or manipulation impact
6. **Static analysis**: Does not test flows, multi-step processes, or dynamic behavior

---

## Use Cases

### For Product Teams
- **Pre-launch audit**: Catch potential dark patterns before release
- **Competitive analysis**: Compare your flows to competitors
- **Design review**: Evaluate UX choices for compliance risk

### For Legal/Compliance
- **Risk assessment**: Identify high-risk UI patterns for review
- **Documentation**: Export findings for internal compliance reports
- **Prioritization**: Focus legal review on highest-risk areas

### For Developers
- **CI/CD integration**: (Future) Automated checks in deployment pipeline
- **Design system validation**: Ensure components don't enable dark patterns
- **Accessibility + ethics**: Combined WCAG + dark pattern audit

---

## Next Steps (Post-V1)

1. **Multi-language support**: Keyword lists for FR, DE, ES, IT
2. **Dynamic flow testing**: Multi-step cancellation, hidden paths
3. **A/B test detection**: Identify targeted manipulative variants
4. **Severity scoring**: WCAG-like conformance levels
5. **Browser metrics**: Measure actual user confusion (heatmaps, clicks)

---

## References

- [DSA Full Text (EUR-Lex)](https://eur-lex.europa.eu/eli/reg/2022/2065/oj)
- [GDPR Text](https://gdpr-info.eu/)
- [AI Act (Provisional)](https://artificialintelligenceact.eu/)
- [Deceptive Patterns Project](https://www.deceptive.design/)
- [BEUC Dark Patterns Report](https://www.beuc.eu/dark-patterns)


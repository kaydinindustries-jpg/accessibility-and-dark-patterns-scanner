import OpenAI from "openai";
import {
  AnalyzeUIRequest,
  AnalyzeUIResponse,
  AnalyzeUIResponseSchema,
  PatternTypeSchema,
  RiskLevelSchema,
} from "../schema.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const client = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

function buildSystemPrompt(): string {
  return `
You are an assistant specialized in detecting dark patterns in web UIs
under EU law (DSA, consumer protection) and AI Act risk categories.

You receive a list of UI elements (DOM snippets and visible text).
For each element, you must decide if it contains a dark pattern from this taxonomy:

- cookie_nudge: Cookie consent oriented towards "Accept all", refusal harder/less visible.
- roach_motel: Easy to enter a subscription, hard to cancel (hidden/camouflaged cancel paths).
- preselected_addon: Extra paid options pre-selected by default (insurance, upsells, trials).
- hidden_information: Essential info (price, renewal, fees) hidden in fine print/accordions/tooltips.
- misleading_label: Ambiguous or manipulative wording ("No, I don't want to save money").
- ai_manipulation: AI assistant / recommender nudging users to more expensive/risky options without transparency.
- none: No obvious dark pattern.

Risk levels:
- low: Minor UX concern, unlikely to be misleading for most users.
- medium: Potentially misleading or confusing for a significant part of users.
- high: Strongly manipulative or clearly misleading, high regulatory risk.

Return STRICT JSON only, matching the AnalyzeUIResponse schema, no extra text.
`.trim();
}

function buildUserPromptFromCandidates(req: AnalyzeUIRequest): string {
  const lines: string[] = [];
  lines.push(`scanId: ${req.scanId}`);
  lines.push(`pageUrl: ${req.pageUrl}`);
  lines.push(`timestamp: ${req.timestamp}`);
  lines.push(`Total candidates: ${req.candidates.length}`);
  lines.push(``);
  lines.push(`candidates:`);
  for (const c of req.candidates) {
    lines.push(`- id: ${c.id}`);
    lines.push(`  role: ${c.role}`);
    lines.push(`  visibleText (first 300 chars): ${c.visibleText.slice(0, 300)}`);
    lines.push(`  htmlSnippet (first 300 chars): ${c.htmlSnippet.slice(0, 300)}`);
    lines.push(`  meta: ${JSON.stringify(c.meta)}`);
    lines.push(``);
  }
  lines.push(`
For each candidate, output:
- candidateId (same as input id)
- isDarkPattern (boolean)
- patternType (one of: ${PatternTypeSchema.options.join(", ")})
- riskLevel (one of: ${RiskLevelSchema.options.join(", ")})
- explanation (2–4 sentences, short, clear)
- suggestedFix (1–3 short sentences)
- legalRefs (array of strings, e.g. ["DSA Art. 25", "AI Act Art. 5(1)(a)"])
- confidence (0–1)

Also include at the end:
- summary.totalCandidates (number)
- summary.totalPatterns (number)
- summary.countsByPatternType (object with counts for each pattern type)
- summary.countsByRisk (object with counts for each risk level)
- modelVersion (string, include model name and prompt version like "gpt-4o-mini-v1")
- processingMs (approximate, integer)

Return ONLY valid JSON matching the schema. No markdown, no extra text.
`.trim());
  return lines.join("\n");
}

export async function callOpenAIDarkPatterns(req: AnalyzeUIRequest): Promise<AnalyzeUIResponse> {
  if (!client) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPromptFromCandidates(req);

  const started = Date.now();

  const completion = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" },
    temperature: 0.1,
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Empty model response");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new Error("Failed to parse model JSON");
  }

  const validated = AnalyzeUIResponseSchema.parse(parsed);

  // Fill in processing time if not provided
  if (!validated.processingMs || validated.processingMs === 0) {
    validated.processingMs = Date.now() - started;
  }

  return validated;
}


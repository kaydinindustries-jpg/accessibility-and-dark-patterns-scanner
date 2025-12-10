import { z } from "zod";

export const UIRoleSchema = z.enum([
  "cookie_banner",
  "checkout",
  "subscription_flow",
  "cancellation_flow",
  "pricing_section",
  "ai_widget",
  "generic",
]);

export const PatternTypeSchema = z.enum([
  "cookie_nudge",
  "roach_motel",
  "preselected_addon",
  "hidden_information",
  "misleading_label",
  "ai_manipulation",
  "none",
]);

export const RiskLevelSchema = z.enum(["low", "medium", "high"]);

export const DarkPatternCandidateSchema = z.object({
  id: z.string().min(1),
  role: UIRoleSchema,
  htmlSnippet: z.string().min(1),
  visibleText: z.string().min(1),
  url: z.string().url().or(z.string().min(1)),
  path: z.string().default(""),
  xpathOrSelector: z.string().min(1),
  meta: z.object({
    hasPrecheckedCheckbox: z.boolean().optional(),
    isModal: z.boolean().optional(),
    isOverlay: z.boolean().optional(),
    buttonLabels: z.array(z.string()).optional(),
    containsPrice: z.boolean().optional(),
    containsUrgencyWords: z.boolean().optional(),
    viewport: z.enum(["desktop", "mobile_emulated"]).optional(),
    patternHint: PatternTypeSchema.optional(),
    isSmallOrLowContrast: z.boolean().optional(),
    isHiddenLike: z.boolean().optional(),
    hasAccept: z.boolean().optional(),
    hasReject: z.boolean().optional(),
  }).passthrough(),
});

export const AnalyzeUIRequestSchema = z.object({
  scanId: z.string().min(1),
  pageUrl: z.string().url().or(z.string().min(1)),
  timestamp: z.string().datetime(),
  candidates: z.array(DarkPatternCandidateSchema).max(50),
});

export type AnalyzeUIRequest = z.infer<typeof AnalyzeUIRequestSchema>;
export type DarkPatternCandidate = z.infer<typeof DarkPatternCandidateSchema>;

export const DarkPatternFindingSchema = z.object({
  candidateId: z.string().min(1),
  isDarkPattern: z.boolean(),
  patternType: PatternTypeSchema,
  riskLevel: RiskLevelSchema,
  explanation: z.string().min(1).max(1000),
  suggestedFix: z.string().min(1).max(1000),
  legalRefs: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});

export const AnalyzeUIResponseSchema = z.object({
  scanId: z.string().min(1),
  findings: z.array(DarkPatternFindingSchema),
  summary: z.object({
    totalCandidates: z.number().int().nonnegative(),
    totalPatterns: z.number().int().nonnegative(),
    countsByPatternType: z.record(PatternTypeSchema, z.number().int().nonnegative()).default({
      cookie_nudge: 0,
      roach_motel: 0,
      preselected_addon: 0,
      hidden_information: 0,
      misleading_label: 0,
      ai_manipulation: 0,
      none: 0,
    }),
    countsByRisk: z.record(RiskLevelSchema, z.number().int().nonnegative()).default({
      low: 0,
      medium: 0,
      high: 0,
    }),
  }),
  modelVersion: z.string().min(1),
  processingMs: z.number().int().nonnegative(),
});

export type DarkPatternFinding = z.infer<typeof DarkPatternFindingSchema>;
export type AnalyzeUIResponse = z.infer<typeof AnalyzeUIResponseSchema>;


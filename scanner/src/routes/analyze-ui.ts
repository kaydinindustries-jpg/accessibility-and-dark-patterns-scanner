import type { Express, Request, Response } from "express";
import crypto from "crypto";
import {
  AnalyzeUIRequestSchema,
  AnalyzeUIRequest,
  AnalyzeUIResponse,
  AnalyzeUIResponseSchema,
} from "../schema.js";
import { callOpenAIDarkPatterns } from "../services/openaiClient.js";

const LOG_VERBOSE = process.env.LOG_VERBOSE === "1";

function hashUrl(url: string): string {
  return crypto.createHash("sha256").update(url).digest("hex");
}

function log(event: string, data: Record<string, unknown> = {}) {
  const entry = { ts: new Date().toISOString(), level: 'info', event, ...data };
  console.log(JSON.stringify(entry));
}

function logError(event: string, err: unknown, extra: Record<string, unknown> = {}) {
  const e = err as any;
  const entry = { ts: new Date().toISOString(), level: 'error', event, msg: e?.message, stack: e?.stack, ...extra };
  console.error(JSON.stringify(entry));
}

export function registerAnalyzeUiRoutes(app: Express) {
  app.post("/api/analyze-ui", async (req: Request, res: Response) => {
    const started = Date.now();
    
    try {
      const parsed = AnalyzeUIRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        if (LOG_VERBOSE) {
          console.warn("analyze-ui invalid_request", parsed.error.flatten());
        } else {
          log("analyze-ui_invalid_request", { scanId: req.body?.scanId });
        }
        return res.status(400).json({ error: "invalid_request" });
      }
      
      const body: AnalyzeUIRequest = parsed.data;

      // Log safe version (no sensitive content)
      if (LOG_VERBOSE) {
        log("analyze-ui_received", {
          scanId: body.scanId,
          pageUrlHash: hashUrl(body.pageUrl),
          candidatesCount: body.candidates.length,
        });
      } else {
        log("analyze-ui_received", {
          scanId: body.scanId,
          pageUrlHash: hashUrl(body.pageUrl),
          candidatesCount: body.candidates.length,
        });
      }

      if (!body.candidates.length) {
        const empty: AnalyzeUIResponse = {
          scanId: body.scanId,
          findings: [],
          summary: {
            totalCandidates: 0,
            totalPatterns: 0,
            countsByPatternType: {
              cookie_nudge: 0,
              roach_motel: 0,
              preselected_addon: 0,
              hidden_information: 0,
              misleading_label: 0,
              ai_manipulation: 0,
              none: 0,
            },
            countsByRisk: {
              low: 0,
              medium: 0,
              high: 0,
            },
          },
          modelVersion: "none",
          processingMs: 0,
        };
        log("analyze-ui_completed", { scanId: body.scanId, candidatesCount: 0, patternsCount: 0 });
        return res.json(empty);
      }

      let modelResult: AnalyzeUIResponse;
      try {
        modelResult = await callOpenAIDarkPatterns(body);
      } catch (e) {
        logError("analyze-ui_openai_error", e, { scanId: body.scanId });
        return res.status(502).json({ error: "openai_error" });
      }

      const validated = AnalyzeUIResponseSchema.safeParse(modelResult);
      if (!validated.success) {
        logError("analyze-ui_invalid_model_response", validated.error, { scanId: body.scanId });
        return res.status(502).json({ error: "invalid_model_response" });
      }

      const result = validated.data;
      const elapsed = Date.now() - started;

      // Safe logging (production)
      log("analyze-ui_completed", {
        scanId: result.scanId,
        candidatesCount: result.summary.totalCandidates,
        patternsCount: result.summary.totalPatterns,
        countsByPatternType: result.summary.countsByPatternType,
        countsByRisk: result.summary.countsByRisk,
        processingMs: elapsed,
        modelVersion: result.modelVersion,
      });

      return res.json(result);
    } catch (e) {
      logError("analyze-ui_unexpected_error", e, { scanId: req.body?.scanId });
      return res.status(500).json({ error: "internal_server_error" });
    }
  });
}


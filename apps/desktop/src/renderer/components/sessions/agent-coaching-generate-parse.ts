import { z } from "zod";
import type { AgentCoachingTip } from "./agent-coaching-types";

const actionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  mode: z.enum(["read_only", "draft", "confirm_then_apply"]),
  safety: z.enum(["safe", "moderate"]),
  result: z.string(),
});

const tipSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  category: z.enum([
    "context_management",
    "speed_of_delivery",
    "accuracy",
    "opportunity_analysis",
    "token_efficiency",
  ]),
  body: z.string().min(1),
  whyItMatters: z.string(),
  evidence: z.array(z.string()),
  experiment: z.string(),
  proposedArtifact: z.string().optional(),
  detail: z.object({
    whatThisMeans: z.string(),
    howToAct: z.array(z.string()),
    whyThisRecommendation: z.string(),
    autoApply: z.string(),
  }),
  actions: z.array(actionSchema),
});

const JSON_ARRAY_PATTERN = /\[[\s\S]*\]/;

/**
 * Parse the harness's stdout into validated tips. The local `claude -p` output
 * may wrap the JSON in prose or a ```json fence, so we extract the first JSON
 * array, then validate each element and drop any that don't conform — a partial
 * result is better than discarding the whole batch.
 */
export function parseGeneratedTips(raw: string): AgentCoachingTip[] {
  const match = raw.match(JSON_ARRAY_PATTERN);
  if (!match) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const tips: AgentCoachingTip[] = [];
  for (const candidate of parsed) {
    const result = tipSchema.safeParse(candidate);
    if (result.success) {
      tips.push(result.data);
    }
  }
  return tips;
}

import { z } from "zod";
import type {
  AgentCoachingTip,
  AgentCoachingTipCategory,
} from "./agent-coaching-types";

// Bind the parsed category enum to the canonical union so adding a category
// (e.g. FEA-3399 `resilience`) without listing it here — or listing a stale one
// — fails at compile time rather than silently dropping valid LLM tips.
const CATEGORY_VALUES = [
  "context_management",
  "speed_of_delivery",
  "accuracy",
  "opportunity_analysis",
  "token_efficiency",
  "resilience",
  // FEA-3265 candidate-pool dimensions. The prompt advertises `wall_time` and
  // `cost` as focus areas (see COACHING_TIP_CATEGORIES in agent-coaching-llm.ts),
  // so the parser must accept them too — otherwise valid harness-generated
  // wall_time/cost tips are silently dropped and an all-new-category batch falls
  // back to seeds.
  "wall_time",
  "cost",
  // FEA-4153: capability-gap dimension. Advertised as a focus area in the prompt
  // (COACHING_TIP_CATEGORIES), so the parser must accept it too — otherwise a
  // valid harness-generated capability_gap tip is silently dropped.
  "capability_gap",
] as const satisfies readonly AgentCoachingTipCategory[];

const actionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  mode: z.enum(["read_only", "draft", "confirm_then_apply"]),
  safety: z.enum(["safe", "moderate"]),
  result: z.string(),
  // FEA-3687 #4: how an Apply resolves — a single new-file install vs an
  // LLM-driven edit across existing `.claude/*` files. Optional + `.catch` so a
  // missing/invalid value degrades to the default (`create-new-file`, applied
  // by `resolveApplyKind`) rather than dropping the whole tip.
  kind: z
    .enum(["create-new-file", "edit-existing"])
    .optional()
    .catch(undefined),
});

const tipSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  category: z.enum(CATEGORY_VALUES),
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

// A raw serialized tool-event object leaking into human prose — e.g.
// `{"session_id":"…","tool_input":{"command":"cd …"}}`. When a title/body/skill
// name contains one of these the tip is garbled (FEA-3687): we drop it rather
// than render a JSON blob as a recommendation.
const EVENT_JSON_BLOB_PATTERN =
  /\{\s*"(?:session_id|tool_input|tool_name|toolName|command)"\s*:/;
// A giant slugified identifier mashed from a JSON blob, e.g.
// `session-id-65950db3-…-tool-input-command-cd-skill`.
const GARBLED_SLUG_PATTERN = /\b[a-z0-9]+(?:-[a-z0-9]+){8,}\b/;

/**
 * True when a piece of generated prose has a raw event-JSON blob or a giant
 * slugified identifier mashed into it. Such a tip is garbled — drop it.
 */
function looksGarbled(value: string): boolean {
  return (
    EVENT_JSON_BLOB_PATTERN.test(value) || GARBLED_SLUG_PATTERN.test(value)
  );
}

/**
 * The user-visible prose fields of a tip (title, body, evidence, the detail
 * copy, and every action label/result). If a blobby field slipped through the
 * generator into any of these, the tip renders garbled — so we scan them all.
 */
function tipHasGarbledText(tip: AgentCoachingTip): boolean {
  // NOTE: `proposedArtifact` is intentionally excluded — it is the full,
  // ready-to-install file content shown verbatim in the draft panel (a skill
  // `.md` may legitimately embed JSON examples), not prose we render inline.
  const strings = [
    tip.title,
    tip.body,
    tip.whyItMatters,
    tip.experiment,
    tip.detail.whatThisMeans,
    tip.detail.whyThisRecommendation,
    tip.detail.autoApply,
    ...tip.evidence,
    ...tip.detail.howToAct,
    ...tip.actions.flatMap((action) => [action.label, action.result]),
  ];
  return strings.some((value) => looksGarbled(value));
}

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
    // Drop malformed tips AND tips whose prose leaked a raw event-JSON blob or a
    // giant slugified identifier — a garbled tip is worse than one fewer tip.
    if (result.success && !tipHasGarbledText(result.data)) {
      tips.push(result.data);
    }
  }
  return tips;
}

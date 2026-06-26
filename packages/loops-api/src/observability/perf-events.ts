import { z } from "zod";
import { LoopHarnessSchema } from "../desktop-request";

/**
 * Canonical raw `loop.perf.*` event schema — Single Source of Truth (Q-001/D-005).
 *
 * These schemas were relocated here from
 * `apps/desktop/src/main/loop-perf-telemetry.ts` so that both the desktop emit
 * pipeline (file-tail path + in-process adapter path) and the harness-portable
 * observability adapters share one definition. The desktop owns sanitization,
 * phase attribution, and Datadog category mapping; this module owns only the
 * shape of a raw record.
 *
 * Fields introduced in newer producer versions use `.nullish()` so legacy
 * records without those fields parse cleanly (missing → undefined → treated as
 * null). The `harness` discriminator (D-007) is an optional, additive field on
 * every event so native-emitted events can declare which harness produced them
 * while legacy plugin `perf.jsonl` records (no `harness`) still validate.
 */

/** Optional, additive `harness` discriminator shared by every raw event (D-007). */
const harnessField = { harness: LoopHarnessSchema.optional() };

export const runSchema = z.object({
  event: z.literal("run"),
  run_id: z.string(),
  command: z.string().nullish(),
  started_at: z.string(),
  repo: z.string().nullish(),
  branch: z.string().nullish(),
  ...harnessField,
});

export const phaseSchema = z.object({
  event: z.literal("phase"),
  run_id: z.string(),
  iteration: z.number().int(),
  phase: z.string(),
  status: z.string(),
  start_sha: z.string().nullish(),
  started_at: z.string(),
  command: z.string().nullish(),
  ...harnessField,
});

export const iterationSchema = z.object({
  event: z.literal("iteration"),
  run_id: z.string(),
  iteration: z.number().int(),
  command: z.string().nullish(),
  started_at: z.string(),
  ended_at: z.string(),
  duration_s: z.number(),
  claude_exit_code: z.number().int().nullish(),
  status: z.string(),
  ...harnessField,
});

export const pipelineStepSchema = z.object({
  event: z.literal("pipeline_step"),
  run_id: z.string(),
  iteration: z.number().int(),
  command: z.string().nullish(),
  // The producer emits non-integer step numbers (e.g. 8.5 for
  // write_merged_patterns) to slot synthetic sub-steps between the integer
  // pipeline positions, so we accept the full numeric range here.
  step: z.number(),
  step_name: z.string(),
  started_at: z.string(),
  ended_at: z.string(),
  duration_s: z.number(),
  exit_code: z.number().int().nullish(),
  skipped: z.boolean(),
  ...harnessField,
});

export const agentSchema = z.object({
  event: z.literal("agent"),
  run_id: z.string(),
  iteration: z.number().int(),
  agent_id: z.string(),
  agent_type: z.string(),
  agent_name: z.string(),
  started_at: z.string(),
  ended_at: z.string(),
  duration_s: z.number(),
  command: z.string().nullish(),
  model: z.string().nullish(),
  parent_session_id: z.string().nullish(),
  input_tokens: z.number().int().nullish(),
  output_tokens: z.number().int().nullish(),
  cache_creation_input_tokens: z.number().int().nullish(),
  cache_read_input_tokens: z.number().int().nullish(),
  total_context_tokens: z.number().int().nullish(),
  ...harnessField,
  // phase is attributed by the scanner (not in the raw record)
});

export const toolSchema = z.object({
  event: z.literal("tool"),
  run_id: z.string(),
  command: z.string().nullish(),
  iteration: z.number().int(),
  agent_id: z.string(),
  tool_name: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullish(),
  duration_s: z.number().nullish(),
  ok: z.boolean().nullish(),
  ...harnessField,
});

export const skillSchema = z.object({
  event: z.literal("skill"),
  run_id: z.string(),
  command: z.string().nullish(),
  iteration: z.number().int(),
  agent_id: z.string(),
  tool_name: z.string(),
  skill_name: z.string(),
  started_at: z.string(),
  ended_at: z.string(),
  duration_s: z.number(),
  ok: z.boolean(),
  ...harnessField,
});

export const spawnSchema = z.object({
  event: z.literal("spawn"),
  run_id: z.string(),
  command: z.string().nullish(),
  iteration: z.number().int(),
  parent_session_id: z.string().nullish(),
  parent_agent_id: z.string(),
  planned_subagent_type: z.string().nullish(),
  started_at: z.string(),
  ...harnessField,
});

/**
 * Discriminated union of all `perf.jsonl` raw event schemas.
 * The `event` field is the discriminator key.
 */
export const perfEventSchema = z.discriminatedUnion("event", [
  runSchema,
  phaseSchema,
  iterationSchema,
  pipelineStepSchema,
  agentSchema,
  toolSchema,
  skillSchema,
  spawnSchema,
]);

export type RawPerfEvent = z.infer<typeof perfEventSchema>;
export type RawRunEvent = z.infer<typeof runSchema>;
export type RawIterationEvent = z.infer<typeof iterationSchema>;
export type RawAgentEvent = z.infer<typeof agentSchema>;
export type RawToolEvent = z.infer<typeof toolSchema>;
export type RawSpawnEvent = z.infer<typeof spawnSchema>;
export type RawPerfEventType = RawPerfEvent["event"];

/**
 * FEA-4143 (PRD-553 / PLN-1500) Slice 2 — the per-task config a SCHEDULED review
 * pass needs, carried on `ScheduledTask.meta` under {@link NIGHT_CREW_CONFIG_META_KEY}.
 *
 * The scheduler's `meta` is a deliberately open extension bag
 * (`z.record(z.string(), z.unknown())`) that is never load-bearing for the cron
 * math, so a scheduled review can ride there additively with NO DB migration and
 * NO change to the persisted task shape. This module owns the ONE Zod schema that
 * gives that bag a typed, versioned meaning for the night crew.
 *
 * ── Skew-safety (a hard requirement of this boundary) ────────────────────────
 * The config crosses process (db-host child ↔ main) and version (an older/newer
 * desktop build, a hand-edited store row) boundaries. So it is validated with
 * `safeParse` and deliberately NOT `.strict()`:
 *   - An UNKNOWN extra field (a key a newer build started writing) is ignored,
 *     never rejected — the whole config is not thrown away for one future key.
 *   - An ABSENT optional field degrades to a safe default (or stays omitted), so
 *     a task written before this slice, or by a build that only fills some
 *     fields, still yields a usable config for the fields it did carry.
 *   - A fundamentally malformed value (e.g. `repoDir` missing) yields `null` from
 *     {@link readNightCrewConfig}, and the dispatch falls back to a recorded skip
 *     rather than crashing the tick.
 *
 * `slackDestination` is a PLACEHOLDER only (the Slack SINK transport is out of
 * scope — it stays under the blocked umbrella FEA-4102): it is carried and
 * validated here so the data model is complete, but nothing in this slice reads
 * it to deliver anything.
 */
import { z } from "zod";
import { cascadeStepSchema, dedupeCascade } from "../model.js";

/**
 * The `meta` key under which a scheduled task records its night-crew review
 * config. Namespaced so it cannot collide with the other `meta` markers
 * (`nativeOwnerId`, `cloudRoutineId`, `covered`, `focus`).
 */
export const NIGHT_CREW_CONFIG_META_KEY = "nightCrewConfig" as const;

/**
 * The Slack-destination placeholder (FEA-4102 will consume it). Kept a minimal,
 * additive object so a channel id / webhook ref can be filled without a schema
 * break; every field is optional so an absent or partial destination degrades to
 * "no Slack target" rather than rejecting the config.
 */
export const nightCrewSlackDestinationSchema = z.object({
  /** Slack channel id or name the summary would post to (placeholder). */
  channel: z.string().min(1).optional(),
  /** Opaque webhook/integration reference (placeholder). */
  webhookRef: z.string().min(1).optional(),
});
export type NightCrewSlackDestination = z.infer<
  typeof nightCrewSlackDestinationSchema
>;

/**
 * The config a scheduled review pass reads off `task.meta`. NOT `.strict()`:
 * unknown keys are dropped, not rejected (forward skew), and every field beyond
 * the load-bearing `repoDir` + `characters` is optional (backward skew).
 */
export const nightCrewConfigSchema = z.object({
  /**
   * Absolute path to the repo the scheduled review runs against. Load-bearing —
   * the audit cannot run without a target — so a config missing it fails
   * validation and the dispatch falls back to a skip.
   */
  repoDir: z.string().min(1),
  /**
   * The review character(s) to run, in order (e.g. `["docs-darwin"]`). Kept
   * plain strings on the wire so a version-skewed store can name a character a
   * given build has not shipped; the main-side runner roster-validates each id
   * before spawning. At least one is required.
   */
  characters: z.array(z.string().min(1)).min(1),
  /** Target ClosedLoop project slug/id the filed findings land in. */
  projectSlug: z.string().min(1).optional(),
  /** ClosedLoop assignee (crew manager) for the filed issues. */
  assigneeId: z.string().min(1).optional(),
  /**
   * Per-run cascade override — ordered `(harness, model?)` steps. Absent/empty ⇒
   * the runner's default cascade. Reuses the model's `cascadeStepSchema`, so a
   * legacy bare harness-name string or the `"harness:model"` shorthand still
   * parses. A persisted config (a hand-edited store row, a version-skewed writer)
   * can carry duplicate harnesses; the on-demand picker caps the cascade to one
   * step per harness, so we normalize the persisted boundary the same way here —
   * running the parsed steps through the shared {@link dedupeCascade} so a second
   * (dead) step for an already-listed harness is dropped, keeping first-wins order.
   */
  cascade: z.array(cascadeStepSchema).transform(dedupeCascade).optional(),
  /**
   * Slack-destination placeholder (FEA-4102). Carried + validated for a complete
   * data model; NOT consumed by this slice.
   */
  slackDestination: nightCrewSlackDestinationSchema.optional(),
});
export type NightCrewConfig = z.infer<typeof nightCrewConfigSchema>;

/**
 * Read + validate the night-crew config off a task's `meta` bag. Returns the
 * parsed config, or `null` when the key is absent or the value fails validation
 * — never throws, so a malformed/partial/forward-skewed row degrades gracefully
 * (the dispatch records a skip instead of crashing the tick). `safeParse` drops
 * unknown extra keys rather than rejecting them.
 */
export function readNightCrewConfig(
  meta: Record<string, unknown>
): NightCrewConfig | null {
  const raw = meta[NIGHT_CREW_CONFIG_META_KEY];
  if (raw === undefined || raw === null) {
    return null;
  }
  const parsed = nightCrewConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

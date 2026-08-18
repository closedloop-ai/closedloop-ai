/**
 * ISS-5303 — the pure half of `autonomy-calibration.ts`.
 *
 * Scoring, the ancestor reference column, and the timestamp helpers, moved here
 * verbatim so they can be unit-tested. Nothing in this module runs at import
 * time: no store is opened, no path is probed, no argv is read.
 *
 * That import-safety is the whole point of the split. The entrypoint ends in an
 * UNGUARDED module-level `await main()`, so a test that imported it would run
 * the harness against a real `agent-dashboard.sqlite`. `main()`, `snapshotStore`
 * and `loadSessionInputs` therefore stay over there, and any helper left behind
 * with them is untestable by construction.
 *
 * Behaviour is unchanged from the pre-split entrypoint, with one deliberate
 * SSOT swap: `median` and `clampPercent` are now the canonical
 * `@repo/api/src/utils/math` exports instead of local copies. See
 * `ancestorAutonomy` for why that swap is behaviour-preserving here.
 */

import { clampPercent, median } from "@repo/api/src/utils/math";
import { deriveAutonomyAndSteering } from "@repo/lib/session-trace/autonomy";
import type { ScoredSession } from "./autonomy-calibration-report.js";

/** Ancestor constants (`closedloop-ai/workflow` report.ts). Reference column only. */
export const ANCESTOR_PROMPT_BURST_MS = 90 * 1000;
export const ANCESTOR_LONG_STRETCH_MS = 5 * 60 * 1000;
export const ANCESTOR_AGENTIC_MEDIAN_MS = 15 * 60 * 1000;
export const ANCESTOR_LIGHT_STEERING_PER_HOUR = 2;
export const ANCESTOR_HEAVY_STEERING_PER_HOUR = 20;
const MS_PER_HOUR = 3_600_000;

export type SessionInput = {
  id: string;
  harness: string | null;
  headless: boolean;
  /** `role:"human"` message timestamps — the production `promptTimestamps`. */
  promptTimestamps: string[];
  /** Timeline rows that are NOT prompts, plus token events — the agent stream. */
  agentActivityTimestamps: string[];
  /** Every timeline row plus token events — the ancestor column's input. */
  activityTimestamps: string[];
};

export function scoreSession(input: SessionInput): ScoredSession {
  const derived = deriveAutonomyAndSteering({
    promptTimestamps: input.promptTimestamps,
    agentActivityTimestamps: input.agentActivityTimestamps,
    headless: input.headless,
  });
  const all = sortedTimes([
    ...input.promptTimestamps,
    ...input.agentActivityTimestamps,
  ]);
  const wallMs = all.length > 1 ? (all.at(-1) ?? 0) - (all[0] ?? 0) : 0;
  return {
    id: input.id,
    harness: input.harness,
    headless: input.headless,
    prompts: input.promptTimestamps.length,
    autonomy: derived.autonomy,
    steeringEpisodes: derived.steeringEpisodes,
    ancestor: ancestorAutonomy(
      input.promptTimestamps,
      input.activityTimestamps
    ),
    wallMinutes: wallMs / 60_000,
  };
}

/**
 * `summarizeSessionAutonomy` from `closedloop-ai/workflow`
 * (`packages/telemetry/src/report.ts`), reproduced as a reference column:
 * `0.45 * (medianStretch / 15min) + 0.35 * shareOfStretchTimeInLongStretches +
 * 0.20 * steeringPressure`. Returns null where the ancestor reports
 * `hasEstimate: false` (no prompts captured — it renders an explanatory empty
 * state rather than a number, which is the prior art for Follow-up 2).
 *
 * CONTRACT RECONCILIATION (ISS-5303). The two canonical math helpers differ
 * from the local copies this replaced, and neither difference is reachable
 * here:
 *
 * - `median` returns `number | null` on empty input where the local copy
 *   returned `number | undefined`. The empty-input guard below is therefore
 *   `!== null`, not `!== undefined`; both spellings gate the same case
 *   (`stretches.length === 0`) and the non-empty results are identical, so the
 *   omitted-median weighting is unchanged.
 * - `clampPercent` coerces non-finite input to `0`, where the local copy let
 *   `NaN` through and pinned `+Infinity` to `100`. Every argument below is
 *   finite by construction: `sortedTimes` drops non-finite parses, so all
 *   stretches are finite differences of finite numbers; `stretchTotal || 1`
 *   removes the divide-by-zero; and the steering term is guarded by
 *   `spanMs > 0` and divided by a nonzero constant range.
 */
export function ancestorAutonomy(
  promptTimestamps: readonly string[],
  activityTimestamps: readonly string[]
): number | null {
  const prompts = sortedTimes(promptTimestamps);
  const activity = sortedTimes(activityTimestamps);
  if (prompts.length === 0 || activity.length === 0) {
    return null;
  }
  const lastMs = activity.at(-1) ?? 0;
  const spanMs = Math.max(0, lastMs - (activity[0] ?? 0));
  const episodes = groupBursts(prompts, ANCESTOR_PROMPT_BURST_MS);
  const stretches = episodes
    .map((episode, index) =>
      Math.max(0, (episodes[index + 1]?.start ?? lastMs) - episode.end)
    )
    .filter((value) => value > 0);
  const stretchTotal = stretches.reduce((sum, value) => sum + value, 0);
  const longTotal = stretches
    .filter((value) => value >= ANCESTOR_LONG_STRETCH_MS)
    .reduce((sum, value) => sum + value, 0);
  const parts: { value: number; weight: number }[] = [
    {
      value: clampPercent((longTotal / (stretchTotal || 1)) * 100),
      weight: 0.35,
    },
  ];
  const medianStretch = median(stretches);
  if (medianStretch !== null) {
    parts.push({
      value: clampPercent((medianStretch / ANCESTOR_AGENTIC_MEDIAN_MS) * 100),
      weight: 0.45,
    });
  }
  if (spanMs > 0) {
    const perHour = Math.max(0, episodes.length - 1) / (spanMs / MS_PER_HOUR);
    parts.push({
      value:
        100 -
        clampPercent(
          ((perHour - ANCESTOR_LIGHT_STEERING_PER_HOUR) /
            (ANCESTOR_HEAVY_STEERING_PER_HOUR -
              ANCESTOR_LIGHT_STEERING_PER_HOUR)) *
            100
        ),
      weight: 0.2,
    });
  }
  const weightTotal = parts.reduce((sum, part) => sum + part.weight, 0);
  if (weightTotal === 0) {
    return null;
  }
  return Math.round(
    parts.reduce((sum, part) => sum + part.value * part.weight, 0) / weightTotal
  );
}

export function sortedTimes(values: readonly string[]): number[] {
  return values
    .map((value) => Date.parse(value))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
}

export function groupBursts(
  times: readonly number[],
  burstMs: number
): { start: number; end: number }[] {
  const episodes: { start: number; end: number }[] = [];
  for (const time of times) {
    const current = episodes.at(-1);
    if (current && time - current.end <= burstMs) {
      current.end = time;
      continue;
    }
    episodes.push({ start: time, end: time });
  }
  return episodes;
}

export function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

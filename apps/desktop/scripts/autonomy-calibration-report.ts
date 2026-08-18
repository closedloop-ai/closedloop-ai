/**
 * PLN-1545 / FEA-3781 T2 — calibration report rendering.
 *
 * The presentation half of `autonomy-calibration.ts`: given the scored corpus,
 * render the histogram, percentiles, tier split, steering cross-tab, cut-point
 * sweep, and per-tier examples. Split out because reading and scoring a store is
 * a different job from describing the resulting distribution — and because the
 * distribution tables are the actual deliverable of the harness, so they earn
 * their own file.
 *
 * Pure over `ScoredSession[]`: returns text, touches no process I/O and no
 * store. The entrypoint owns stdout.
 */

import { classifyAutonomyTier } from "@repo/api/src/session-autonomy-tiers";

export type ScoredSession = {
  id: string;
  harness: string | null;
  headless: boolean;
  prompts: number;
  autonomy: number | null;
  steeringEpisodes: number | null;
  ancestor: number | null;
  wallMinutes: number;
};

const HISTOGRAM_BUCKET_WIDTH = 10;
const EXAMPLES_PER_TIER = 4;
const TIERS = ["high", "mixed", "guided", "unknown"] as const;

export function renderCalibrationReport(
  storePath: string,
  scored: ScoredSession[]
): string {
  const lines: string[] = [
    `store:    ${storePath}`,
    `sessions: ${scored.length} (headless: ${scored.filter((s) => s.headless).length})`,
    "",
    "== score distribution ==",
    ...histogram(scored),
    "",
    "== percentiles ==",
    percentiles(scored),
    "",
    "== tier split (AUTONOMY_TIER_MIN_SCORE) ==",
    ...tierSplit(scored),
    "",
    "== steering-episode cross-tab (is the score still inverted?) ==",
    ...steeringCrossTab(scored),
    "",
    "== candidate cut-points ==",
    ...cutPointSweep(scored),
    "",
    "== ancestor reference (closedloop-ai/workflow report.ts) ==",
    ...tierSplit(
      scored.map((session) => ({ ...session, autonomy: session.ancestor }))
    ),
    "",
    "== examples per tier ==",
    ...tierExamples(scored),
  ];
  return `${lines.join("\n")}\n`;
}

function histogram(scored: ScoredSession[]): string[] {
  const counts = new Map<string, number>();
  for (const session of scored) {
    counts.set(
      bucketLabel(session.autonomy),
      (counts.get(bucketLabel(session.autonomy)) ?? 0) + 1
    );
  }
  return [...counts.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(
      ([label, count]) =>
        `  ${label.padStart(8)}  ${String(count).padStart(4)}  ${"#".repeat(count)}`
    );
}

function bucketLabel(score: number | null): string {
  if (score === null) {
    return "null";
  }
  if (score === 100) {
    return "100";
  }
  const floor =
    Math.floor(score / HISTOGRAM_BUCKET_WIDTH) * HISTOGRAM_BUCKET_WIDTH;
  return `${String(floor).padStart(3, "0")}-${floor + HISTOGRAM_BUCKET_WIDTH - 1}`;
}

function percentiles(scored: ScoredSession[]): string {
  const values = scored
    .map((session) => session.autonomy)
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);
  if (values.length === 0) {
    return "  (no scored sessions)";
  }
  const at = (fraction: number) =>
    values[Math.min(values.length - 1, Math.floor(fraction * values.length))];
  const pinned = values.filter((value) => value === 100).length;
  return `  n=${values.length}  min=${values[0]} p25=${at(0.25)} p50=${at(0.5)} p75=${at(0.75)} max=${values.at(-1)}  =100: ${pinned} (${Math.round((pinned / values.length) * 100)}%)`;
}

function tierSplit(scored: { autonomy: number | null }[]): string[] {
  const counts = new Map<string, number>();
  for (const session of scored) {
    const tier = classifyAutonomyTier(session.autonomy);
    counts.set(tier, (counts.get(tier) ?? 0) + 1);
  }
  return TIERS.map((tier) => {
    const count = counts.get(tier) ?? 0;
    return `  ${tier.padEnd(8)} ${String(count).padStart(4)}  (${Math.round((count / Math.max(1, scored.length)) * 100)}%)`;
  });
}

function tierExamples(scored: ScoredSession[]): string[] {
  const lines: string[] = [];
  for (const tier of TIERS) {
    const matching = scored
      .filter((session) => classifyAutonomyTier(session.autonomy) === tier)
      .sort((left, right) => right.prompts - left.prompts)
      .slice(0, EXAMPLES_PER_TIER);
    lines.push(`  ${tier}:`);
    if (matching.length === 0) {
      lines.push("    (none)");
      continue;
    }
    for (const session of matching) {
      lines.push(
        `    ${session.id.slice(0, 12)} score=${String(session.autonomy).padStart(4)} prompts=${String(session.prompts).padStart(3)} steers=${String(session.steeringEpisodes).padStart(3)} wall=${session.wallMinutes.toFixed(0)}m harness=${session.harness ?? "?"}${session.headless ? " headless" : ""}`
      );
    }
  }
  return lines;
}

/**
 * Mean score per steering-episode bucket. The defect FEA-3781 fixes made this
 * table slope UPWARD — the most heavily steered sessions in the corpus scored
 * exactly 100. It must slope DOWNWARD: more human interventions, less autonomy.
 * This is the one table that shows the metric is measuring what its name says.
 */
function steeringCrossTab(scored: ScoredSession[]): string[] {
  const buckets: { label: string; min: number; max: number }[] = [
    { label: "0", min: 0, max: 0 },
    { label: "1-2", min: 1, max: 2 },
    { label: "3-5", min: 3, max: 5 },
    { label: "6-15", min: 6, max: 15 },
    { label: "16+", min: 16, max: Number.POSITIVE_INFINITY },
  ];
  return buckets.map((bucket) => {
    const matching = scored.filter(
      (session) =>
        session.autonomy !== null &&
        (session.steeringEpisodes ?? 0) >= bucket.min &&
        (session.steeringEpisodes ?? 0) <= bucket.max
    );
    if (matching.length === 0) {
      return `  steers ${bucket.label.padEnd(5)} n=0`;
    }
    const mean =
      matching.reduce((sum, session) => sum + (session.autonomy ?? 0), 0) /
      matching.length;
    return `  steers ${bucket.label.padEnd(5)} n=${String(matching.length).padStart(3)}  mean=${mean.toFixed(0).padStart(3)}  max=${Math.max(...matching.map((s) => s.autonomy ?? 0))}`;
  });
}

/**
 * How each candidate `AUTONOMY_TIER_MIN_SCORE` pair would split THIS corpus.
 * A pair that leaves a tier empty is a dead tier — the defect FEA-3266 was
 * itself fixing when it moved the boundaries to 88/70 for a distribution that
 * no longer exists. Pick the pair whose three tiers are all populated and whose
 * boundaries fall in sparse regions of the histogram, not through a cluster.
 */
function cutPointSweep(scored: ScoredSession[]): string[] {
  const candidates: { high: number; mixed: number }[] = [
    { high: 88, mixed: 70 },
    { high: 80, mixed: 50 },
    { high: 70, mixed: 35 },
    { high: 90, mixed: 40 },
  ];
  const values = scored.map((session) => session.autonomy);
  return candidates.map(({ high, mixed }) => {
    const highCount = values.filter(
      (value) => value !== null && value >= high
    ).length;
    const mixedCount = values.filter(
      (value) => value !== null && value >= mixed && value < high
    ).length;
    const guidedCount = values.filter(
      (value) => value !== null && value < mixed
    ).length;
    const dead = [highCount, mixedCount, guidedCount].includes(0)
      ? "  <- DEAD TIER"
      : "";
    return `  high>=${String(high).padStart(3)} mixed>=${String(mixed).padStart(3)}   high=${String(highCount).padStart(3)} mixed=${String(mixedCount).padStart(3)} guided=${String(guidedCount).padStart(3)}${dead}`;
  });
}

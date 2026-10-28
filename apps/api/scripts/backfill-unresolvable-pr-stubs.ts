/**
 * ISS-8463 — clear the false verification stamp from desktop PR stubs the
 * provider has been given a fair chance to resolve and has not.
 *
 * ONE-SHOT, OPERATOR-INVOKED, DRY-RUN BY DEFAULT. It is deliberately not a
 * Prisma migration: `migrate deploy` runs on every deploy, and this steps the
 * org-wide delivery-coverage KPI (ISS-8263). Only the empty capture table it
 * writes into ships as a migration.
 *
 * DO NOT RUN BEFORE ISS-8462 / PR #6214 HAS LANDED AND SWEPT. Until it does, a
 * desktop-origin row can stop being re-attempted after one reconcile, and a row
 * that stopped being tried is not a row that cannot be resolved.
 *
 * The SQL lives in `backfill-unresolvable-pr-stubs-queries.ts` and the operator
 * output in `backfill-unresolvable-pr-stubs-report.ts`; this file is the CLI
 * entry point and the environment it reads.
 *
 * Usage (from `apps/api`):
 *   # Quantify the KPI step — counts only, writes nothing:
 *   DATABASE_URL=<url> npx tsx scripts/backfill-unresolvable-pr-stubs.ts
 *   # Execute:
 *   DRY_RUN=0 DATABASE_URL=<url> npx tsx scripts/backfill-unresolvable-pr-stubs.ts
 *   # Undo one run:
 *   REVERT_RUN_ID=<uuid> DATABASE_URL=<url> npx tsx scripts/backfill-unresolvable-pr-stubs.ts
 *
 * Also read: LIMIT (cap the rows one apply clears) and MIN_ATTEMPT_AGE_HOURS
 * (override the attempt-age cutoff). Both reject a non-positive-integer value
 * rather than falling back. A LIMIT is reported as a TRUNCATED outcome, and the
 * KPI step is stated for the rows the run actually clears — never for the wider
 * eligible population it was capped out of.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  applyStampBackfill,
  revertStampBackfill,
  summarizeUnresolvableStubs,
} from "./backfill-unresolvable-pr-stubs-queries";
import {
  reportPopulation,
  reportRealizedStep,
  reportRevert,
} from "./backfill-unresolvable-pr-stubs-report";
import { type ScriptOutput, scriptOutput } from "./script-progress-output";

export const BackfillMode = {
  DryRun: "dry_run",
  Apply: "apply",
  Revert: "revert",
} as const;
export type BackfillMode = (typeof BackfillMode)[keyof typeof BackfillMode];

/**
 * How long a reconciler attempt must have stood unanswered before the row it
 * describes counts as unresolvable.
 *
 * Sized against the reconciler's own retry clock, but the headline number only
 * holds in one regime. `RECONCILE_DESKTOP_STUB_ATTEMPT_DEBOUNCE_MS` is one hour,
 * so a week is ~168 chances WHILE THE DEBOUNCE IS WHAT BINDS. Past the cliff
 * `session-linked-targets.ts` documents — S = 48 stubs in one (org, repo), where
 * the arm's 12 rows/tick means stubs start queueing behind each other — the real
 * cadence is S x 1.25 minutes: ~80 attempts/week at S = 100, ~27 at S = 300. The
 * dry run therefore reports each group's whole desktop-stub backlog next to the
 * count, and an operator seeing a backlog past ~48 should raise
 * MIN_ATTEMPT_AGE_HOURS rather than accept the default as "168 chances".
 */
export const UNRESOLVABLE_STUB_MIN_ATTEMPT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type RunConfig = {
  mode: BackfillMode;
  minAttemptAgeMs: number;
  revertRunId: string | null;
  limit: number | null;
};

/**
 * The environment this script reads. `Partial` because the caller may be a test
 * naming only the keys under test, and `NODE_ENV` is otherwise required.
 */
export type BackfillEnv = Partial<NodeJS.ProcessEnv>;

/** Read the run's shape off the environment, defaulting to a dry run. */
export function resolveRunConfig(env: BackfillEnv): RunConfig {
  const revertRunId = env.REVERT_RUN_ID?.trim() || null;
  const hours = strictPositiveIntEnv(
    "MIN_ATTEMPT_AGE_HOURS",
    env.MIN_ATTEMPT_AGE_HOURS
  );
  return {
    mode: resolveMode(env, revertRunId),
    minAttemptAgeMs: hours
      ? hours * 60 * 60 * 1000
      : UNRESOLVABLE_STUB_MIN_ATTEMPT_AGE_MS,
    revertRunId,
    limit: strictPositiveIntEnv("LIMIT", env.LIMIT),
  };
}

/**
 * A positive integer, or null when the variable is unset.
 *
 * THROWS on a value that is set but unusable rather than falling back, because
 * both callers fail OPEN on a silent fallback: a mistyped `LIMIT` would drop the
 * operator's cap and clear the whole population, and a mistyped
 * `MIN_ATTEMPT_AGE_HOURS` would substitute a shorter window than the one asked
 * for and widen the population. On a destructive run a rejected typo is the only
 * safe reading.
 *
 * `Number` over the WHOLE string, never `parseInt`, which reads a leading prefix
 * and returns 3 for "3oops" — a partially-parsed cap is a cap the operator did
 * not ask for, and it fails open in exactly the same direction as a dropped one.
 */
function strictPositiveIntEnv(name: string, value?: string): number | null {
  if (value === undefined || value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  if (!(Number.isInteger(parsed) && parsed > 0)) {
    throw new Error(`${name} must be a positive integer; got "${value}".`);
  }
  return parsed;
}

function resolveMode(
  env: BackfillEnv,
  revertRunId: string | null
): BackfillMode {
  if (revertRunId) {
    return BackfillMode.Revert;
  }
  return env.DRY_RUN === "0" ? BackfillMode.Apply : BackfillMode.DryRun;
}

async function main(output: ScriptOutput = scriptOutput): Promise<void> {
  const config = resolveRunConfig(process.env);
  if (config.mode === BackfillMode.Revert && config.revertRunId) {
    await reportRevert(
      config.revertRunId,
      await revertStampBackfill(config.revertRunId),
      output
    );
    return;
  }

  const cutoff = new Date(Date.now() - config.minAttemptAgeMs);
  // The summary is computed under the SAME limit the apply will use, so the KPI
  // step it prints is this run's, not the eligible population's.
  const population = await summarizeUnresolvableStubs(cutoff, config.limit);
  await output.log(
    `Attempt cutoff: ${cutoff.toISOString()} (min age ${config.minAttemptAgeMs / (60 * 60 * 1000)}h), limit ${config.limit ?? "none"}`
  );
  await reportPopulation(population, config.limit, output);

  if (config.mode === BackfillMode.DryRun) {
    await output.log(
      "\nDry run complete. Announce the step above, confirm ISS-8462 / #6214 " +
        "has landed, then set DRY_RUN=0 to execute."
    );
    return;
  }

  const runId = randomUUID();
  const cleared = await applyStampBackfill({
    runId,
    cutoff,
    limit: config.limit,
  });
  await reportRealizedStep(cleared, population.selectedTotal, output);
  await output.log(
    `\nCleared ${cleared.length} stamp(s). Run id ${runId} — revert with ` +
      `REVERT_RUN_ID=${runId}.`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    scriptOutput
      .error("Unresolvable PR stub backfill failed:", error)
      .finally(() => process.exit(1));
  });
}

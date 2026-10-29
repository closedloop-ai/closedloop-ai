/**
 * ISS-8463 — what the operator reads. Split out of
 * `backfill-unresolvable-pr-stubs.ts` (#6241 review) so presentation is not
 * tangled with the SQL it presents.
 *
 * ONE RULE GOVERNS EVERY LINE HERE: a number is labelled as the thing it
 * measures, never as the thing it resembles. The eligible population and the
 * rows a capped run actually clears are two different numbers, and this file
 * prints both rather than letting the larger one stand in for the smaller.
 */
import {
  RECONCILE_SESSION_LINKED_TARGET_BATCH,
  RECONCILE_VERIFIED_TAIL_BATCH_RESERVE,
} from "@/app/cron/reconcile-pull-requests/session-linked-targets";
import type {
  ClearedStubRow,
  RevertResult,
  UnresolvableStubGroup,
  UnresolvableStubPopulation,
} from "./backfill-unresolvable-pr-stubs-queries";
import { type ScriptOutput, scriptOutput } from "./script-progress-output";

/** Ticks per hour at the reconciler's 15-minute cadence. */
const RECONCILE_TICKS_PER_HOUR = 4;

/**
 * The stub backlog at which the reconciler's own batch split, not the 1h
 * debounce, sets a row's retry interval — `session-linked-targets.ts` derives
 * it, and past it a row gets materially fewer attempts per week than the
 * attempt-age cutoff assumes.
 *
 * DERIVED from the two batch constants rather than written as 48, so a change to
 * either moves this with it instead of leaving a stale literal behind.
 */
export const RECONCILER_STUB_QUEUEING_CLIFF =
  (RECONCILE_SESSION_LINKED_TARGET_BATCH -
    RECONCILE_VERIFIED_TAIL_BATCH_RESERVE) *
  RECONCILE_TICKS_PER_HOUR;

/**
 * The KPI step this run will take, per (org, repo), plus the population it is a
 * subset of.
 *
 * The per-group headline is `selectedCount` — the rows this run clears — because
 * that is the delta an operator announcing the delivery-coverage step is
 * actually about to cause. `eligibleCount` rides alongside it, explicitly
 * labelled, so a partial run cannot read as a complete one; before #6241 the
 * eligible count WAS the headline while the apply cleared only the globally
 * oldest `LIMIT` rows, which overstated the step for every group and invented one
 * entirely for groups the cap never reached.
 *
 * Groups at `selectedCount = 0` are still printed. They are the visible half of
 * the truncation: eligible, announced, and untouched.
 */
export async function reportPopulation(
  population: UnresolvableStubPopulation,
  limit: number | null,
  output: ScriptOutput = scriptOutput
): Promise<void> {
  await output.log(
    `Eligible unresolvable factless desktop PR stubs: ${population.eligibleTotal}`
  );
  await output.log(
    `Cleared by this run: ${population.selectedTotal} of ${population.eligibleTotal} eligible (LIMIT ${limit ?? "none"})`
  );
  if (population.truncated) {
    await output.log(
      `TRUNCATED: ${population.eligibleTotal - population.selectedTotal} eligible row(s) are NOT cleared by this run. ` +
        "The per-group step below is THIS RUN's selection, not the eligible population — " +
        "announce it as a partial step and re-run to clear the remainder."
    );
  }
  await output.log(
    "Delivery-coverage numerator (trustedVerifiedPrCount) step for THIS RUN, per (org, repo):"
  );
  for (const group of population.groups) {
    await output.log(
      `  ${groupLabel(group)} -${group.selectedCount} of ${group.eligibleCount} eligible (desktop stub backlog ${group.desktopStubBacklog})`
    );
  }
  await reportQueueingCliff(population.groups, output);
}

/**
 * The step that actually happened, regrouped from the rows the apply returned.
 *
 * The dry run's projection is a forecast: rows can leave the population between
 * the summary and the apply because the reconciler repaired them. This is the
 * only grouping computed from rows whose stamps are gone, so it — not the
 * forecast — is what an operator announces.
 */
export async function reportRealizedStep(
  cleared: ClearedStubRow[],
  projectedTotal: number,
  output: ScriptOutput = scriptOutput
): Promise<void> {
  await output.log(
    "\nRealized delivery-coverage numerator step (rows actually cleared), per (org, repo):"
  );
  if (cleared.length === 0) {
    await output.log("  (none — no row was cleared by this run)");
  }
  for (const [label, count] of groupClearedRows(cleared)) {
    await output.log(`  ${label} -${count}`);
  }
  if (cleared.length !== projectedTotal) {
    await output.log(
      `  NOTE: this run projected ${projectedTotal} row(s) and cleared ${cleared.length}. ` +
        "The difference left the population between the summary and the apply — " +
        "the realized grouping above is the authoritative step, not the projection."
    );
  }
}

/**
 * The three outcomes a revert can have, kept apart. A zero `closedCount` means
 * this call closed nothing — an already-reverted run, or a run id that matches
 * no capture — and must not be reported as rows the reconciler re-verified.
 */
export async function reportRevert(
  runId: string,
  result: RevertResult,
  output: ScriptOutput = scriptOutput
): Promise<void> {
  if (result.closedCount === 0) {
    await output.log(
      `Run ${runId}: nothing to revert — every capture was already reverted, or no capture carries this run id.`
    );
    return;
  }
  await output.log(
    `Reverted run ${runId}: ${result.restoredCount} row(s) restored, ${result.closedCount} capture(s) closed.`
  );
  if (result.closedCount !== result.restoredCount) {
    await output.log(
      `  ${result.closedCount - result.restoredCount} capture(s) were re-verified by the reconciler ` +
        "after clearing; their live measurement was left in place."
    );
  }
}

/**
 * Cleared rows folded to one count per (org, repo).
 *
 * The map is bounded by the number of distinct groups among the rows the apply
 * returned, which is bounded by the apply's own `LIMIT` and by the population it
 * scanned — it accumulates one query's result, never an open-ended stream, and
 * is discarded with the call.
 */
function groupClearedRows(cleared: ClearedStubRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of cleared) {
    const label = groupLabel(row);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return counts;
}

function groupLabel(group: {
  organizationId: string;
  repositoryFullName: string | null;
}): string {
  return `org=${group.organizationId} repo=${group.repositoryFullName ?? "(none)"}`;
}

async function reportQueueingCliff(
  groups: UnresolvableStubGroup[],
  output: ScriptOutput
): Promise<void> {
  const contended = groups.filter(
    (group) => Number(group.desktopStubBacklog) > RECONCILER_STUB_QUEUEING_CLIFF
  );
  for (const group of contended) {
    await output.log(
      `  WARNING ${groupLabel(group)}: backlog ${group.desktopStubBacklog} is past the reconciler's S=${RECONCILER_STUB_QUEUEING_CLIFF} queueing cliff, so these rows got FEWER retries than the cutoff assumes. Raise MIN_ATTEMPT_AGE_HOURS.`
    );
  }
}

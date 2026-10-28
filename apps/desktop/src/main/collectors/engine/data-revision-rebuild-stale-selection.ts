/**
 * @file data-revision-rebuild-stale-selection.ts
 * @description ISS-8601 — which stale-revision rows this pass will actually work.
 *
 * Extracted from `data-revision-rebuild.ts`, which sits under the
 * `noExcessiveLinesPerFile` ceiling with roughly ten logical lines to spare and
 * carries no grandfather entry, so the age bound could not be added in place.
 * Joins the `-outstanding` / `-progress` / `-projection-gate` /
 * `-stored-invocations` / `-summary-merge` sibling family.
 *
 * The admission RULE itself is not here: it is `classifyStaleRow` in
 * `data-revision.ts`, the module the database layer already imports for
 * `staleRebuildSkip`. Selection and both in-transaction guards ask that one
 * function, so the three cannot drift.
 */
import { classifyStaleRow, StaleRowAdmission } from "./data-revision.js";

/**
 * A row of the boot-time stale-revision snapshot.
 *
 * `lastActivityAt` is OPTIONAL, and the optionality is a TEST affordance rather
 * than a production one: the facade always selects the column (it is NOT NULL in
 * the schema), and the production `db` is the FEA-2038 forwarding proxy, which
 * answers every property. A test double that omits the field simply takes the
 * fail-closed branch, which is the same answer it gets today.
 */
export type StaleRevisionSessionRow = {
  id: string;
  harness: string | null;
  status: string;
  lastActivityAt?: string | null;
};

/** The counters {@link groupTerminalStaleByHarness} reports through. */
type StaleSelectionCounters = {
  skippedActive: number;
  wedgedActiveAdmitted: number;
};

/**
 * Group the rows this pass will rebuild, by harness key.
 *
 * A LIVE capture — non-terminal and active within the staleness bound — is left
 * alone and bumps `skippedActive`: it heals via ordinary reimport, which stamps
 * the revision, and rebuilding mid-capture would race the live write paths.
 *
 * A WEDGED row — non-terminal but silent past the bound — is admitted and bumps
 * `wedgedActiveAdmitted`. Nothing else will ever reach it: the stale-active sweep
 * holds back exactly these rows and leaves them untouched, so they stay
 * non-terminal for good and no ordinary reimport is coming. Without the bound
 * they are refused on every boot, forever.
 *
 * `now` is the store's clock, awaited once by the caller.
 */
export function groupTerminalStaleByHarness(
  stale: readonly StaleRevisionSessionRow[],
  counters: StaleSelectionCounters,
  now: Date
): Map<string, Set<string>> {
  const pendingByHarness = new Map<string, Set<string>>();
  for (const row of stale) {
    const admission = classifyStaleRow(row, now);
    if (admission === StaleRowAdmission.LiveCapture) {
      counters.skippedActive++;
      continue;
    }
    if (admission === StaleRowAdmission.WedgedNonTerminal) {
      counters.wedgedActiveAdmitted++;
    }
    const key = row.harness ?? "";
    const existing = pendingByHarness.get(key);
    if (existing) {
      existing.add(row.id);
    } else {
      pendingByHarness.set(key, new Set([row.id]));
    }
  }
  return pendingByHarness;
}

/**
 * The ids this pass admitted DESPITE being non-terminal.
 *
 * Kept so the pass can enforce ONE invariant at the place that would break it:
 * a wedged row must never reach the repair tail's stored-invocation bridge,
 * which stamps `data_revision` unconditionally. Sealing a wedged row there is
 * permanent — nothing re-selects a current-revision row — and it would leave the
 * duplicate the prune exists to remove in place forever.
 *
 * Enforced on the SET rather than on each route into the tail, because the
 * routes are several (a refused delete, a thrown delete, an unmatched source)
 * and a future one would silently inherit the hazard.
 */
export function wedgedAdmittedIds(
  stale: readonly StaleRevisionSessionRow[],
  now: Date
): Set<string> {
  const ids = new Set<string>();
  for (const row of stale) {
    if (classifyStaleRow(row, now) === StaleRowAdmission.WedgedNonTerminal) {
      ids.add(row.id);
    }
  }
  return ids;
}

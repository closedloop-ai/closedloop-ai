import "server-only";

import {
  AgentComponentSortDir,
  AgentComponentSortKey,
} from "@repo/api/src/types/agent-component";
import { resolveComponentHarness } from "./harness-attribution";
import { type MergedComponent, resolveMergedSource } from "./identity";
import { locPerDollarForKind, type SessionLocCost } from "./loc-per-dollar";

// ---------------------------------------------------------------------------
// Catalog list sort + pagination (ISS-4944)
//
// Extracted from `service.ts` (root AGENTS.md file-size rule, mirroring the
// `loc-per-dollar.ts` split): the per-sort-key comparators, their memoized
// metric lookup, and the paging slice are a cohesive, independently testable
// unit, and `service.ts` was already at the 500-line smell threshold.
// ---------------------------------------------------------------------------

/** Comparator over two merged entries for one {@link AgentComponentSortKey}. */
type ComponentComparator = (a: MergedComponent, b: MergedComponent) => number;

/**
 * ISS-4944 (wongk): the LOC/$ the row will DISPLAY, memoized per entry id so a
 * `sortBy=metric` sort computes each entry's metric once instead of once per
 * comparison. Same `locPerDollarForKind` the response mapping emits, so the sort
 * order and the rendered column can never disagree.
 */
function metricOf(
  entry: MergedComponent,
  locCostBySession: Map<string, SessionLocCost>,
  memo: Map<string, number | null>
): number | null {
  const cached = memo.get(entry.id);
  if (cached !== undefined) {
    return cached;
  }
  const value = locPerDollarForKind(
    entry.kind,
    entry.sessionIds,
    locCostBySession
  );
  memo.set(entry.id, value);
  return value;
}

/**
 * Order two LOC/$ values, ranking an unmeasured (`null`) metric BELOW every real
 * number so the common `metric`/`desc` sort puts unmeasured rows last. Compared
 * branch-wise rather than by substituting a `-Infinity` sentinel: two unmeasured
 * rows would then subtract to `NaN`, and `NaN !== 0` skips the caller's row-id
 * tiebreaker — silently dropping the deterministic paging guarantee for exactly
 * the most common case (only `subagent` has a verifiable LOC/$, so most catalogs
 * are mostly nulls).
 */
function compareMetric(a: number | null, b: number | null): number {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return -1;
  }
  if (b === null) {
    return 1;
  }
  return a - b;
}

/**
 * ISS-4944 (wongk): every `AgentComponentSortKey` the MCP tool, the docs, and
 * the Agents table advertise needs a real comparator here. `metric` and `source`
 * previously had none and fell through to the invocation default, so a caller
 * sorting by either silently got invocation order back. The exhaustive `Record`
 * (rather than a `switch` with a `default`) makes a newly added sort key a
 * typecheck failure instead of another silent fallthrough.
 *
 * Ties are broken by {@link sortAndPaginate} on the canonical row id.
 */
function buildComparators(
  locCostBySession: Map<string, SessionLocCost>
): Record<AgentComponentSortKey, ComponentComparator> {
  const metricMemo = new Map<string, number | null>();
  return {
    [AgentComponentSortKey.Name]: (a, b) =>
      (a.name ?? a.key).localeCompare(b.name ?? b.key),
    [AgentComponentSortKey.Type]: (a, b) => a.kind.localeCompare(b.kind),
    [AgentComponentSortKey.Metric]: (a, b) =>
      compareMetric(
        metricOf(a, locCostBySession, metricMemo),
        metricOf(b, locCostBySession, metricMemo)
      ),
    // FEA-4335: sort by the DISPLAYED, pack-first `source` (the same
    // `resolveMergedSource` the response emits and `?source=` filters on), not
    // the raw inventory `sourceUrl`.
    [AgentComponentSortKey.Source]: (a, b) =>
      resolveMergedSource(a).localeCompare(resolveMergedSource(b)),
    // FEA-3758: sort by the DISPLAYED harness (derived from the sessions the
    // component ran in), not the raw inventory-row harness — otherwise a
    // subagent shown as `codex` would sort under its null/`claude` inventory
    // value, diverging from what the user sees.
    [AgentComponentSortKey.Harness]: (a, b) =>
      resolveComponentHarness(a.usageHarnesses, a.harness).localeCompare(
        resolveComponentHarness(b.usageHarnesses, b.harness)
      ),
    [AgentComponentSortKey.Invocations]: (a, b) =>
      (a.totalInvocations ?? 0) - (b.totalInvocations ?? 0),
    [AgentComponentSortKey.Sessions]: (a, b) =>
      a.sessionIds.size - b.sessionIds.size,
  };
}

/**
 * Sort the collapsed org population by the requested column and slice one page
 * out of it. `total` counts the whole (already filtered) set, not the page.
 */
export function sortAndPaginate(
  entries: MergedComponent[],
  sortBy: string | undefined,
  sortDir: string | undefined,
  limit: number,
  offset: number,
  locCostBySession: Map<string, SessionLocCost>
): { page: MergedComponent[]; total: number } {
  const direction = sortDir === AgentComponentSortDir.Desc ? -1 : 1;
  const sortColumn =
    (sortBy as AgentComponentSortKey | undefined) ??
    AgentComponentSortKey.Invocations;
  const comparators = buildComparators(locCostBySession);
  // `sortBy` is validated against the enum upstream; an unknown value from a
  // version-skewed caller degrades to the invocations default. Resolved with
  // `Object.hasOwn` rather than a `??` fallback because the comparator table is
  // an object literal: an inherited key (`toString`, `valueOf`, `constructor`)
  // would otherwise resolve to an `Object.prototype` method and be called as a
  // comparator (root AGENTS.md: dispatch tables must not be indexed by an
  // untrusted key through the prototype chain).
  const compare = Object.hasOwn(comparators, sortColumn)
    ? comparators[sortColumn]
    : comparators[AgentComponentSortKey.Invocations];

  entries.sort((a, b) => {
    const cmp = compare(a, b);
    if (cmp !== 0) {
      return cmp * direction;
    }
    // Stable secondary sort on the canonical row id so rows with equal primary
    // sort keys keep a deterministic order across requests — otherwise offset
    // paging can skip or repeat a row at a page boundary. Applied in a fixed
    // ascending direction (not multiplied by `direction`) so the tiebreaker is
    // identical regardless of the primary sort direction.
    return a.id.localeCompare(b.id);
  });

  const total = entries.length;
  const page = entries.slice(offset, offset + limit);
  return { page, total };
}

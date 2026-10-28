"use client";

/**
 * Detail page — Branches tab (T-3.6).
 *
 * Thin wrapper around the shared `BranchesTable` component. Maps
 * `AgentComponentDetail.branchesTab` items (wire `BranchRow` from
 * `@repo/api/src/types/branch`) to the render `BranchRow` shape via the
 * `agent-component-branch-adapter` and renders the shared branches table.
 *
 * Does NOT port `apps/prototypes/app/p/agents/components/detail-branches-tab.tsx`
 * or its custom `BranchesTable` replica — it reuses the production shared table.
 *
 * Surface-agnostic: callers supply `getBranchHref` and `renderBranchLink` for
 * navigation when available; both are optional and the table degrades gracefully
 * when omitted (plain non-link branch lead, no row-actions).
 */

import type {
  AgentComponentDetail,
  ComponentVersion,
} from "@repo/api/src/types/agent-component";
import type { BranchRow as WireBranchRow } from "@repo/api/src/types/branch";
import type { BranchLeadRenderInput } from "@repo/app/branches/components/branches-table";
import { BranchesTable } from "@repo/app/branches/components/branches-table";
import type { BranchRow as RenderBranchRow } from "@repo/app/branches/lib/branch-row";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { AGENTS_BRANCH_USAGE_SIGNAL_STATES_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { GitBranchIcon } from "lucide-react";
import type { ReactNode } from "react";
import { adaptAgentComponentBranches } from "../../lib/agent-component-branch-adapter";
import { AGENTS_PAGE_SIZE } from "../../lib/agents-timeframe";
import {
  DetailTabUnit,
  detailTabTruncationReadout,
} from "../../lib/detail-tab-truncation-readout";
import { resolveUsageSignal, UsageSignal } from "../../lib/usage-signal";
import { versionLabelByBranch } from "../../lib/version-label";

export type { BranchLeadRenderInput } from "@repo/app/branches/components/branches-table";

/**
 * Sort key for a branch row's recency. Coerces `lastActivityAt` to a plain
 * string ("" when absent/non-string) so the `.localeCompare` sort below is
 * throw-proof against a malformed non-string value (FEA-3520 / #3208 class).
 */
function lastActivityKey(row: RenderBranchRow): string {
  const value = row.lastActivityAt;
  return typeof value === "string" ? value : "";
}

export function DetailBranchesTab({
  branches,
  branchesTabTruncated = false,
  usageSessions,
  versions,
  getBranchHref,
  renderBranchLink,
}: {
  /** Pre-fetched branches that reference this component (from `detail.branchesTab`). */
  branches: readonly WireBranchRow[];
  /**
   * ISS-5464: the PRODUCER's statement that `branches` is a bounded sample
   * (`detail.branchesTabTruncated`). Defaults to `false` so a caller rendering a
   * list it assembled itself never has a truncation invented for it.
   *
   * Drives TWO things, because one fact answers both: the truncation notice
   * under a populated table, and — via `measurableBranchCount` — whether a zero
   * is provable at all. The same cap that cost this tab branch ROWS also leaves
   * the dropped sessions' `usageSessions` entries at `branchName: null`, so a
   * truncated read cannot tell "ran on no branch" from "never looked".
   */
  branchesTabTruncated?: boolean;
  /**
   * Per-session version attribution (FEA-2923). When present (and a version
   * history exists), a "Version" column shows the revision that ran on each
   * branch (best-effort via the branch a session was attributed to).
   */
  usageSessions?: AgentComponentDetail["usageSessions"];
  versions?: readonly ComponentVersion[];
  /**
   * Optional: wrap the branch name lead in a plain `<a>` anchor using this href.
   * Takes precedence is used only when `renderBranchLink` is absent.
   */
  getBranchHref?: (item: RenderBranchRow) => string;
  /**
   * Optional: platform-owned branch lead renderer. Web injects a Next.js `Link`;
   * desktop can use the href fallback for hash navigation. When neither prop is
   * supplied the branch lead renders as plain (non-navigable) text.
   */
  renderBranchLink?: (input: BranchLeadRenderInput) => ReactNode;
}) {
  // ISS-5529 (ISS-4779 closed-by-default). `…Optional` so a mount site with no
  // flag provider (Storybook, a bare unit test) degrades to OFF — the shipped
  // two-arm reading — rather than crashing.
  const usageSignalStatesEnabled = useFeatureFlagEnabledOptional(
    AGENTS_BRANCH_USAGE_SIGNAL_STATES_FEATURE_FLAG_KEY
  );
  // Bound the rendered row count (FEA-3579). The detail page has no
  // pagination or virtualization, so a component referenced by a large number
  // of branches would render every branch row at once — blowing up the
  // DOM/memory and freezing the browser tab. Cap at AGENTS_PAGE_SIZE (the same
  // page size the list view uses) so the DOM stays bounded regardless of
  // dataset size.
  //
  // The wire `branchesTab` is unordered (its API query has no `orderBy`), so a
  // naive slice would drop *arbitrary* branches. Sort by `lastActivityAt`
  // descending first so the retained AGENTS_PAGE_SIZE rows are deterministically
  // the most-recently-active branches (mirrors the sessions tab, whose source is
  // already ordered by recency). Rows missing the timestamp sort last.
  //
  // `lastActivityAt` is typed `string | undefined`, but a malformed record can
  // deliver a non-string (a Date/number on a differently-shaped record); calling
  // `.localeCompare` on it would throw a `TypeError` and take the page down to
  // the route error boundary (FEA-3520, same class as #3208). So coerce both
  // operands to a plain string before comparing — never throw.
  const rows: RenderBranchRow[] = adaptAgentComponentBranches(branches)
    .slice()
    .sort((a, b) => lastActivityKey(b).localeCompare(lastActivityKey(a)))
    .slice(0, AGENTS_PAGE_SIZE);
  // ISS-5464: `branches.length` is a CAPPED array length, not a total. The wire
  // `branchesTab` is deduped upstream by `seenBranchIds` — and, from a producer
  // older than ISS-9855, bounded by its session fan-out too — and the detail
  // carries no uncapped
  // branch count the way it carries `sessions` — so the only honest thing this
  // tab can state is a FLOOR. Printing the array length as "of N" was the exact
  // bug the Sessions tab one click over just stopped doing, and left alone it
  // would have this page reporting its two tab totals under two different rules.
  // Disclose only when something actually went missing: either this tab visibly
  // cut the delivered array, or the producer says the array itself is a sample.
  // The total is ALWAYS marked a floor, because `branches.length` is a capped
  // array length and there is no uncapped branch count on the detail to fall
  // back to — the honest statement is "at least this many", never "exactly".
  const truncationNotice =
    rows.length < branches.length || branchesTabTruncated
      ? detailTabTruncationReadout({
          isTotalPartial: true,
          rendered: rows.length,
          total: branches.length,
          unit: DetailTabUnit.Branches,
        })
      : null;
  const labelByBranch = versionLabelByBranch(
    usageSessions ?? [],
    versions ?? []
  );
  const showVersion = labelByBranch.size > 0;

  // Zero-row state: mirror the shared Branches list surface, which renders the
  // DS `EmptyState` rather than a bare, body-less `GridTable` header. `compact`
  // is the in-panel scale (this tab sits inside the detail page).
  //
  // An empty `branchesTab` projection is NOT proof of "no branches" (whitlockk,
  // #3688). Desktop's local detail reader always returns `branchesTab: []`, so
  // an unconditional "no branches reference this component" is a claim its data
  // cannot support.
  //
  // ISS-5529: attributed-or-denial is still only two arms. ISS-5363 split
  // "measured none" from "could not measure" on the Sessions tab and the
  // token-trend chart and missed this one, because the signal here rides a
  // nested `branchName` rather than the top-level count that pass was hunting.
  // Session usage with no branch attribution is the unmeasured case, not a zero,
  // so it must not reach the denial — whether the attribution is missing per-row
  // (no `branchName` key) or declared partial by the producer
  // (`branchesTabTruncated`). `measurableBranchCount` owns both tests.
  if (rows.length === 0) {
    if (usageSignalStatesEnabled) {
      return (
        <BranchesEmptyState
          signal={resolveUsageSignal(
            measurableBranchCount(usageSessions, branchesTabTruncated),
            branchAttributedUsageCount(usageSessions)
          )}
        />
      );
    }
    return <BranchesEmptyState signal={legacyBranchSignal(usageSessions)} />;
  }

  return (
    <>
      <BranchesTable
        extraColumnLabel={showVersion ? "Version" : undefined}
        getBranchHref={getBranchHref}
        items={rows}
        renderBranchLink={renderBranchLink}
        renderExtraColumn={
          showVersion
            ? (item) =>
                labelByBranch.has(item.branchName) ? (
                  <span className="text-sm">
                    {labelByBranch.get(item.branchName)}
                  </span>
                ) : (
                  <span className="text-muted-foreground text-sm">—</span>
                )
            : undefined
        }
      />
      {truncationNotice ? (
        <p className="mt-2 text-muted-foreground text-sm">{truncationNotice}</p>
      ) : null}
    </>
  );
}

/** Attributed branch rows — direct evidence that branches reference this component. */
function branchAttributedUsageCount(
  usageSessions: AgentComponentDetail["usageSessions"] | undefined
): number {
  return (usageSessions ?? []).filter((usage) => Boolean(usage.branchName))
    .length;
}

/**
 * The branch count this payload can PROVE, or `undefined` when it proves none.
 *
 * The detail carries no branch count the way it carries `sessions`, so the proof
 * has to come from the usage rows themselves — and a ZERO is only a measurement
 * when the attribution behind it was COMPLETE. Two independent things can make
 * it partial, and a zero is unprovable if EITHER holds (whitlockk and davetho,
 * #7013). Both are checked here so one predicate owns the question; the caller's
 * `resolveUsageSignal` still short-circuits to `Present` on a positive
 * attribution count first, so evidence that branches exist is never withheld by
 * a completeness doubt about the rest of the set.
 *
 * PER-ROW (the field). Each row states its producer's capability by carrying
 * `branchName` or not. The cloud read runs the attribution unconditionally and
 * pushes `{ sessionId, branchName, invocationCount }` with `branchName: null`
 * for a session it found no branch link for, so a null there is the measurement:
 * this session ran on no branch. Desktop's local reader emits
 * `{ sessionId, invocationCount }` — no `branchName` key at all — because it has
 * no branch-attribution projection, so its silence measures nothing. `undefined`
 * means "not projected", `null` means "projected, and there was none". The test
 * is `every`, not `some`: one attributed row does not make the OTHER rows
 * measured, and a mixed payload (a version-skewed producer mid-upgrade) would
 * otherwise count the unprojected rows as measured zeros and reach the denial.
 *
 * PRODUCER-DECLARED (the truncation). `branchesTabTruncated` is the producer
 * saying the branch-attribution read itself was a bounded sample: a producer
 * that caps its lookup below its own session set while `buildUsageSessions`
 * still emits a row for EVERY session leaves a session past the cap resolving
 * to `branchName: null` with the key present — byte-identical to a session the
 * read reached and found no branch for. Nothing in the payload separates them,
 * so no count taken from it is a measurement. ISS-9855 made the cloud read walk
 * every session, so it now sends `false` as desktop always has; the flag is
 * still honoured because a version-skewed producer can still send `true`.
 */
function measurableBranchCount(
  usageSessions: AgentComponentDetail["usageSessions"] | undefined,
  branchesTabTruncated: boolean
): number | undefined {
  if (usageSessions === undefined) {
    return undefined;
  }
  if (branchesTabTruncated) {
    return undefined;
  }
  if (usageSessions.length === 0) {
    return 0;
  }
  const projectsBranchAttribution = usageSessions.every(
    (usage) => usage.branchName !== undefined
  );
  return projectsBranchAttribution
    ? branchAttributedUsageCount(usageSessions)
    : undefined;
}

/** The shipped two-arm reading, kept verbatim for the closed default. */
function legacyBranchSignal(
  usageSessions: AgentComponentDetail["usageSessions"] | undefined
): UsageSignal {
  return branchAttributedUsageCount(usageSessions) > 0
    ? UsageSignal.Present
    : UsageSignal.None;
}

/**
 * The zero-row state, split by what the payload can actually prove — the Branches
 * counterpart of `SessionsEmptyState` one file over.
 *
 * `Present` is the whitlockk/#3688 case: attribution rows exist while the branch rows
 * are not hydrated. `Unknown` is the ISS-5529 case: nothing here measured branch
 * usage, so neither the denial NOR the "can't list them" claim is true.
 */
function BranchesEmptyState({ signal }: { signal: UsageSignal }) {
  if (signal === UsageSignal.Present) {
    return (
      <EmptyState
        description="This data source can't list the branches that reference this component."
        icon={GitBranchIcon}
        size="compact"
        title="Branch details unavailable"
      />
    );
  }
  if (signal === UsageSignal.Unknown) {
    return (
      <EmptyState
        description="This data source couldn't report the branches for this component."
        icon={GitBranchIcon}
        size="compact"
        title="Branches unavailable"
      />
    );
  }
  return (
    <EmptyState
      description="No branches reference this component yet."
      icon={GitBranchIcon}
      size="compact"
      title="No branches yet"
    />
  );
}

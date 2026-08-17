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
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { GitBranchIcon } from "lucide-react";
import type { ReactNode } from "react";
import { adaptAgentComponentBranches } from "../../lib/agent-component-branch-adapter";
import { AGENTS_PAGE_SIZE } from "../../lib/agents-timeframe";
import {
  DetailTabUnit,
  detailTabTruncationReadout,
} from "../../lib/detail-tab-truncation-readout";
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
  // `.localeCompare` on it would throw a `TypeError` inside the page's
  // LiveblocksErrorBoundary → crash-spiral (FEA-3520, same class as #3208). So
  // coerce both operands to a plain string before comparing — never throw.
  const rows: RenderBranchRow[] = adaptAgentComponentBranches(branches)
    .slice()
    .sort((a, b) => lastActivityKey(b).localeCompare(lastActivityKey(a)))
    .slice(0, AGENTS_PAGE_SIZE);
  // ISS-5464: `branches.length` is a CAPPED array length, not a total. The wire
  // `branchesTab` is bounded upstream by the `MAX_DETAIL_SESSION_IN_IDS` session
  // fan-out plus the `seenBranchIds` dedupe, and the detail carries no uncapped
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
  // An empty `branchesTab` projection is NOT proof of "no branches" (wongk,
  // #3688). Desktop's local detail reader always returns `branchesTab: []`, so
  // an unconditional "no branches reference this component" is a claim its data
  // cannot support. `usageSessions` still carries branch attribution
  // (`branchName`) even when the branch rows aren't hydrated, so treat any
  // attributed branch as a "details unavailable" signal and reserve the
  // true-zero copy for when there is genuinely no branch usage at all.
  if (rows.length === 0) {
    const hasBranchUsageSignal = (usageSessions ?? []).some((usage) =>
      Boolean(usage.branchName)
    );
    return hasBranchUsageSignal ? (
      <EmptyState
        description="This data source can't list the branches that reference this component."
        icon={GitBranchIcon}
        size="compact"
        title="Branch details unavailable"
      />
    ) : (
      <EmptyState
        description="No branches reference this component yet."
        icon={GitBranchIcon}
        size="compact"
        title="No branches yet"
      />
    );
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

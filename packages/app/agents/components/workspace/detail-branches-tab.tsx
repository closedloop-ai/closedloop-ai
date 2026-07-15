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

import type { BranchRow as WireBranchRow } from "@repo/api/src/types/branch";
import type { BranchLeadRenderInput } from "@repo/app/branches/components/branches-table";
import { BranchesTable } from "@repo/app/branches/components/branches-table";
import type { BranchRow as RenderBranchRow } from "@repo/app/branches/lib/branch-row";
import type { ReactNode } from "react";
import { adaptAgentComponentBranches } from "../../lib/agent-component-branch-adapter";

export type { BranchLeadRenderInput } from "@repo/app/branches/components/branches-table";
export type { BranchRow as RenderBranchRow } from "@repo/app/branches/lib/branch-row";

export function DetailBranchesTab({
  branches,
  getBranchHref,
  renderBranchLink,
}: {
  /** Pre-fetched branches that reference this component (from `detail.branchesTab`). */
  branches: readonly WireBranchRow[];
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
  const rows: RenderBranchRow[] = adaptAgentComponentBranches(branches);

  return (
    <BranchesTable
      getBranchHref={getBranchHref}
      items={rows}
      renderBranchLink={renderBranchLink}
    />
  );
}

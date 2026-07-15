/**
 * Thin row adapter: API BranchRow[] → render BranchRow[] (T-3.6).
 *
 * Maps the pre-fetched `AgentComponentDetail.branchesTab` items (wire
 * `BranchRow` from `@repo/api/src/types/branch`) to the render `BranchRow`
 * shape consumed by the shared `BranchesTable` component (from
 * `packages/app/branches/lib/branch-row`).
 *
 * Delegates to the existing `adaptBranchRows` helper in `branch-row-adapter`
 * to keep the mapping canonical and co-located with the branches feature slice.
 */

import type { BranchRow as WireBranchRow } from "@repo/api/src/types/branch";
import type { BranchRow as RenderBranchRow } from "@repo/app/branches/lib/branch-row";
import { adaptBranchRows } from "@repo/app/branches/lib/branch-row-adapter";

export type { BranchRow as RenderBranchRow } from "@repo/app/branches/lib/branch-row";

/**
 * Map `AgentComponentDetail.branchesTab` items (wire `BranchRow`) to the
 * render `BranchRow` shape accepted by `BranchesTable`.
 *
 * NULL enrichment degrades to render placeholders — never a fabricated value.
 *
 * Returns `RenderBranchRow[]` ready for the shared `BranchesTable` component.
 */
export function adaptAgentComponentBranches(
  branches: readonly WireBranchRow[]
): RenderBranchRow[] {
  return adaptBranchRows(branches as WireBranchRow[]);
}

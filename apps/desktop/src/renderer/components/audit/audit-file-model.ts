/**
 * @file audit-file-model.ts
 * @description FEA-3849 (PRD-556 M3) — the pure renderer-side glue between a
 * finding view and its ClosedLoop filing outcome.
 *
 * The `audit:file` result reports one outcome per requested finding, **in
 * request order** (see `AuditFileResult.filed`). Two selected findings can
 * normalize to the SAME dedup key within one batch — the first is `created`,
 * the rest `skipped` by the dedup guard — so a *key*-based lookup would mark
 * both rows the same and drop both from triage, hiding that only one was
 * actually filed. This module therefore correlates outcomes to the selected
 * views by **request position** (view id ← the position it was sent in), which
 * is 1:1 and collision-free, instead of by dedup key.
 *
 * Pure and dependency-light (local types only, no React / `window` / crewd) so
 * it is unit-testable in the node slice and shared by the list and the view.
 */
import { FiledFindingStatus } from "@repo/crewd/passes/findings";
import type { AuditFiledFinding } from "../../../shared/audit-contract";
import type { AuditFindingView } from "./audit-finding-model";

/**
 * The per-row filing status shown in the triage list after a file action: the
 * finding was created, deduped/skipped, or failed (a per-finding create error
 * in a partial batch). A whole failed file (`ok: false`, empty `filed`) is
 * surfaced by the outcome banner, not a per-row badge.
 */
export const FindingFileStatus = {
  Created: FiledFindingStatus.Created,
  Skipped: FiledFindingStatus.Skipped,
  Failed: FiledFindingStatus.Failed,
} as const;
export type FindingFileStatus =
  (typeof FindingFileStatus)[keyof typeof FindingFileStatus];

/**
 * Correlate each selected view to its filing outcome **by request position**,
 * returning a view-id → status map. `selectedViews[i]` was sent as
 * `request.findings[i]`, so it pairs with `filed[i]` — the collision-free
 * identity. When two views share a dedup key, the first (created) and the
 * second (skipped) each get their own correct badge, and only the created one
 * is later dropped from triage.
 *
 * A defensive length guard keeps the map empty if the outcome count ever drifts
 * from the request count (a contract violation), rather than mis-pairing.
 */
export function correlateFileOutcomes(
  selectedViews: readonly AuditFindingView[],
  filed: readonly AuditFiledFinding[]
): Map<string, FindingFileStatus> {
  const map = new Map<string, FindingFileStatus>();
  if (selectedViews.length !== filed.length) {
    return map;
  }
  for (const [index, view] of selectedViews.entries()) {
    const outcome = filed[index];
    map.set(view.id, toFindingFileStatus(outcome.status));
  }
  return map;
}

/**
 * The view ids that were newly **created** in this batch (position-correlated).
 * Only created findings are dropped from triage — skipped/deduped ones linger
 * so the user sees they were not re-filed.
 */
export function createdViewIds(
  selectedViews: readonly AuditFindingView[],
  filed: readonly AuditFiledFinding[]
): string[] {
  const statusByViewId = correlateFileOutcomes(selectedViews, filed);
  const ids: string[] = [];
  for (const view of selectedViews) {
    if (statusByViewId.get(view.id) === FindingFileStatus.Created) {
      ids.push(view.id);
    }
  }
  return ids;
}

/** Map the wire status to the per-row outcome the list badges (exhaustive). */
function toFindingFileStatus(status: FiledFindingStatus): FindingFileStatus {
  if (status === FiledFindingStatus.Created) {
    return FindingFileStatus.Created;
  }
  if (status === FiledFindingStatus.Failed) {
    return FindingFileStatus.Failed;
  }
  return FindingFileStatus.Skipped;
}

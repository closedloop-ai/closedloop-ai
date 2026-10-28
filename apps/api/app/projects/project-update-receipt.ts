import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { Project as PrismaProject } from "@repo/database";
import { customFieldChanges } from "@/lib/operation-receipts/changed-fields";
import type { OperationReceiptWrite } from "@/lib/operation-receipts/operation-receipt-writer";

/**
 * ISS-12552: the project columns `PUT /projects/[id]` can write, for its
 * receipt's `changedFields`. The `expected*` keys are compare-and-set guards,
 * not writes. Every entry must be a project column, so a renamed one fails
 * `tsc` here instead of silently dropping out of the diff.
 */
export const PROJECT_UPDATE_FIELDS = [
  "name",
  "description",
  "priority",
  "status",
  "assigneeId",
  "targetDate",
  "settings",
  "codebaseSummary",
  "lastIndexedAt",
] as const satisfies readonly (keyof PrismaProject)[];

/** The `changedFields` entry for a project's team set. */
export const PROJECT_TEAMS_CHANGED_FIELD = "teamIds";

/** The `select` that reads exactly those columns. */
export const PROJECT_UPDATE_SELECT = {
  name: true,
  description: true,
  priority: true,
  status: true,
  assigneeId: true,
  targetDate: true,
  settings: true,
  codebaseSummary: true,
  lastIndexedAt: true,
} as const satisfies Record<(typeof PROJECT_UPDATE_FIELDS)[number], true>;

/**
 * ISS-12552: one receipt for a project update and its custom fields,
 * written in the same transaction. A request that moved no column, team or
 * custom field value is a no-op (PRD-800 "An update or saved version that
 * changes no content and no persisted field is a no-op").
 */
export function projectUpdateReceiptWrite(
  changedFields: readonly string[],
  movedCustomFieldIds: readonly string[]
): OperationReceiptWrite {
  const moved = [...changedFields, ...customFieldChanges(movedCustomFieldIds)];
  return {
    operationKind: OperationKind.ProjectWrite,
    outcome:
      moved.length > 0
        ? OperationReceiptOutcome.Committed
        : OperationReceiptOutcome.NoOp,
    changedFields: moved,
  };
}

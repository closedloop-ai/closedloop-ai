import type { TableBulkActionDescriptor } from "@repo/design-system/components/ui/table-bulk-actions";
// The tag action id is the Tags slice's, shared with Session and Branch lists.
import { BULK_TAG_ACTION_ID } from "../../../tags/lib/bulk-tag-labels";
import { BULK_PRIORITY_ACTION_ID } from "./bulk-priority-picker";
import { BULK_STATUS_ACTION_ID } from "./bulk-status-picker";

/**
 * Every mutation control `useDocumentsBulkActionDescriptors` can produce, as a
 * CLOSED set, each id read from the owning picker rather than respelled.
 *
 * It sits apart from that hook so a host can hold the hook's output against this
 * union without importing the hook — which is also what stops a test that mocks
 * the hook from hollowing the union out.
 */
export const DocumentsBulkActionId = {
  ChangeStatus: BULK_STATUS_ACTION_ID,
  ChangePriority: BULK_PRIORITY_ACTION_ID,
  AddTag: BULK_TAG_ACTION_ID,
} as const;
export type DocumentsBulkActionId =
  (typeof DocumentsBulkActionId)[keyof typeof DocumentsBulkActionId];

/**
 * A descriptor that hook may emit. The id is pinned rather than left as
 * `TableBulkActionDescriptor`'s bare `string`, so a control added to the hook
 * cannot reach a host without being named above first — and the rail's
 * permission table is keyed by this union, so naming it is what forces the rule.
 */
export type DocumentsBulkActionDescriptor = TableBulkActionDescriptor & {
  id: DocumentsBulkActionId;
};

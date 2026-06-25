"use client";

import type { Priority } from "@repo/api/src/types/common";
import type { DocumentStatus } from "@repo/api/src/types/document";
import type {
  LoopSummariesResponse,
  LoopWithUser,
} from "@repo/api/src/types/loop";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { createContext } from "react";

/**
 * Per-row edit handlers and ambient row data, provided by `DocumentRow` and
 * consumed by the cell components under `table/cells/` (FEA-1763 / PLN-874
 * Phase 3; extracted from document-row.tsx so the cells and the row component
 * don't form an import cycle).
 */
export type RowEditHandlers = {
  onUpdateAssignee?: (itemId: string, assigneeId: string | null) => void;
  onUpdatePriority?: (itemId: string, priority: Priority) => void;
  onUpdateDueDate?: (itemId: string, date: Date | null) => void;
  onUpdateStatus?: (itemId: string, status: DocumentStatus) => void;
  /** Team members for the UserSelectPopover. */
  teamMembers?: User[];
  /** Active loops for displaying per-artifact loop status. */
  activeLoops?: LoopWithUser[];
  /**
   * Optional O(1) lookup of the active loop per document id, derived once from
   * `activeLoops` by the provider. When present, loop cells use this instead of
   * an O(activeLoops) linear scan per row (avoids O(rows × activeLoops)).
   * Falls back to scanning `activeLoops` when absent. Keyed by the first active
   * loop seen for a given document id, matching the previous `.find` semantics.
   */
  activeLoopsByDocumentId?: Map<string, LoopWithUser>;
  /** Parent entity title, injected per-row for the Parent column cell. */
  parentTitle?: string;
  /** Parent entity route, injected per-row for the Parent column cell. */
  parentHref?: string | null;
  /** Selects which LoopCell variant to render. Default = legacy behavior. */
  loopVariant?: "team" | "my-tasks";
  /** Per-document loop summaries (recursive descendant aggregation). */
  loopSummaries?: LoopSummariesResponse;
};

export const RowEditContext = createContext<RowEditHandlers>({});

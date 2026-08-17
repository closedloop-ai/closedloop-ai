"use client";

import type { Priority } from "@repo/api/src/types/common";
import type { ArtifactStatus } from "@repo/api/src/types/document";
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
  onUpdateStatus?: (itemId: string, status: ArtifactStatus) => void;
  /** Team members for the UserSelectPopover. */
  teamMembers?: User[];
  /** Parent entity title, injected per-row for the Parent column cell. */
  parentTitle?: string;
  /** Parent entity route, injected per-row for the Parent column cell. */
  parentHref?: string | null;
  /**
   * Which surface variant the row renders in. `my-tasks` renders editable cells
   * in a compact form (see `table/cells/edit-cells.tsx`) and opts that surface
   * into the constant-column collapse (`collapseConstantColumns` in
   * `table/column-collapse.ts`).
   */
  surfaceVariant?: "team" | "my-tasks";
};

export const RowEditContext = createContext<RowEditHandlers>({});

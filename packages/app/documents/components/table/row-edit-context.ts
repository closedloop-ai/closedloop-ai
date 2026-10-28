"use client";

import type { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
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
  /** ISS-9665: `null` clears the priority. Only ever emitted for rows whose
   * entity can hold it — see `ArtifactPriorityMenu`'s `allowUnset`. */
  onUpdatePriority?: (itemId: string, priority: Priority | null) => void;
  /** Returns the write settlement so retained-failure cells can render refusals. */
  onUpdateDueDate?: (
    itemId: string,
    date: Date | null,
    recoverableErrorOwner?: () => boolean
  ) => Promise<unknown> | undefined;
  onUpdateStatus?: (
    itemId: string,
    status: ArtifactStatus,
    surface: ArtifactStatusEditSurface
  ) => void;
  onUpdateTitle?: (
    itemId: string,
    title: string,
    expectedTitle: string
  ) => Promise<unknown> | undefined;
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

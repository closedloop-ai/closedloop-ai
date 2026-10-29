"use client";

import type { Priority } from "@repo/api/src/types/common";
import { ArtifactPriorityEditor } from "@repo/app/documents/components/artifact-priority/artifact-priority-editor";
import {
  ProjectDueDateValue,
  ProjectOwnerValue,
} from "@repo/app/projects/components/projects-table";
import { PROJECT_SUMMARY_COLUMN_LABELS } from "@repo/app/projects/lib/project-summary-columns";
import type { ProjectSummaryRow } from "@repo/app/projects/lib/project-summary-row";
import {
  ARTIFACT_PRIORITY_SUPPORT,
  ArtifactPrioritySurface,
  ArtifactPriorityVariant,
} from "@repo/app/shared/lib/artifact-priority-ownership";
import { DatePickerPopover } from "@repo/design-system/components/ui/date-picker-popover";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { UserSelectPopover } from "@repo/design-system/components/ui/user-select-popover";

/**
 * The web host's inline editors for the portable Projects grid (ISS-10476
 * review — codex P1, tamsinb).
 *
 * Promoting the surface moved the value columns onto `GridTableV2` cells, which
 * the `DocumentRow`-based table's editable cells cannot paint: those carry their
 * own fixed-width, left-bordered cell box, and the grid cell already is one. So
 * these are the same three CONTROLS the surface they replace opens — the
 * canonical `ArtifactPriorityEditor`, `UserSelectPopover` and
 * `DatePickerPopover` — mounted directly in the grid's own cell box rather than
 * a second box inside it.
 *
 * Each is a picker: a pick IS the write, so there is no draft to commit, no
 * blur/Escape interlock, and nothing here forks the ISS-9347 commit ledger.
 *
 * They live in the host, beside `ProjectRowActions`, for the reason the row menu
 * does: a mutation needs the page's own handlers and this organization's people,
 * and `ProjectList` is also mounted by a prototype that has neither.
 */

const PROJECT_PRIORITY_SUPPORT =
  ARTIFACT_PRIORITY_SUPPORT[ArtifactPrioritySurface.Project];

export function ProjectPriorityEditorCell({
  onUpdatePriority,
  row,
}: {
  onUpdatePriority: (projectId: string, priority: Priority | null) => void;
  row: ProjectSummaryRow;
}) {
  return (
    <ArtifactPriorityEditor
      onSelect={(priority) => onUpdatePriority(row.id, priority)}
      priority={row.priority}
      // The surface's own declaration decides both whether there is a control
      // at all and whether it may CLEAR the value; re-deciding either here is
      // how the 2026-09-11 ruling gets widened by accident.
      support={PROJECT_PRIORITY_SUPPORT}
      variant={ArtifactPriorityVariant.Label}
    />
  );
}

export function ProjectOwnerEditorCell({
  onUpdateAssignee,
  row,
  users,
}: {
  onUpdateAssignee: (projectId: string, assigneeId: string | null) => void;
  row: ProjectSummaryRow;
  users: User[];
}) {
  const ownerName = row.owner?.name;
  return (
    <UserSelectPopover
      onSelect={(user) => onUpdateAssignee(row.id, user?.id ?? null)}
      trigger={
        <button
          // The visible content already carries the owner's name, so the name
          // the field adds sits in front of it rather than replacing it (WCAG
          // 2.5.3). With no owner the cell's own words state the absence and
          // the field label stands alone.
          aria-label={
            ownerName
              ? `${PROJECT_SUMMARY_COLUMN_LABELS.owner}: ${ownerName}`
              : PROJECT_SUMMARY_COLUMN_LABELS.owner
          }
          className="flex h-full w-full min-w-0 items-center rounded-sm text-left hover:bg-muted/50"
          onClick={(event) => event.stopPropagation()}
          type="button"
        >
          <ProjectOwnerValue row={row} />
        </button>
      }
      users={users}
      value={
        row.owner?.id
          ? {
              avatarUrl: row.owner.avatarUrl,
              id: row.owner.id,
              name: row.owner.name,
            }
          : null
      }
    />
  );
}

export function ProjectDueDateEditorCell({
  onUpdateTargetDate,
  row,
}: {
  onUpdateTargetDate: (
    projectId: string,
    date: Date | null
  ) => Promise<unknown> | undefined;
  row: ProjectSummaryRow;
}) {
  const dueDateLabel = row.dueDateLabel;
  return (
    <DatePickerPopover
      onSelect={(date) => {
        // The mutation's own `onError` toasts a refusal; this picker has no
        // ledger to hand the settlement to, so only the rejection is dropped.
        onUpdateTargetDate(row.id, date)?.catch(ignoreRefusedTargetDate);
      }}
      trigger={
        <button
          // Same rule as the owner cell: the date the reader can see stays in
          // the accessible name, and an undated cell shows a dash rather than
          // words, so there the field label is the whole name.
          aria-label={
            dueDateLabel
              ? `${PROJECT_SUMMARY_COLUMN_LABELS.dueDate}: ${dueDateLabel}`
              : PROJECT_SUMMARY_COLUMN_LABELS.dueDate
          }
          className="flex h-full w-full min-w-0 items-center rounded-sm text-left hover:bg-muted/50"
          onClick={(event) => event.stopPropagation()}
          type="button"
        >
          <ProjectDueDateValue row={row} />
        </button>
      }
      value={row.dueDateMs === null ? null : new Date(row.dueDateMs)}
    />
  );
}

function ignoreRefusedTargetDate() {
  // Feedback for the refusal is the mutation's toast.
}

"use client";

import { ArtifactPriorityEditor } from "@repo/app/documents/components/artifact-priority/artifact-priority-editor";
import { useDocumentCellClasses } from "@repo/app/documents/components/table/cells/cell-frame";
import { CellTooltip } from "@repo/app/documents/components/table/cells/cell-tooltip";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { RowEditContext } from "@repo/app/documents/components/table/row-edit-context";
import { getRowTypeConfig } from "@repo/app/documents/components/table/row-type-registry";
import { documentRowPrioritySupport } from "@repo/app/documents/lib/document-row-priority-surface";
import { AssigneeAvatar } from "@repo/app/shared/components/assignee-avatar";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { ArtifactPriorityVariant } from "@repo/app/shared/lib/artifact-priority-ownership";
import {
  ensureDate,
  formatDateCompact,
  formatDateForInput,
} from "@repo/app/shared/lib/date-utils";
import { ARTIFACT_CELL_PRIMITIVES_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { INLINE_EDIT_SAVE_ERROR_MESSAGE } from "@repo/app/shared/lib/inline-edit-save-error";
import {
  getUserDisplayName,
  UNASSIGNED_ASSIGNEE_LABEL,
} from "@repo/app/shared/lib/user-utils";
import { DatePickerPopover } from "@repo/design-system/components/ui/date-picker-popover";
import { InlineScalarCell } from "@repo/design-system/components/ui/inline-scalar-cell";
import { UserSelectPopover } from "@repo/design-system/components/ui/user-select-popover";
import { cn } from "@repo/design-system/lib/utils";
import { CalendarIcon } from "lucide-react";
import { useCallback, useContext, useEffect, useRef } from "react";

/**
 * Inline-edit column cells: due date, assignee, and priority (FEA-1763 /
 * PLN-874 Phase 3; extracted from document-row.tsx). Rows whose registry
 * config is `editable: false` render a read-only dash.
 */

/**
 * Due-date content shared by the read-only and editable branches so the two
 * can't drift. ISS-6384 named this pair (`:48-61` vs `:64-74` as it stood) as
 * one of the duplicated read-only/editable branches in this file; the priority
 * pair it named alongside them is gone, absorbed by `ArtifactPriority`.
 */
function DueDateContent({ date }: { date: Date | null }) {
  return (
    <>
      <div className="flex w-8 shrink-0 items-center justify-center py-2">
        <CalendarIcon className="h-4 w-4 text-muted-foreground" />
      </div>
      <span className="truncate font-medium text-muted-foreground text-xs">
        {date ? formatDateCompact(date) : "—"}
      </span>
    </>
  );
}

export function DueDateCell({ item }: { item: DocumentRowItem }) {
  const { onUpdateDueDate } = useContext(RowEditContext);
  const cells = useDocumentCellClasses();
  // ISS-6384. `…Optional` so a mount site with no flag provider (Storybook, a
  // bare row test) degrades to OFF — this file's own popover — rather than
  // crashing.
  const sharedCells = useFeatureFlagEnabledOptional(
    ARTIFACT_CELL_PRIMITIVES_FEATURE_FLAG_KEY
  );
  const rowEditable = getRowTypeConfig(item)?.editable !== false;
  const feedbackOwnerAvailableRef = useRef(false);
  const feedbackOwnerAvailable =
    rowEditable && sharedCells && Boolean(onUpdateDueDate);
  feedbackOwnerAvailableRef.current = feedbackOwnerAvailable;
  useEffect(() => {
    feedbackOwnerAvailableRef.current = feedbackOwnerAvailable;
    return () => {
      feedbackOwnerAvailableRef.current = false;
    };
  }, [feedbackOwnerAvailable]);
  const recoverableErrorOwner = useCallback(
    () => feedbackOwnerAvailableRef.current,
    []
  );
  if (!rowEditable) {
    return (
      <div className={cn(cells.box, "text-muted-foreground text-xs")}>—</div>
    );
  }
  // Projects use targetDate; artifacts/features use updatedAt as a placeholder
  const date =
    item.kind === "project"
      ? ensureDate(item.data.targetDate)
      : ensureDate(item.data.updatedAt);

  // ISS-6384: the shared inline date primitive. It is the same
  // `DatePickerPopover` underneath — this cell is the reference the ticket
  // pointed the primitive at — so what the flag buys is that every grid in the
  // product reaches it through one component with one empty state, one
  // accessible name, and one refused-write rollback, instead of each table
  // wiring the popover to its own trigger.
  if (sharedCells) {
    const onCommit = (next: string) =>
      onUpdateDueDate?.(
        item.data.id,
        next ? ensureDate(next) : null,
        recoverableErrorOwner
      );
    return (
      <div className={cn(cells.bareBox, "flex items-center px-3")}>
        <InlineScalarCell
          label="Due date"
          onCommit={onCommit}
          readOnly={!onUpdateDueDate}
          retainRejectedDraft
          saveErrorMessage={INLINE_EDIT_SAVE_ERROR_MESSAGE}
          type="date"
          value={date ? formatDateForInput(date) : ""}
        />
      </div>
    );
  }

  if (!onUpdateDueDate) {
    return (
      <div className={cn(cells.box, "gap-0")}>
        <DueDateContent date={date} />
      </div>
    );
  }

  return (
    <DatePickerPopover
      onSelect={(d) => {
        // The host mutation's own `onError` toasts a refusal; this popover has
        // no ledger to hand the settlement to, so only the rejection is dropped.
        onUpdateDueDate(item.data.id, d)?.catch(ignoreRefusedDueDate);
      }}
      trigger={
        <button
          className={cn(cells.box, "gap-0 hover:bg-muted/50")}
          onClick={(e) => e.stopPropagation()}
          type="button"
        >
          <DueDateContent date={date} />
        </button>
      }
      value={date}
    />
  );
}

/**
 * Assignee content shared by the read-only and editable branches so the two
 * can't drift. ISS-6384
 * named this pair (`:95-115` vs `:118-136` as it stood) as the second of the
 * duplicated read-only/editable branches in this file. No shared primitive
 * absorbs it: an assignee is a person picker, not a scalar, so this file's own
 * established pattern is the fix rather than a cell.
 */
function AssigneeContent({
  assignee,
}: {
  assignee: DocumentRowItem["data"]["assignee"] | null;
}) {
  return (
    <>
      <div className="flex shrink-0 items-center justify-center p-1.5">
        {/* Decorative only where the span below states the same name: the
            editable branch wraps both in one button, whose accessible name
            would otherwise fold the two into "Ada Lovelace Ada Lovelace". The
            unassigned branch renders no span, so there the avatar is the only
            statement and keeps its name. */}
        <AssigneeAvatar
          assignee={assignee}
          className="size-5"
          decorative={Boolean(assignee)}
          disableLink
          disableTooltip
        />
      </div>
      {assignee && (
        <span className="truncate font-medium text-muted-foreground text-xs">
          {getUserDisplayName(assignee)}
        </span>
      )}
    </>
  );
}

export function AssigneeCell({ item }: { item: DocumentRowItem }) {
  const { onUpdateAssignee, teamMembers } = useContext(RowEditContext);
  const cells = useDocumentCellClasses();
  if (getRowTypeConfig(item)?.editable === false) {
    return (
      <div className={cn(cells.box, "text-muted-foreground text-xs")}>—</div>
    );
  }
  const assignee = item.data.assignee ?? null;
  const assigneeLabel = assignee
    ? getUserDisplayName(assignee)
    : UNASSIGNED_ASSIGNEE_LABEL;

  if (!(onUpdateAssignee && teamMembers)) {
    return (
      <CellTooltip text={assigneeLabel}>
        <div className={cn(cells.box, "gap-0")}>
          <AssigneeContent assignee={assignee} />
        </div>
      </CellTooltip>
    );
  }

  return (
    <CellTooltip text={assigneeLabel}>
      <div className={cells.trackBox}>
        <UserSelectPopover
          onSelect={(user) => onUpdateAssignee(item.data.id, user?.id ?? null)}
          trigger={
            <button
              className={cn(cells.trackControl, "gap-0 hover:bg-muted/50")}
              onClick={(e) => e.stopPropagation()}
              type="button"
            >
              <AssigneeContent assignee={assignee} />
            </button>
          }
          users={teamMembers}
          value={
            assignee
              ? {
                  id: assignee.id,
                  name: getUserDisplayName(assignee),
                  avatarUrl: assignee.avatarUrl || undefined,
                }
              : null
          }
        />
      </div>
    </CellTooltip>
  );
}

/**
 * ISS-9307: the grid's priority cell, now the champion's `compact-cell` (My
 * Issues, where the redundant default "Medium" text is dropped so a page of
 * default rows reads as quiet glyphs) or `label` (everywhere else) variant. The
 * glyph, the label lookup and the empty mark used to be assembled here; they are
 * `ArtifactPriority`'s, so this cell and the artifact rows on detail pages
 * cannot drift again.
 */
export function PriorityCell({ item }: { item: DocumentRowItem }) {
  const { onUpdatePriority, surfaceVariant } = useContext(RowEditContext);
  const cells = useDocumentCellClasses();
  const support = documentRowPrioritySupport(item.kind);
  // Whether the row CARRIES a priority is the surface's own declaration; whether
  // THIS grid may edit it is the row registry's `editable` flag. They used to
  // coincide and now do not: ISS-10332 made branch and session rows carry a
  // priority, but `onUpdatePriority` here is the documents PUT, which cannot
  // write one, so those rows render the mark read-only — the value is real,
  // the editor lives on the Sessions and Branches grids.
  if (!support.supported) {
    return (
      <div className={cn(cells.box, "text-muted-foreground text-xs")}>—</div>
    );
  }
  const readOnly = getRowTypeConfig(item)?.editable === false;
  const priority = item.data.priority ?? null;
  // Compact (label-omitting) presentation is a My Issues affordance only; the
  // general artifacts/Projects table always shows the priority label.
  const variant =
    surfaceVariant === "my-tasks"
      ? ArtifactPriorityVariant.CompactCell
      : ArtifactPriorityVariant.Label;

  return (
    <ArtifactPriorityEditor
      className={cn(cells.box, "gap-0")}
      onSelect={
        onUpdatePriority && ((value) => onUpdatePriority(item.data.id, value))
      }
      priority={priority}
      readOnly={readOnly}
      // Whether this row may be CLEARED, on the same declaration that decided
      // whether it renders at all.
      support={support}
      variant={variant}
    />
  );
}

function ignoreRefusedDueDate() {
  // Feedback for the refusal is the host mutation's toast.
}

"use client";

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { INLINE_EDIT_SAVE_ERROR_MESSAGE } from "@repo/app/shared/lib/inline-edit-save-error";
import { InlineNameCell } from "@repo/design-system/components/ui/inline-name-cell";
import {
  useSessionRenameOwnerGate,
  useSessionRenamePreconditions,
} from "../../hooks/use-session-rename-affordance";
import { sessionRowOwnerSubject } from "../../lib/session-owner";
import { SessionsListLeadCell } from "./sessions-list-surface-rows";

/**
 * ISS-8718 — the Sessions list lead cell, plus the owner's inline rename.
 *
 * The rename is `InlineNameCell`, the design system's grid-table name
 * editor, which composes the `InlineScalarCell` champion, so the commit choreography, the refusal rule, the focus contract
 * and the grid-entry marker are the primitive's rather than this surface's
 * (operator ruling 2026-10-02: de-duplicate, reuse the existing components).
 * This module is the ADAPTER: it decides who is offered the control and what
 * the commit writes, and owns no editing behavior of its own.
 *
 * Mounted at the renderer seam (`createSessionsListSurfaceRenderers`
 * → `renderGridLead`) rather than inside `SessionsListLeadCell` itself, for the
 * reason `SessionPriorityCell` is mounted that way: it WRITES through the active
 * data source, so the presentational rows module cannot own it.
 *
 * The gate is `use-session-rename-affordance`, shared with Session detail so
 * the two surfaces cannot disagree about whether this session is renameable.
 * Whatever it decides, the LINK still renders: this cell is the row's only
 * route into the session, so a gate that took the name with it would be a worse
 * bug than the one it was gating.
 *
 * A row with no name at all keeps the plain link too. `name` is nullable
 * (`AgentSessionListItem.name`), the row's own cell already renders what a
 * missing one looks like, and an editor seeded with `""` would claim the
 * session currently renders an empty name — which is a different thing from a
 * session the collector never named.
 */
export function SessionNameLeadCell({
  getSessionHref,
  row,
  showStatusIcon = false,
}: Readonly<{
  getSessionHref?: (row: SessionTableRow) => string | null;
  row: SessionTableRow;
  showStatusIcon?: boolean;
}>) {
  const ready = useSessionRenamePreconditions(row.id);
  const plainLead = (
    <SessionsListLeadCell
      getSessionHref={getSessionHref}
      row={row}
      showStatusIcon={showStatusIcon}
    />
  );
  const name = row.name;
  if (!(ready && name)) {
    return plainLead;
  }
  return (
    <EditableSessionNameLead
      getSessionHref={getSessionHref}
      name={name}
      row={row}
      showStatusIcon={showStatusIcon}
    />
  );
}

/**
 * Stage two of the gate, in its own component because the ownership read needs
 * an auth adapter and an API client — see `use-session-rename-affordance`.
 */
function EditableSessionNameLead({
  getSessionHref,
  name,
  row,
  showStatusIcon,
}: Readonly<{
  getSessionHref?: (row: SessionTableRow) => string | null;
  name: string;
  row: SessionTableRow;
  showStatusIcon: boolean;
}>) {
  const { canRename, rename } = useSessionRenameOwnerGate(
    sessionRowOwnerSubject(row),
    ArtifactStatusEditSurface.InlineCell
  );
  if (!canRename) {
    return (
      <SessionsListLeadCell
        getSessionHref={getSessionHref}
        row={row}
        showStatusIcon={showStatusIcon}
      />
    );
  }
  // Mirrors `EditableArtifactLead`'s shipped accessible name in the
  // generic-artifact surface, with this surface's own noun. PENDING a
  // human's wording — see the ISS-8718 PR body.
  const label = `Edit session name for ${name}`;
  const onCommit = (
    next: string,
    expectedName: string,
    recoverableErrorOwner?: () => boolean
  ) =>
    rename.mutateAsync({
      sessionId: row.id,
      name: next,
      expectedName,
      ...(recoverableErrorOwner ? { recoverableErrorOwner } : {}),
    });
  // The lead is built from the name the CELL is showing, not from `row.name`:
  // a host fed its rows as props has nothing for the optimistic cache patch to
  // flow through, so a committed rename would never appear.
  const renderValue = (shown: string) => (
    <SessionsListLeadCell
      getSessionHref={getSessionHref}
      row={{ ...row, name: shown }}
      showStatusIcon={showStatusIcon}
    />
  );
  return (
    <InlineNameCell
      label={label}
      onCommit={onCommit}
      renderValue={renderValue}
      retainRejectedDraft
      saveErrorMessage={INLINE_EDIT_SAVE_ERROR_MESSAGE}
      value={name}
    />
  );
}

"use client";

import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { INLINE_EDIT_SAVE_ERROR_MESSAGE } from "@repo/app/shared/lib/inline-edit-save-error";
import { InlineNameCell } from "@repo/design-system/components/ui/inline-name-cell";
import type { ReactNode } from "react";
import {
  useSessionRenameOwnerGate,
  useSessionRenamePreconditions,
} from "../../hooks/use-session-rename-affordance";

/**
 * ISS-8718 — Session detail's `<h1>`, plus the owner's inline rename.
 *
 * The heading and list both use `InlineNameCell`, so a blank or trim-unchanged
 * draft is cancelled before the mutation runs and cannot be mislabeled as a
 * save failure. The heading still owns the same no-grid focus contract as any
 * other host of the shared primitive.
 *
 * The gate is `use-session-rename-affordance`, the SAME one the list reads, so
 * a session cannot be renameable in the list and not on its own detail page.
 * The two-step mount is that module's contract, not this component's invention.
 *
 * The heading itself is unchanged for every viewer the gate turns down.
 */
export function SessionNameHeading({
  session,
  title,
}: Readonly<{
  session: AgentSessionDetail;
  /** The rendered title — `name ?? externalSessionId`, resolved by the caller. */
  title: string;
}>) {
  const ready = useSessionRenamePreconditions(session.id);
  const heading = <SessionTitleText>{title}</SessionTitleText>;
  // A session with no collected name renders its external id here. That is an
  // IDENTIFIER standing in for a name, not a name, so seeding an editor with it
  // would offer the owner a rename pre-filled with something they never chose.
  if (!(ready && session.name)) {
    return heading;
  }
  return <EditableSessionNameHeading name={session.name} session={session} />;
}

function EditableSessionNameHeading({
  name,
  session,
}: Readonly<{ name: string; session: AgentSessionDetail }>) {
  const { canRename, rename } = useSessionRenameOwnerGate(
    session,
    ArtifactStatusEditSurface.Detail
  );
  if (!canRename) {
    return <SessionTitleText>{name}</SessionTitleText>;
  }
  return (
    <SessionTitleText>
      <InlineNameCell
        className={TITLE_TYPE}
        label={`Edit session name for ${name}`}
        onCommit={(next, expectedName, recoverableErrorOwner) =>
          rename.mutateAsync({
            sessionId: session.id,
            name: next,
            expectedName,
            ...(recoverableErrorOwner ? { recoverableErrorOwner } : {}),
          })
        }
        retainRejectedDraft
        saveErrorMessage={INLINE_EDIT_SAVE_ERROR_MESSAGE}
        value={name}
      />
    </SessionTitleText>
  );
}

/**
 * The title's type scale, named once because two places need it: the `<h1>`
 * below, and the field inside it, whose own `text-sm` it has to beat.
 *
 * Byte-identical to what the header shipped before ISS-8718 — no `truncate`, so
 * a long session name still wraps for every viewer (tamsinb review, PR #8315).
 */
const TITLE_TYPE = "font-semibold text-2xl tracking-tight";

/**
 * The page's ONE `<h1>`, and the single owner of that element: both branches
 * render through here, so there is one heading rather than two spellings of one.
 *
 * Its child is the name as TEXT in both branches — plain for a viewer who
 * cannot rename, and `InlineNameCell`'s resting render for one who can, which
 * only becomes a field once the owner activates it. That is what gives the
 * heading a real accessible name: a heading is named from its text content, and
 * an always-live `<input>` contributes none.
 *
 * Measured, because the alternative looked green and was not: wrapping the
 * always-live `InlineScalarCell` in this `<h1>` DOES satisfy
 * `getByRole("heading", { name })`, but only because `dom-accessibility-api`
 * applies accname step 2E on any recursion into a control, where the spec scopes
 * 2E to a control embedded in a widget's LABEL or value. The `<h1>` had
 * `textContent === ""`. Shipping an accessibility guarantee on that gap is not
 * something a passing test justifies.
 */
function SessionTitleText({ children }: Readonly<{ children: ReactNode }>) {
  return <h1 className={TITLE_TYPE}>{children}</h1>;
}

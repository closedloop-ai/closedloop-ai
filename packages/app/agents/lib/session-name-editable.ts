import { resolveSessionOwner, type SessionOwnerSubject } from "./session-owner";

/**
 * ISS-8718 — whether this viewer is offered the inline rename affordance for
 * this session.
 *
 * OWNERSHIP, and deliberately nothing else. The owner is the session's
 * assignee (ISS-12251 D-6, PLN-2176 T-4.5), the person
 * `sessionRenameService` (`apps/api/app/agent-sessions/session-rename-service.ts`)
 * admits alongside an org admin, so this predicate is NARROWER than the API: an admin renaming
 * someone else's session is accepted over the wire but is not offered the
 * inline control. That is the safe direction of the AC's rule — "a non-owner is
 * not offered the affordance ... the UI must not present a control the API will
 * refuse" (ISS-8718) — and it is a gap rather than a choice: the org role lives
 * on the Clerk membership, which the desktop renderer has no read for, and
 * `GET /me` carries `ApproverRole` (PM, Designer, …), not the org role the
 * admin gate reads. Offering it to admins needs an org-role signal on this
 * port, on BOTH surfaces, which is its own ticket.
 *
 * A session with no assignee (`assignee: null`: never assigned, or its
 * assignee was deleted — `assignee_id` is SetNull) is editable by nobody here.
 * That is exactly the stranding ISS-8733 admitted admins to fix, and it is
 * reachable only through the API until the signal above exists.
 *
 * VERSION SKEW (AC-012): a producer that predates the `assignee` field omits
 * it, and that API still authorized rename on the recording user
 * (`session_detail.user_id`), so an ABSENT `assignee` falls back to `user` —
 * the rule the answering server applies. A present `null` does not fall back:
 * the server it came from refuses everyone but an admin.
 *
 * `viewerUserId` is `undefined` while `GET /me` is still in flight or
 * unavailable. Absent is NOT a match: a cell must not offer an editor on the
 * strength of a viewer it cannot name, and the affordance appearing a beat late
 * is the honest shape of not knowing yet.
 *
 * The owner's `id` is itself optional on the row shape — a narrow projection or
 * a test double may carry only a display name (`SessionTableRow.owner`) — and an
 * absent one is NOT a match either, for the same reason: two people can share a
 * name (#4480), so a name is not an identity and must never authorize an
 * editor. The production mapper (`session-table-row.ts`) does carry the id.
 */
export function sessionNameIsEditableBy(
  session: SessionRenameSubject,
  viewerUserId: string | undefined
): boolean {
  const owner = resolveSessionOwner(session);
  if (viewerUserId === undefined || owner?.id === undefined) {
    return false;
  }
  return owner.id === viewerUserId;
}

/** The two people the rename gate reads, by their wire names. */
export type SessionRenameSubject = SessionOwnerSubject<{ id?: string }>;

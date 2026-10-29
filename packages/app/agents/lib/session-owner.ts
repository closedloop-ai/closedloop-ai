import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";

/** The two people a session's Owner can come from, by their wire names. */
export type SessionOwnerSubject<Person> = {
  /** The Owner. Absent only from a producer that predates the field. */
  assignee?: Person | null;
  /** The recording user; the Owner on a producer that omits `assignee`. */
  user?: Person | null;
};

/**
 * A session's Owner: its artifact assignee (ISS-12251 D-1; operator ruling
 * 2026-10-13, "The owner is the assignee").
 *
 * A producer that omits `assignee` renders as before (PLN-2176 AC-012), so an
 * ABSENT assignee falls back to `user`: on an API that predates the field
 * `user` was the Owner. Desktop's local read serves its local creator as
 * `assignee` (D-7). A present `null` is an unassigned session and does not
 * fall back.
 */
export function resolveSessionOwner<Person>(
  subject: SessionOwnerSubject<Person>
): Person | null {
  return subject.assignee === undefined
    ? (subject.user ?? null)
    : subject.assignee;
}

/** A grid row's Owner subject; the row carries the assignee as `owner`. */
export function sessionRowOwnerSubject(
  row: SessionTableRow
): SessionOwnerSubject<NonNullable<SessionTableRow["owner"]>> {
  return { assignee: row.owner, user: row.user };
}

/** {@link resolveSessionOwner} over a grid row. */
export function sessionRowOwner(
  row: SessionTableRow
): NonNullable<SessionTableRow["owner"]> | null {
  return resolveSessionOwner(sessionRowOwnerSubject(row));
}

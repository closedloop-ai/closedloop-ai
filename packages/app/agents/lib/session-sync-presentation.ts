/**
 * ISS-5279: how a Sessions row's transport state is PRESENTED on its Status
 * pill — the dependency-free constants leaf.
 *
 * Never a Status value. The Status vocabulary (`Active` / `Completed` /
 * `Failed` / `Inactive` / `Running`) is a session's lifecycle and stays closed;
 * sync is an orthogonal fact about the record's transport. A row can be Active
 * and still uploading, so sync modulates how the lifecycle pill is DRAWN rather
 * than competing for its one slot; making it a Status value would force two
 * independent facts to be mutually exclusive. (Today the fold is scoped to
 * displayed-Active rows for a separate reason — see
 * `resolveSessionSyncPresentation` — so Active is the only lifecycle word this
 * member is currently drawn over.)
 *
 *  - `Syncing` — an upload is genuinely in flight. The pill pulses a ring.
 *
 * ONE member, deliberately, and the reason is the whole ticket. An earlier
 * revision added a second `Unresolved` member so the pill could also mark a
 * transcript that stopped WITHOUT finishing (`stale` / `failedPermanent`). PR
 * review took it back out, and the argument that removed it is the same one that
 * removed the second pill: that verdict already has a home. The fold only ever
 * suppresses the Name cell's inline disposition badge for a row that is actually
 * uploading (see `isSessionSyncStateFolded`), so a `stale`, `failedTransient`,
 * or `failedPermanent` row KEEPS that badge and states its verdict there.
 * Marking it a second time on the Status pill was the duplication ISS-5279
 * exists to delete, arriving from the other side — and, as review measured, a
 * 6px warning dot inside a pale success pill was not perceivable at 1x anyway,
 * so the claim only held in the accessibility tree.
 *
 * What the pill therefore promises is narrow and true: it says "still uploading"
 * while an upload is in flight, and says nothing about transport otherwise. It
 * does not claim a stopped pulse means the upload finished — it claims only that
 * the pulse is absent, which is what the Name cell is there to qualify.
 *
 * This module is deliberately a leaf with NO imports. `SessionStatusBadge` also
 * renders `AgentStatusBadge`/`HarnessBadge` for the agent card, the event-group
 * row, and the session card; putting this const in the derivation module
 * (`session-status-fold.ts`) would have pulled the whole row-mapper graph into
 * each of those bundles for one string union. Same reasoning as the Zod-free
 * `transcript-disposition-constants` split (#3449).
 */
export const SessionSyncPresentation = {
  Syncing: "syncing",
} as const;
export type SessionSyncPresentation =
  (typeof SessionSyncPresentation)[keyof typeof SessionSyncPresentation];

/**
 * ISS-5279: the test hook on the ONE Status pill that carries a sync
 * presentation.
 *
 * Named `-sync`, not `session-status-badge`, deliberately (PR review): the
 * ordinary Status pill carries NO test id, so a bare `session-status-badge`
 * would invite someone to add it there — and the ten `queryByTestId(...)
 * .not.toBeInTheDocument()` assertions that mean "this row has no sync
 * presentation" would silently invert into "this row has no Status pill", which
 * is true of nothing. The suffix makes the id describe what it actually marks.
 *
 * Exported from this leaf rather than retyped per suite so the component and its
 * five test files cannot drift. The two Playwright specs still pin the literal —
 * their Node loader cannot resolve workspace subpaths, the same constraint that
 * makes them pin the session-status literals (see `e2e/sessions-status-pill-
 * sync-fold.spec.ts`).
 */
export const SESSION_STATUS_SYNC_BADGE_TEST_ID =
  "session-status-badge-sync" as const;

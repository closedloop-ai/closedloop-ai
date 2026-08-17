import {
  DISPLAYED_SESSION_STATUS,
  type DisplayedSessionStatus,
  isDisplayOnlySessionStatus,
  normalizeSessionStatus,
  resolveDisplayedSessionStatus,
  SESSION_STATUS,
  TERMINAL_SESSION_STATUSES,
} from "@repo/api/src/types/session-status";

/**
 * FEA-4301: the SINGLE derivation of the status a Sessions row DISPLAYS, shared by
 * the Status-column sort (`compareByDisplayedStatus`) and mirrored by the Status
 * FACET predicate (`buildStatusFacetPredicate` in `query-builder.ts`), so a row
 * sorts under the same status vocabulary it renders and filters by.
 *
 * The Sessions row renders the raw persisted `SESSION_STATUS` value, EXCEPT it is
 * DISPLAYED as Waiting when it is awaiting user input — a projection that has no
 * persisted `status = 'waiting'` value behind it (cloud never persists Waiting;
 * the row stores `active`). A displayed-Waiting row that sorted by its raw stored
 * `active` status landed among the Active rows instead of by the value the user
 * sees (the FEA-4301 bug). This projection collapses that difference: sort keys
 * off the projected status, not the raw column.
 *
 * The Waiting condition is byte-for-byte the same three-part test the WAITING
 * facet predicate encodes (`buildStatusFacetPredicate`):
 *   • `awaitingInputSince` is set,
 *   • the session has not ended (`sessionEndedAt` is null) — mirrors the
 *     `toAgentSessionState` guard that only reports PendingApproval while
 *     `!sessionEndedAt`, and
 *   • the raw status is non-terminal ({@link TERMINAL_SESSION_STATUSES}).
 *
 * ISS-4559: that byte-for-byte claim held for WAITING only. The ACTIVE facet
 * additionally required `awaitingInputSince: null`, an exclusion this projection
 * has no counterpart for — so a row with `awaitingInputSince` set, `sessionEndedAt`
 * set, and a raw `active` status displayed as Active (the Waiting projection
 * needs `!sessionEndedAt`, so it fell through to the raw status) while the ACTIVE
 * facet excluded it for being awaiting-input and the WAITING facet excluded it
 * for having ended: a row visible in the unfiltered list and returned by NEITHER
 * facet. The ACTIVE predicate now negates exactly this projection's Waiting
 * condition (`DISPLAYS_AS_WAITING` in `query-builder.ts`), so a row is excluded
 * from Active EXACTLY when it projects to Waiting and the two derivations are one
 * statement rather than two that can drift again.
 *
 * ISS-5366: past the Waiting projection this now DELEGATES to the shared
 * {@link resolveDisplayedSessionStatus}, closing the server-side gap ISS-4998
 * left open. Retiring `sessions-honest-unknown-states` made the client mapper
 * fold an unrecognized status to `unknown` and a long-silent `active` run to
 * `stale` for every user, unconditionally — while this projection still returned
 * the raw column. That split one row across three claims: the badge said
 * "Stale", the Status facet had no Stale option and bucketed the row under
 * Active, and the Status sort ranked it by a value nothing displayed.
 *
 * Delegating (rather than restating the cutoff here) is the point: there is now
 * ONE derivation of the displayed status, so the badge cannot drift from the
 * facet again. The Waiting branch stays ahead of it because `awaitingInputSince`
 * is a server-only column the shared rule cannot see — and the shared rule
 * deliberately exempts `waiting` from the staleness fold, so a row blocked on a
 * human for three days keeps saying so.
 *
 * `now` is injected so the caller pins ONE instant across a page. A projection
 * reading its own clock would let two rows in the same response be judged
 * against different cutoffs.
 */
export function projectDisplayedSessionStatus(
  record: {
    status: string;
    awaitingInputSince: Date | null;
    sessionEndedAt: Date | null;
    lastActivityAt?: Date | null;
    sessionStartedAt?: Date | null;
  },
  now: Date = new Date()
): string {
  if (
    record.awaitingInputSince &&
    !record.sessionEndedAt &&
    // ISS-4654: fold first, so a row this build knows is terminal is never
    // projected as Waiting just because it carries awaitingInputSince.
    //
    // The gap this leaves is deliberate (wongk, #5075): an unrecognised
    // spelling reaches Waiting, and closing that means recognising the
    // spellings ISS-5592 removed — the compatibility path, back again. Held
    // shut by evidence instead: 0 rows carry either, verified 2026-08-14.
    !TERMINAL_SESSION_STATUSES.has(normalizeSessionStatus(record.status))
  ) {
    return DISPLAYED_SESSION_STATUS.WAITING;
  }
  const displayed = resolveDisplayedSessionStatus({
    status: record.status,
    // The SAME `lastActivityAt ?? startedAt` anchor the reaper and the client
    // mapper use (wongk, #4324): a row with no activity timestamp has no
    // evidence of recent life, so falling back to the start time keeps the
    // least-evidenced rows from being the ones exempted from the fold.
    lastActivityAt: record.lastActivityAt,
    startedAt: record.sessionStartedAt,
    now,
  });
  // ONLY the two honesty folds are adopted; every other value is returned as
  // stored. Adopting more would change what this read RETURNS, and the
  // filter-input contract forbids assuming a returned status is one of the
  // advertised values.
  //
  // ISS-5592 emptied the rest of that reasoning: it retired the
  // `completed`/`abandoned` spellings and then the last aliases, so there is no
  // longer any collapse for this branch to decline. An unrecognized spelling
  // answers `unknown` here like any other unparseable one.
  if (
    displayed === DISPLAYED_SESSION_STATUS.STALE ||
    displayed === DISPLAYED_SESSION_STATUS.UNKNOWN
  ) {
    return displayed;
  }
  return record.status;
}

/**
 * FEA-4301 / ISS-4586: the canonical rank of each displayed status, ordered by
 * lifecycle so an ascending Status sort reads Active → Waiting → Inactive →
 * Error. A monotonic integer per status makes the in-memory comparator group
 * rows contiguously by DISPLAYED status.
 *
 * ISS-4586 gave the legacy terminals `completed` and `abandoned` their own
 * entries at rank 2, alongside `inactive`. ISS-4654 retired them from
 * {@link SESSION_STATUS}, and ISS-5592 removed the last of their tolerance — so
 * they no longer key this map and no longer get a rank of their own. A row
 * carrying one degrades to {@link UNKNOWN_STATUS_RANK} like any other
 * unrecognized value, which matches the Unknown badge it now renders. `waiting`
 * stays its own rank (a distinct displayed sub-state derived from
 * `awaitingInputSince`, not a stored status).
 */
const DISPLAYED_STATUS_RANK: Record<DisplayedSessionStatus, number> = {
  [SESSION_STATUS.ACTIVE]: 0,
  [DISPLAYED_SESSION_STATUS.WAITING]: 1,
  [SESSION_STATUS.INACTIVE]: 2,
  [SESSION_STATUS.ERROR]: 3,
  // ISS-4997 / ISS-4998: neither `unknown` nor `stale` is a lifecycle stage, so
  // neither has a natural place in the Active → Waiting → Inactive → Error
  // progression. Both rank last, where an unrecognized status already sorted
  // before it had a name, so a row the display cannot classify does not get
  // filed among rows it can. `stale` sorts ahead of `unknown` because it is at
  // least a statement about the session; they stay adjacent and out of the way.
  //
  // ISS-5366: the server now PROJECTS both values — `projectDisplayedSessionStatus`
  // delegates to the shared `resolveDisplayedSessionStatus`, which applies the
  // staleness cutoff and the unrecognized-status fold — so these ranks are
  // reachable rather than defensive, and a Stale row sorts where its badge says
  // it should. This closes the ISS-4998 server-side gap this note used to track.
  [DISPLAYED_SESSION_STATUS.STALE]: 4,
  [DISPLAYED_SESSION_STATUS.UNKNOWN]: 5,
};

const UNKNOWN_STATUS_RANK = Object.keys(DISPLAYED_STATUS_RANK).length;

/**
 * The rank of a displayed status. An unknown status value (a future/legacy status
 * not yet in the vocabulary) sorts AFTER every known value in ascending order,
 * so it degrades to the end rather than colliding with rank 0; ties then fall to
 * the unique `artifactId` tiebreaker in the comparator.
 */
export function displayedStatusRank(displayedStatus: string): number {
  return (
    (DISPLAYED_STATUS_RANK as Record<string, number | undefined>)[
      displayedStatus
    ] ?? UNKNOWN_STATUS_RANK
  );
}

/**
 * Whether a displayed status is a known {@link SESSION_STATUS} value (has a
 * lifecycle rank) rather than a future/legacy value the vocabulary does not yet
 * cover. The status comparator uses this to keep unknown statuses last in BOTH
 * sort directions instead of letting a direction-flipped rank delta promote them
 * to the front of a descending page.
 */
export function isKnownDisplayedStatus(displayedStatus: string): boolean {
  // ISS-5366: the DISPLAY-ONLY members are reported as not-known here, which is
  // what keeps their placement direction-INDEPENDENT (FEA-4330).
  //
  // This matters because the projection now PRODUCES them. Before the fold, an
  // unrecognized status reached this comparator as its raw string, missed the
  // rank table, and was pinned last in both directions. Folding it to `unknown`
  // gave it a rank — and a ranked member gets flipped by `dir`, which put
  // "Unknown" at the FRONT of a descending page: precisely the regression the
  // FEA-4330 rule exists to prevent, reintroduced by naming the value.
  //
  // `stale` joins it for the reason the rank table already states: neither is a
  // lifecycle stage, so both belong out of the way rather than leading a page in
  // either direction. Their RANKS still order them relative to each other
  // (stale ahead of unknown) once both are in the trailing group.
  if (isDisplayOnlySessionStatus(displayedStatus)) {
    return false;
  }
  return displayedStatus in DISPLAYED_STATUS_RANK;
}

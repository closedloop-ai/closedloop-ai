import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";

/**
 * What a bulk favorite change ACTUALLY did, row by row (whitlockk review cid
 * 3880964961).
 *
 * A batch of per-row mutations has three outcomes, not two: all landed, none
 * landed, or some landed. A seam that can only resolve or reject collapses the
 * third into the second — the reader is told nothing changed while the server
 * holds the rows that did, and the selection is kept as if it were all still
 * pending. This type is how a host reports the third one.
 */
export type SessionsBulkFavoriteOutcome = {
  succeededIds: readonly string[];
  failedIds: readonly string[];
};

/**
 * What a bulk favorite seam may hand back: an outcome, or nothing at all.
 *
 * The absent case is `void` rather than `undefined` deliberately — a host
 * writing `(rows) => setFavoriteIds(…)` returns `void`, and narrowing this to
 * `undefined` would reject every such caller for no gain. The union IS the
 * contract: an outcome is an upgrade over silence, not a replacement for it.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: see above — "reported nothing" is a real member of this contract.
export type SessionsBulkFavoriteReport = SessionsBulkFavoriteOutcome | void;

export type SessionsFavoriteController = {
  favoriteIds: ReadonlySet<string>;
  /**
   * The favourite list is NOT KNOWN — the read failed, or has not answered yet.
   *
   * Distinct from omitting the controller, and the distinction is the whole
   * point (Pascoe review). No controller means this host has no favourites
   * concept at all, so the track should not exist; this means the host HAS one
   * and cannot read it right now, so the track is reserved and left EMPTY. An
   * unfilled star is a claim that the session is not favourited, and a click on
   * it submits the add path against that claim — but dropping the 36px track
   * instead shifts every column, and `isError` is not terminal (a refetch can
   * clear it), so the table would move under the reader mid-session.
   */
  isUnavailable?: boolean;
  /**
   * Session ids are artifact ids in the cloud list projection, so a production
   * host wires this to the batched artifact-favorites query and generic artifact
   * favorite mutation. Desktop must omit the controller for local-only rows
   * whose ids are not cloud artifact ids.
   */
  onChange: (row: SessionTableRow, favorited: boolean) => void;
  /** Session ids with a toggle in flight; their star refuses a second click. */
  pendingIds?: ReadonlySet<string>;
  /**
   * Optional batch seam for hosts that can coalesce selected-row mutations.
   *
   * Returning a {@link SessionsBulkFavoriteOutcome} is how a host reports a
   * PARTIAL result; returning nothing keeps the old all-or-nothing contract, so
   * an existing host is unchanged. Rejecting still means "nothing is known to
   * have landed" — a host that can tell the difference should resolve with an
   * outcome rather than reject.
   */
  onBulkChange?: (
    rows: readonly SessionTableRow[],
    favorited: boolean
  ) => Promise<SessionsBulkFavoriteReport> | SessionsBulkFavoriteReport;
};

export type SessionsGroupDropController = {
  canMove: (fieldId: string) => boolean;
  /**
   * Drop `row` into the destination band on `fieldId`.
   *
   * `value` IS THE DISPLAY LABEL OF THE DESTINATION BAND, not an identifier
   * (tamsinb review). Grouping partitions rows by what the cell RENDERS, so the
   * `error` lifecycle state arrives here as `"Failed"`, an owner arrives as
   * `"Jane Doe"` rather than a user id, and a row with no value for the field
   * arrives as `"—"`.
   *
   * `canonicalValue` is what ISS-8296 added, and is what a host should actually
   * WRITE — the lifecycle `SessionStatus` behind "Failed", the user id behind
   * "Jane Doe", the option id behind an enum label. Two rules govern reading it:
   *
   * - **Test `!== undefined`, never truthiness.** It is PRESENT AND EMPTY for a
   *   band that means "explicitly unassigned"; `if (canonicalValue)` reads that
   *   intentional clear as an unmappable band and drops a legal write.
   * - **Absent means the band had no single canonical value** — nothing could be
   *   derived, or its rows disagreed (two people share a display name). A host
   *   should not fall back to `value` in that case: a label is not an identity,
   *   which is the whole reason this parameter exists.
   *
   * In practice a host rarely sees it absent, because such a band refuses the
   * drop before this is reached. It is optional so a three-parameter host that
   * predates ISS-8296 still assigns.
   */
  onMove: (
    row: SessionTableRow,
    fieldId: string,
    value: string,
    canonicalValue?: string
  ) => Promise<void> | void;
};

export type SessionsInlineCreateContext = {
  groupKey?: string;
};

export type SessionsInlineCreateController = {
  label?: string;
  placeholder?: string;
  onCreate: (
    name: string,
    context: SessionsInlineCreateContext
  ) => Promise<void> | void;
};

/**
 * Settled per-row mutation results as a {@link SessionsBulkFavoriteOutcome}.
 *
 * Positional: `results[i]` is `rows[i]`'s, which is what `Promise.allSettled`
 * guarantees and what lets a host name the rows that failed rather than only
 * count them. Lives beside the type so every host builds the outcome the same
 * way instead of each inventing its own partition.
 */
export function toSessionsBulkFavoriteOutcome(
  rows: readonly { id: string }[],
  results: readonly PromiseSettledResult<unknown>[]
): SessionsBulkFavoriteOutcome {
  const succeededIds: string[] = [];
  const failedIds: string[] = [];
  for (const [index, row] of rows.entries()) {
    if (results[index]?.status === "fulfilled") {
      succeededIds.push(row.id);
    } else {
      failedIds.push(row.id);
    }
  }
  return { failedIds, succeededIds };
}

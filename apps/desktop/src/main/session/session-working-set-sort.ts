import {
  resolveSessionDurationLifecycle,
  SessionDurationLifecycle,
} from "@repo/api/src/types/session-status";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import { isDisplayedStatusParityEnabled } from "./displayed-status-parity-gate.js";
import {
  getOrgDirectorySnapshot,
  resolveOwner,
} from "./org-directory-cache.js";
import { parseSessionDate } from "./session-instant.js";
import { sessionRepositoryName } from "./session-repository-facet.js";
import { sumTokenUsage } from "./session-usage-totals.js";
import {
  displayedSharedStatusRank,
  isKnownSharedStatus,
  projectDisplayedSharedStatus,
  resolveDisplayedSharedSessionStatus,
} from "./shared-agent-session-status.js";
import type { SanitizedQuery } from "./shared-agent-sessions-query.js";
import { displayUserName } from "./user-display-name.js";

// FEA-4426: the precomputed, comparable sort key for one session. A string for
// the string columns (harness/model), a number for the numeric columns
// (cost/timestamps), a nulls-last wrapper for the columns whose value can be
// genuinely ABSENT — `user` (an unresolved owner), `repo` (no resolved Git
// remote, "Unknown") and, since ISS-5131, `duration` (a terminal session with no
// end instant, which the cell renders blank) — whose `null` needs
// `compareNullsLast`'s nulls-last (both directions) placement rather than plain
// comparison, or a status wrapper for the `status` column (FEA-4301: sorted by
// DISPLAYED-status lifecycle rank with unknown statuses last in both directions,
// not by raw string).
type SessionSortKey =
  | string
  | number
  | { nullsLast: string | number | null }
  | { statusRank: number; known: boolean };

/**
 * Sort the filtered working set by a column id (matching the table headers).
 * Returns a new array; an unset `sortBy` preserves the incoming cursor order.
 *
 * Exported for the FEA-4426 decorate-sort-undecorate order-parity tests.
 */
export function sortSyncedSessions(
  sessions: SyncedAgentSession[],
  query: SanitizedQuery
): SyncedAgentSession[] {
  if (!query.sortBy) {
    return sessions;
  }
  const dir = query.sortDir === "asc" ? "asc" : "desc";
  const factor = dir === "asc" ? 1 : -1;
  const sortKey = query.sortBy;
  // FEA-4426: decorate-sort-undecorate. `compareSessions` derived each row's
  // sort key from scratch on BOTH operands of EVERY comparison — over up to
  // MAX_WORKING_SET_SESSIONS (5000) rows the O(N log N) comparator re-ran
  // `sumTokenUsage` (a `.reduce` over `tokenUsageByModel`) or `parseSessionDate`
  // (new Date + getTime, twice) ~2·N·log N times. Derive each session's key
  // ONCE up front, sort on the precomputed keys, then undecorate. Node's
  // `Array.prototype.sort` is stable, so preserving the original index for
  // equal keys reproduces the previous comparator's tie order exactly (the
  // recency tiebreak the `user` column relies on).
  //
  // FEA-4300/FEA-4330/FEA-4299 (merged): the Owner and Repository sorts own
  // their own direction so they keep null rows (owner-less, or "Unknown" with no
  // resolved remote) LAST in BOTH directions — a nulls-last key is compared by
  // `compareNullsLast(a, b, dir)` (which applies `dir` internally and never flips
  // nulls), NOT multiplied by the outer `factor`. Every other key uses the
  // ascending `compareSortKeys` flipped by `factor`, identical to before.
  const decorated = sessions.map((session, index) => ({
    session,
    index,
    key: sessionSortKey(session, sortKey),
  }));
  decorated.sort((a, b) => {
    const byKey = compareDecoratedKeys(a.key, b.key, dir, factor);
    return byKey === 0 ? a.index - b.index : byKey;
  });
  return decorated.map((entry) => entry.session);
}

/**
 * FEA-4330: compare two nullable string sort keys with NULL always sorting LAST,
 * independent of `dir` — the shared shape of the cloud's `nulls: "last"` ORDER BY
 * for every nullable column. The present-value comparison follows `dir`
 * (ascending `localeCompare`, negated for descending). Used by the Owner and
 * Repository ("Unknown" rows) sorts so their null placement cannot drift.
 */
export function compareNullsLast(
  a: string | number | null,
  b: string | number | null,
  dir: "asc" | "desc"
): number {
  if (a === null && b === null) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  // ISS-5131: one nulls-last wrapper now carries a NUMERIC column (Duration) as
  // well as the string ones, so the present-value comparison dispatches on the
  // value type. A column produces one type for every row, so the mixed case is
  // unreachable and falls back to string ordering rather than throwing.
  const cmp =
    typeof a === "number" && typeof b === "number"
      ? a - b
      : String(a).localeCompare(String(b));
  return dir === "asc" ? cmp : -cmp;
}

/**
 * FEA-4300/FEA-4330: compare two owner display names for the `user` sort. NULL
 * owners (unresolved directory ids) always sort LAST, independent of `dir` —
 * matching the cloud `compareByOwnerDisplayName` nulls-last. A thin alias over
 * `compareNullsLast` kept for the parity test that pins the Owner-column contract.
 */
export function compareOwnerName(
  a: string | null,
  b: string | null,
  dir: "asc" | "desc"
): number {
  return compareNullsLast(a, b, dir);
}

/**
 * FEA-4297 / ISS-5131: the displayed Duration span in ms — the key the `duration`
 * column sorts by.
 *
 * It MIRRORS the one Duration rule the cell renders
 * (`resolveSessionDurationWindow` / `resolveSessionWallClockMs` in
 * `packages/app/agents/lib/session-duration.ts`): `now - start` while the session
 * is running, `end - start` once it is terminal, and NO measurement at all for a
 * terminal session carrying no `endedAt`. The rule is restated here rather than
 * imported because this is desktop MAIN-process code and that module is
 * browser/renderer-only; the shared `@closedloop-ai/loops-api` status constants are the
 * part both copies do read from one place.
 *
 * It no longer leads with the collector's `wallClock`. That value is anchored on
 * the last ACTIVITY timestamp, which on a completed session tracks SYNC time —
 * the 31h-session-reads-170h defect — so ordering by it would order the desktop
 * page against a number the row no longer renders, the exact non-monotonic paint
 * ISS-4675 fixed on the cloud comparator.
 *
 * `null` where the cell renders blank, so an unmeasurable row sorts with the
 * other blanks instead of scattering among the real zeros — the ISS-4979
 * rollout condition on BOTH comparators, now satisfied.
 *
 * `nowMs` defaults to the real clock so the sort call site stays a one-argument
 * call, and is overridable so a test can assert an EXACT running span. wongk
 * (#4409): the previous coverage was a live-clock bounded assertion (`>= 90m`
 * and `< 91m`), which the repo test rules ban — scheduler delay can flake it and
 * a one-minute range is wide enough to hide a real regression.
 */
export function sessionDurationMs(
  session: SyncedAgentSession,
  nowMs: number = Date.now()
): number | null {
  const started = parseSessionDate(session.startedAt).getTime();
  if (Number.isNaN(started)) {
    return null;
  }
  const end = resolveDurationEndMs(session, nowMs);
  if (end === null) {
    return null;
  }
  const span = end - started;
  // A non-positive span is nonsensical (an end before its start, or a single
  // recorded instant), and the cell renders it blank rather than "0s".
  return span > 0 ? span : null;
}

/**
 * ISS-5131: the instant the Duration span is measured TO, or `null` when the
 * session is not known to be running and carries no end instant.
 *
 * ONE classifier ({@link resolveSessionDurationLifecycle}) rather than a local
 * list of status literals (wongk, #4409). This comparator reads the RAW stored
 * `session.status` (`error`), while the row the reader sees is built by
 * `mapListItem` AFTER `canonicalSharedStatus` rewrites that to `failed` — so two
 * hand-rolled copies of "is this terminal", each spelling out its own literals,
 * put one session's cell and its own sort key on opposite sides of the branch:
 * a live, growing duration in the cell, sorted with the blanks. The shared
 * classifier folds both spellings, so the split cannot survive.
 *
 * `Indeterminate` — an unrecognized status, or a display-only `stale`/`unknown`
 * — resolves by EVIDENCE and never reaches the clock: an `endedAt` bounds it,
 * and its absence leaves it unmeasurable rather than claiming the run continues.
 *
 * ISS-6270: it classifies the DISPLAYED status
 * ({@link resolveDisplayedSharedSessionStatus}), not `session.status`. A run
 * silent past the staleness cutoff DISPLAYS as `stale` — an `Indeterminate`
 * lifecycle — so it takes the evidence-bounded branch, which is what the
 * Duration cell already renders for it. Reading the raw `active` beside a blank
 * cell is the ISS-5575 divergence one field over: the key kept growing against
 * the clock and made the row the longest span in the table while it displayed no
 * duration at all. A stale row that DID record an end still measures that end,
 * because this branch reads the evidence rather than blanking the population.
 */
function resolveDurationEndMs(
  session: SyncedAgentSession,
  nowMs: number
): number | null {
  if (
    resolveSessionDurationLifecycle(
      resolveDisplayedSharedSessionStatus(session, new Date(nowMs))
    ) === SessionDurationLifecycle.Running
  ) {
    return nowMs;
  }
  const endedAt = session.endedAt
    ? parseSessionDate(session.endedAt).getTime()
    : null;
  return endedAt !== null && !Number.isNaN(endedAt) ? endedAt : null;
}

/**
 * FEA-4426 + FEA-4300/FEA-4330/FEA-4299: compare two precomputed keys for the
 * sort. A nulls-last key (Owner or Repository) routes to `compareNullsLast` with
 * the requested `dir` so its null rows stay LAST in both directions (never
 * flipped by `factor`); every other key is the ascending `compareSortKeys`
 * result flipped by `factor`.
 */
function compareDecoratedKeys(
  a: SessionSortKey,
  b: SessionSortKey,
  dir: "asc" | "desc",
  factor: number
): number {
  if (isNullsLastSortKey(a) && isNullsLastSortKey(b)) {
    return compareNullsLast(a.nullsLast, b.nullsLast, dir);
  }
  if (isStatusSortKey(a) && isStatusSortKey(b)) {
    return compareStatusRank(a, b, dir);
  }
  return compareSortKeys(a, b) * factor;
}

/**
 * FEA-4301: compare two displayed-status sort keys. An UNKNOWN (future/legacy)
 * status sorts LAST regardless of `dir` — mirroring the cloud
 * `compareByDisplayedStatus` unknown-last placement — so a descending page cannot
 * promote an unknown status to the front the way a direction-flipped rank would.
 * Among known statuses the lifecycle rank follows `dir` (ascending Active →
 * Waiting → …, negated for descending). Equal ranks return 0 so the stable sort's
 * incoming recency order (the index tiebreak in `sortSyncedSessions`) decides.
 */
function compareStatusRank(
  a: { statusRank: number; known: boolean },
  b: { statusRank: number; known: boolean },
  dir: "asc" | "desc"
): number {
  if (a.known !== b.known) {
    return a.known ? -1 : 1;
  }
  const delta = a.statusRank - b.statusRank;
  return dir === "asc" ? delta : -delta;
}

/**
 * FEA-4426: the comparable sort key for one session under `sortKey`, derived
 * once per session by `sortSyncedSessions`. String columns yield a string,
 * numeric columns (cost/duration/timestamps) yield a number, and the nulls-last
 * columns (`user` owner display name, `repo` repositoryFullName) yield a
 * `{ nullsLast }` wrapper carrying the resolved value or `null`;
 * `compareDecoratedKeys` compares two keys of the same kind with semantics
 * identical to the old per-comparison `compareSessions` switch.
 */
function sessionSortKey(
  session: SyncedAgentSession,
  sortKey: string
): SessionSortKey {
  switch (sortKey) {
    case "status": {
      // FEA-4301: order by the DISPLAYED status lifecycle rank — the SAME
      // projection + rank the cloud `compareByDisplayedStatus` uses — so a row
      // awaiting input sorts as Waiting (not by its raw `active` string) and a
      // header click orders identically in desktop Local mode and the cloud.
      // Sorting the raw canonical string with `localeCompare` (the old behavior)
      // ordered alphabetically and could not project Waiting.
      //
      // ISS-4556: the gate is passed through so the sort ranks the SAME value
      // `mapListItem` serves and `matchesStatusFilter` buckets. ON, a long-silent
      // `active` row ranks as Stale (4) instead of Active (0), matching the cloud
      // and the badge the shared row already renders; OFF, the ranking is
      // unchanged, so this stays inside the closed-by-default rollout.
      const displayed = projectDisplayedSharedStatus(
        session,
        isDisplayedStatusParityEnabled()
      );
      return {
        statusRank: displayedSharedStatusRank(displayed),
        known: isKnownSharedStatus(displayed),
      };
    }
    case "repo":
      // FEA-4299/FEA-4330: the repository sort keeps rows with no resolved
      // remote (null `repositoryFullName`, rendered "Unknown") LAST in BOTH
      // directions — matching the cloud `nullableColumnOrder(..., dir)` which
      // pins `nulls: "last"` both ways. Wrapping the key routes it through
      // `compareNullsLast` (never flipped by the outer `factor`), exactly like
      // the owner key; coercing null to "" sorted Unknown FIRST ascending.
      return { nullsLast: sessionRepositoryName(session) };
    case "harness":
      return session.harness ?? "";
    case "model":
      return session.model ?? "";
    case "user":
      // Multiplayer owner attribution (org-directory resolution) now gives each
      // row a real owner, so the User column is sortable rather than an inert
      // no-op. Order by the resolved owner DISPLAY name — the SAME proxy the
      // cloud orders `user` by (`displayUserName`, FEA-4300) — so a header click
      // sorts identically in desktop Local mode and the cloud. Owner-less rows
      // stay LAST in both directions (FEA-4330); the stable sort preserves the
      // incoming recency order within a tie, mirroring the cloud's updated-desc
      // tiebreak.
      return { nullsLast: sessionOwnerSortKey(session) };
    case "cost":
      return sumTokenUsage(session).estimatedCost;
    case "duration":
      // ISS-5131: nulls-last, like the Owner and Repository columns. An
      // unmeasurable duration renders BLANK in the cell, so it must collect with
      // the other blanks in both directions rather than rank as a 0 and scatter
      // among the real minima — a sort the reader cannot verify from what is on
      // screen. This is the ISS-4979 rollout condition on this comparator.
      return { nullsLast: sessionDurationMs(session) };
    case "updated":
      // ISS-6005: record-mutation recency — the SAME `sessions.updated_at` the
      // local list serves as `recordUpdatedAt`, so the order matches the
      // rendered `Updated` cell (on this store the row's updated_at IS the
      // record-mutation clock; see `buildLocalSessionTimingAndUsage`).
      return parseSessionDate(session.updatedAt).getTime();
    case "lastActivity":
      // PLN-1034: genuine activity, falling back to the start time when a
      // session has no events yet (matches the cloud's floored derivation).
      return parseSessionDate(
        session.lastActivityAt ?? session.startedAt
      ).getTime();
    default:
      return parseSessionDate(session.startedAt).getTime();
  }
}

/**
 * FEA-4426: compare two precomputed session sort keys of the same non-nulls-last
 * kind, matching the ascending-direction result the old `compareSessions` switch
 * produced — `localeCompare` for strings, subtraction for numbers. The nulls-last
 * keys (`user` owner, `repo` repository) are handled separately by
 * `compareDecoratedKeys` (nulls-last, both directions) and never reach this path.
 */
function compareSortKeys(a: SessionSortKey, b: SessionSortKey): number {
  if (typeof a === "string" && typeof b === "string") {
    return a.localeCompare(b);
  }
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  return 0;
}

function isNullsLastSortKey(
  key: SessionSortKey
): key is { nullsLast: string | number | null } {
  return typeof key === "object" && "nullsLast" in key;
}

function isStatusSortKey(
  key: SessionSortKey
): key is { statusRank: number; known: boolean } {
  return typeof key === "object" && "statusRank" in key;
}

/**
 * Sort proxy for the Owner column: the resolved org-directory owner's DISPLAYED
 * name (lower-cased for case-insensitive order), mirroring the cloud's
 * `displayUserName`-based `user` sort (FEA-4300). An owner that can't be resolved
 * (null `user_id`, or an id not in the directory / not yet warmed) yields `null`,
 * handled by `compareOwnerName` as a NULL owner (sorts last, both directions).
 */
function sessionOwnerSortKey(session: SyncedAgentSession): string | null {
  const owner = resolveOwner(session.userId ?? null, getOrgDirectorySnapshot());
  if (!owner) {
    return null;
  }
  return displayUserName(owner).toLowerCase();
}

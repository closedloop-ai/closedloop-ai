import { sessionCostIsNumeric } from "@repo/api/src/agent-session-filters";
import {
  compareListQueryText,
  ListQueryTextOrdering,
} from "@repo/api/src/types/list-query-ordering-semantics";
import { PRIORITY_ORDINAL } from "@repo/api/src/types/search-query";
import {
  resolveSessionDurationLifecycle,
  SessionDurationLifecycle,
} from "@repo/api/src/types/session-status";
import { compareSessionSortIdentityDescending } from "@repo/api/src/types/session-status-root-order";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import {
  getOrgDirectorySnapshot,
  resolveOwner,
} from "./org-directory-cache.js";
import { parseSessionDate } from "./session-instant.js";
import { sessionRepositoryName } from "./session-repository-facet.js";
import {
  localSubstantiveCounts,
  sumTokenUsage,
} from "./session-usage-totals.js";
import { resolveDisplayedSharedSessionStatus } from "./shared-agent-session-status.js";
import type { SanitizedQuery } from "./shared-agent-sessions-query.js";
import { displayUserName } from "./user-display-name.js";

// FEA-4426: the precomputed, comparable sort key for one session. A string
// for the string columns (harness), a number for the
// timestamp columns, flagged Status as root key plus target/session identity, or a
// nulls-last wrapper for the
// columns whose value can be genuinely ABSENT — `user` (an unresolved owner),
// `repo` (no resolved Git remote, "Unknown"), `priority`, since ISS-5131
// `duration` (a terminal session with no end instant, which the cell renders
// blank), and since ISS-9479 `model` (none recorded) and `cost` (a cell that
// shows no figure) — whose `null` needs `compareNullsLast`'s nulls-last (both
// directions) placement rather than plain comparison.
export type SessionSortKey =
  | string
  | number
  | { nullsLast: string | number | null }
  | {
      statusRootRank: number | null;
      computeTargetId: string | null;
      externalSessionId: string;
    };

/**
 * Sort the filtered working set by a column id (matching the table headers).
 * Returns a new array; an unset `sortBy` preserves the incoming cursor order.
 *
 * Exported for the FEA-4426 decorate-sort-undecorate order-parity tests.
 */
export function sortSyncedSessions(
  sessions: SyncedAgentSession[],
  query: SanitizedQuery,
  statusRootRank?: (status: string) => number | null,
  computeTargetId: string | null = null
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
  // equal non-Status keys reproduces their previous tie order exactly (the
  // recency tiebreak the `user` and flag-off Status columns rely on). Flagged
  // Status alone owns an explicit cross-host identity tie.
  //
  // FEA-4300/FEA-4330/FEA-4299 (merged): the nulls-last sorts (Owner,
  // Repository and the rest `SessionSortKey` lists) own their own direction so
  // they keep null rows LAST in BOTH directions — a nulls-last key is compared by
  // `compareNullsLast(a, b, dir)` (which applies `dir` internally and never flips
  // nulls), NOT multiplied by the outer `factor`. Every other key uses the
  // ascending `compareSortKeys` flipped by `factor`, identical to before.
  const decorated = sessions.map((session, index) => ({
    session,
    index,
    key: sessionSortKey(session, sortKey, statusRootRank, computeTargetId),
  }));
  decorated.sort((a, b) => {
    const byKey = compareDecoratedKeys(a.key, b.key, dir, factor);
    return byKey === 0 ? a.index - b.index : byKey;
  });
  return decorated.map((entry) => entry.session);
}

/**
 * ISS-6895: the decorate half of {@link sortSyncedSessions}, exposed so a
 * windowed read can retain a session's SORT KEY instead of the session itself.
 * `null` when the read carries no sort — the incoming (cursor) order stands, and
 * there is nothing to compare.
 */
export function sessionSortKeyForQuery(
  session: SyncedAgentSession,
  query: SanitizedQuery,
  statusRootRank?: (status: string) => number | null,
  computeTargetId: string | null = null
): SessionSortKey | null {
  return query.sortBy
    ? sessionSortKey(session, query.sortBy, statusRootRank, computeTargetId)
    : null;
}

/**
 * ISS-6895: the compare half of {@link sortSyncedSessions}, over two keys from
 * {@link sessionSortKeyForQuery}. `null` for a read with no sort — the incoming
 * (cursor) order already IS the answer, so the caller keeps it rather than
 * ordering by a key that does not exist. Ties return 0 so the caller's own
 * stable tiebreak (incoming position) decides for ordinary ties, exactly as
 * it does inside `sortSyncedSessions`; flagged Status carries its own identity.
 */
export function sessionSortKeyComparator(
  query: SanitizedQuery
): ((a: SessionSortKey | null, b: SessionSortKey | null) => number) | null {
  if (!query.sortBy) {
    return null;
  }
  const dir = query.sortDir === "asc" ? "asc" : "desc";
  const factor = dir === "asc" ? 1 : -1;
  return (a, b) => {
    // Two rows with no key are equally unordered; `sessionSortKeyForQuery` only
    // yields null for a read this comparator is never built for.
    if (a === null || b === null) {
      return 0;
    }
    return compareDecoratedKeys(a, b, dir, factor);
  };
}

/**
 * FEA-4330: compare two nullable string sort keys with NULL always sorting LAST,
 * independent of `dir` — the shared shape of the cloud's `nulls: "last"` ORDER BY
 * for every nullable column. The present-value comparison follows `dir`
 * (ascending, collated per ISS-9585 for strings, negated for descending). Used
 * by every nulls-last key so their null placement cannot drift.
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
      : compareCollated(String(a), String(b));
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
 * call, and is overridable so a test can assert an EXACT running span. whitlockk
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
 * list of status literals (whitlockk, #4409). The split it closed, stated in the
 * past tense it now belongs in: this comparator once read the RAW stored
 * `session.status` (`error`) while the row the reader saw was built by
 * `mapListItem` AFTER `canonicalSharedStatus` had rewritten that to `failed`, so
 * two hand-rolled copies of "is this terminal", each spelling out its own
 * literals, put one session's cell and its own sort key on opposite sides of the
 * branch: a live, growing duration in the cell, sorted with the blanks.
 *
 * ISS-5592 deleted BOTH the alias and the boundary rewrite that manufactured it
 * — `canonicalSharedStatus` case-folds and nothing else — so the classifier no
 * longer folds that spelling onto `error`. It does not recognize it at all:
 * `failed` is an UNRECOGNIZED status and takes the `Indeterminate` branch
 * described below, not the branch `error` takes. ONE classifier is still the
 * point, but what it buys now is that all three copies answer an unrecognized
 * status identically, and that a FUTURE alias cannot reopen the split.
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
 * sort. A nulls-last key routes to `compareNullsLast` with
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
  if (isStatusRootSortKey(a) && isStatusRootSortKey(b)) {
    const byRank = compareNullsLast(a.statusRootRank, b.statusRootRank, dir);
    return byRank === 0 ? compareSessionSortIdentityDescending(a, b) : byRank;
  }
  if (isNullsLastSortKey(a) && isNullsLastSortKey(b)) {
    return compareNullsLast(a.nullsLast, b.nullsLast, dir);
  }
  return compareSortKeys(a, b) * factor;
}

/**
 * FEA-4426: the comparable sort key for one session under `sortKey`, derived
 * once per session by `sortSyncedSessions`. String columns yield a string, the
 * timestamp columns yield a number, and the nulls-last columns (`repo`, `model`,
 * `user`, `cost`, `priority`, `duration`) yield a `{ nullsLast }` wrapper
 * carrying the resolved value or `null`; `compareDecoratedKeys` compares two
 * keys of the same kind.
 */
function sessionSortKey(
  session: SyncedAgentSession,
  sortKey: string,
  statusRootRank?: (status: string) => number | null,
  computeTargetId: string | null = null
): SessionSortKey {
  switch (sortKey) {
    case "status":
      if (statusRootRank) {
        return {
          statusRootRank: statusRootRank(session.status),
          computeTargetId,
          externalSessionId: session.externalSessionId,
        };
      }
      // ISS-9939 / ISS-10262: order by the PERSISTED lifecycle status — the
      // same value cloud's off-path sort compares (plain RAW string), not the
      // DISPLAYED/projected one FEA-4301 used to rank by. A row awaiting input
      // (stored `active`) sorts with the other Active rows now, not contiguous
      // with a genuinely displayed-Waiting one — that FEA-4301 behavior is
      // knowingly superseded on both surfaces, together, so a header click
      // keeps ordering identically in desktop Local mode and the cloud.
      // DISPLAY (the badge), the Status FACET, and Duration are UNCHANGED —
      // they still read the displayed projection
      // (`resolveDisplayedSharedSessionStatus`, used below for Duration).
      //
      // marisolashgrove (#7289 review): this used to route through
      // `normalizeSessionStatus`, on the premise that cloud's `artifacts.status`
      // is "already normalized" and desktop's local producer is the only side
      // that can still store the literal `waiting`. That premise is false —
      // the ISS-5981 migration deliberately leaves a LIVE-AND-ANCHORLESS
      // session (`sessionEndedAt` null, `awaitingInputSince` null) storing the
      // literal `waiting`, permanently, on the CLOUD side too, and no later
      // migration drains it. Folding only here reopened the exact drift this
      // ticket exists to close, on that one residual population: cloud sorted
      // that row by the raw string (after `inactive`, ascending) while desktop
      // folded it into the Active group. Comparing the raw string on BOTH
      // surfaces — no fold, matching cloud's `dbColumnOrderBy` — is what
      // "reduced to the three PERSISTED statuses" actually means: a value
      // outside that set (a legacy `waiting` literal, or an unrecognized
      // future spelling) sorts by its own persisted spelling on both off-paths.
      // D5's flagged path above instead places such values last.
      return session.status;
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
      // ISS-9479: a session with no recorded model sorts LAST in both
      // directions, the cloud's NULLS LAST, as FEA-4299 did for `repo`.
      return { nullsLast: session.model ?? null };
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
      return { nullsLast: sessionDisplayedCost(session) };
    case "priority":
      // ISS-10332: the cloud comparator's key — the wire ordinal, never the
      // enum spelling ("HIGH" sorts before "LOW" as a string) — with no-priority
      // rows last in both directions.
      return {
        nullsLast: session.priority ? PRIORITY_ORDINAL[session.priority] : null,
      };
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
 * kind in ascending direction — collated per ISS-9585 for strings, subtraction
 * for numbers. The nulls-last keys are handled separately by
 * `compareDecoratedKeys` (nulls-last, both directions) and never reach this path.
 */
function compareSortKeys(a: SessionSortKey, b: SessionSortKey): number {
  if (typeof a === "string" && typeof b === "string") {
    return compareCollated(a, b);
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

function isStatusRootSortKey(key: SessionSortKey): key is {
  statusRootRank: number | null;
  computeTargetId: string | null;
  externalSessionId: string;
} {
  return typeof key === "object" && "statusRootRank" in key;
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

/**
 * ISS-9479: the ISS-9585 collation, pinned to one locale, so the order does not
 * follow the host's locale the way a bare `localeCompare()` does.
 */
function compareCollated(a: string, b: string): number {
  return compareListQueryText(a, b, ListQueryTextOrdering.Collated);
}

/**
 * ISS-9479: the cost the Cost cell shows, or `null` where the cell shows no
 * figure. `sessionCostIsNumeric` is the numeric-vs-unknown boundary the Cost
 * facet reads and the cell's `deriveCostAvailability` mirrors, so an unknown
 * cost sorts with the other blanks, last in both directions like the cloud's
 * NULLS LAST, rather than as a $0.
 */
function sessionDisplayedCost(session: SyncedAgentSession): number | null {
  const cost = sumTokenUsage(session).estimatedCost;
  const numeric = sessionCostIsNumeric({
    estimatedCost: cost,
    billingMode: session.billingMode ?? null,
    ...localSubstantiveCounts(session),
  });
  return numeric ? cost : null;
}

import {
  DISPLAYED_SESSION_STATUS,
  resolveSessionDurationLifecycle,
  SessionDurationLifecycle,
} from "@repo/api/src/types/session-status";
import type { Prisma } from "@repo/database";
import { displayUserName } from "@/lib/user-display-name";
import {
  displayedStatusRank,
  isKnownDisplayedStatus,
  projectDisplayedSessionStatus,
} from "./session-status-projection";

/**
 * FEA-4297/FEA-4300/FEA-4301: in-memory comparators for the Sessions sort columns
 * whose displayed value is a derivation, not a single trustworthy DB column.
 *
 * Each derivation MIRRORS the client SSOTs so the server order can never diverge
 * from what the row renders:
 *  - Duration = the ISS-5131 wall-time rule: `now - start` while the session is
 *    running, `end - start` once it is terminal — the same rule
 *    `resolveSessionDurationWindow` renders in the Duration cell
 *    (`packages/app/agents/lib/session-duration.ts`), applied to the DISPLAYED
 *    status (ISS-6270), not the raw column. A session whose Duration cell
 *    renders blank sorts last in both directions.
 *  - Owner display name = the canonical backend `displayUserName`
 *    (`apps/api/lib/user-display-name.ts`): `"First Last"` trimmed, falling back
 *    to email — the SAME derivation the Owner cell projects, compared
 *    case-insensitively. A session with no owner sorts last.
 *  - Status = the PROJECTED displayed status (`projectDisplayedSessionStatus`):
 *    the raw persisted status, except a row awaiting input DISPLAYS as Waiting
 *    even though it stores `active` (FEA-4301). Ordering by the raw column put a
 *    displayed-Waiting row among the Active rows; ordering by the projection keeps
 *    it contiguous with the other Waiting rows.
 */

/** The narrow candidate columns the display-value comparators read. */
export const displaySortCandidateSelect = {
  artifactId: true,
  sessionStartedAt: true,
  sessionEndedAt: true,
  awaitingInputSince: true,
  // ISS-5366: the staleness anchor. The displayed-status projection folds a
  // long-silent `active` run to `stale`, so the Status sort must read the same
  // timestamps the badge does or it ranks rows by a status nothing renders.
  lastActivityAt: true,
  // ISS-6005: the two DB-maintained `@updatedAt` columns behind the rendered
  // `recordUpdatedAt` (the `Updated` column). The displayed value is their MAX
  // — no single stored column — which is what routes `updated` through this
  // in-memory path rather than a Prisma orderBy.
  updatedAt: true,
  artifact: { select: { status: true, updatedAt: true } },
  user: {
    select: {
      firstName: true,
      lastName: true,
      email: true,
    },
  },
} satisfies Prisma.SessionDetailSelect;

export type DisplaySortCandidate = Prisma.SessionDetailGetPayload<{
  select: typeof displaySortCandidateSelect;
}>;

/**
 * The displayed Duration span in milliseconds, or `null` when the session's
 * Duration cell renders BLANK.
 *
 * ISS-5131: this MIRRORS the one Duration rule the cell renders
 * (`resolveSessionDurationWindow` / `resolveSessionWallClockMs` in
 * `packages/app/agents/lib/session-duration.ts`) — `now - start` while the
 * session is running, `end - start` once it is terminal — so `?sortBy=duration`
 * orders the page by the number the reader can see. The rule is restated here
 * rather than imported because that module is browser/renderer-only; the shared
 * `@closedloop-ai/loops-api` status constants are the part both copies read from one
 * place.
 *
 * It no longer leads with `wallClock`. That value is anchored on the last
 * ACTIVITY timestamp, which on a completed session tracks SYNC time and read
 * 170h for a 31h session, so ordering by it would reproduce on the server the
 * exact non-monotonic paint ISS-4675 fixed here.
 *
 * `null` — and therefore nulls-last in BOTH directions, via
 * {@link compareByDisplayDuration} — in the three cases the cell has no number
 * to show: no `sessionStartedAt`, a terminal session with no `sessionEndedAt`
 * (one instant is not a span), and a non-positive span (an end before its start
 * is nonsensical data, not a `0s` measurement). That is the ISS-4979 rollout
 * condition on this comparator, now satisfied.
 *
 * ISS-6270: `displayedStatus` is the status the ROW DISPLAYS, resolved by
 * {@link resolveDisplayedStatus} — the same projection the Status cell renders,
 * the Status facet filters by, and the list response serves. It is a parameter
 * rather than a re-derivation so the comparator reads the memo pinned once per
 * candidate ({@link displayedStatusMemo}), which makes the Duration sort key and
 * the Status sort key of one row provably the same verdict. Omitting it resolves
 * the same projection, so there is NO path here that reads `artifact.status`
 * directly again.
 *
 * The default measures the staleness cutoff against the CALLER'S `nowMs`, never
 * an ambient `Date.now()`. The span and the fold that decides whether there IS a
 * span have to be read from one clock, or a caller pinning an exact instant gets
 * a row judged live by one and long-silent by the other.
 */
export function resolveDisplayDurationMs(
  candidate: DurationSortCandidate,
  nowMs: number,
  displayedStatus: string | null = resolveDisplayedStatus(
    candidate,
    new Date(nowMs)
  )
): number | null {
  const start = candidate.sessionStartedAt?.getTime();
  if (start === undefined) {
    return null;
  }
  const end = resolveDisplayDurationEndMs(candidate, nowMs, displayedStatus);
  if (end === null) {
    return null;
  }
  const span = end - start;
  return span > 0 ? span : null;
}

/**
 * The fields the Duration sort key reads. Wider than the span itself needs
 * because ISS-6270 keys it on the DISPLAYED status, which the staleness fold
 * derives from the activity anchor — the same inputs the Status cell reads.
 *
 * `sessionStartedAt` is defensively nullable even though the column is not: a
 * missing start yields no orderable span. `artifact` is optional so a caller
 * assembling a narrower candidate still compiles; an absent status is
 * `Indeterminate` and resolves by evidence, exactly as an unrecognized one does.
 *
 * The two fold inputs are OPTIONAL rather than required. `displaySortCandidateSelect`
 * always projects them, so the comparator's own path never omits one — but a
 * caller assembling a narrower candidate to ask "what span does this shape
 * display" should not be forced to invent an awaiting-input timestamp it has no
 * evidence for. Absent reads as absent, which is what the projection already
 * does with a null.
 */
type DurationSortCandidate = {
  sessionStartedAt: Date | null;
  artifact?: { status: string | null } | null;
  awaitingInputSince?: Date | null;
  lastActivityAt?: Date | null;
} & Pick<DisplaySortCandidate, "sessionEndedAt">;

/**
 * ISS-5131: the instant the displayed Duration is measured TO, or `null` when
 * the session is not known to be running and carries no end instant.
 *
 * ONE classifier ({@link resolveSessionDurationLifecycle}) rather than a local
 * list of status literals (wongk, #4409). Hand-listing them here is what let the
 * desktop's `failed` alias — written by `canonicalSharedStatus` before
 * `mapListItem`, and the SAME lifecycle as the raw `error` this server stores —
 * land on the opposite side of the branch from its twin: a row rendering a live,
 * growing duration while its comparator sorted it with the blanks. The shared
 * classifier folds `failed`/`running`/`completed`/`abandoned` for all three
 * copies at once.
 *
 * `Indeterminate` (an unrecognized status, or one this server does not
 * recognize) resolves by EVIDENCE and never reaches the clock: a
 * `sessionEndedAt` bounds it, and its absence leaves it unmeasurable rather than
 * silently claiming the run is still going.
 *
 * ISS-6270: it classifies the DISPLAYED status, not the raw column. A run silent
 * past the staleness cutoff DISPLAYS as `stale` — an `Indeterminate` lifecycle —
 * so it lands on the evidence-bounded branch exactly like the terminal rows,
 * which is what the Duration cell already renders for it. Reading the raw
 * `active` beside a blank cell is the ISS-5575 divergence one field over: the
 * comparator kept measuring against a running clock and made the row the longest
 * span in the table while it displayed no duration at all. A stale row that DID
 * record an end still measures that end, because this branch reads the evidence
 * rather than blanking the whole population.
 */
function resolveDisplayDurationEndMs(
  candidate: Pick<DurationSortCandidate, "sessionEndedAt">,
  nowMs: number,
  displayedStatus: string | null
): number | null {
  if (
    resolveSessionDurationLifecycle(displayedStatus) ===
    SessionDurationLifecycle.Running
  ) {
    return nowMs;
  }
  return candidate.sessionEndedAt?.getTime() ?? null;
}

/**
 * The owner display name used for sorting, lower-cased for case-insensitive
 * order, or `null` when the session has no owner. `"First Last"` trimmed, falling
 * back to email — mirrors `getUserDisplayName`.
 */
export function resolveOwnerSortKey(
  candidate: Pick<DisplaySortCandidate, "user">
): string | null {
  const user = candidate.user;
  if (!user) {
    return null;
  }
  // Derive through the canonical backend display-name SSOT
  // (`apps/api/lib/user-display-name.ts`) so this sort key can never drift from
  // the name the Owner cell renders (thread #11 / FEA-3506).
  return displayUserName(user).toLowerCase();
}

/**
 * FEA-4297: order candidates by the DISPLAYED duration span, then the FEA-4329
 * unique `artifactId` tiebreaker. Sessions with no resolvable duration sort last
 * in BOTH directions (FEA-4330 semantics), matching the blank Duration cell.
 */
export function compareByDisplayDuration(
  a: DisplaySortCandidate,
  b: DisplaySortCandidate,
  dir: "asc" | "desc"
): number {
  const aMs = displayDurationSortKey(a);
  const bMs = displayDurationSortKey(b);
  const nullsLast = compareNullsLast(aMs, bMs);
  if (nullsLast !== 0) {
    return nullsLast;
  }
  if (aMs !== null && bMs !== null && aMs !== bMs) {
    const delta = aMs - bMs;
    return dir === "asc" ? delta : -delta;
  }
  return compareTiebreaker(a, b);
}

/**
 * FEA-4300: order candidates by the DISPLAYED owner name (case-insensitive), then
 * the FEA-4329 unique `artifactId` tiebreaker. Owner-less sessions sort last in
 * BOTH directions (FEA-4330 semantics).
 */
export function compareByOwnerDisplayName(
  a: DisplaySortCandidate,
  b: DisplaySortCandidate,
  dir: "asc" | "desc"
): number {
  const aKey = ownerSortKey(a);
  const bKey = ownerSortKey(b);
  const nullsLast = compareNullsLast(aKey, bKey);
  if (nullsLast !== 0) {
    return nullsLast;
  }
  if (aKey !== null && bKey !== null && aKey !== bKey) {
    const cmp = aKey < bKey ? -1 : 1;
    return dir === "asc" ? cmp : -cmp;
  }
  return compareTiebreaker(a, b);
}

/**
 * FEA-4301: order candidates by the DISPLAYED status, then the FEA-4329 unique
 * `artifactId` tiebreaker. The displayed status is `projectDisplayedSessionStatus`
 * (the raw persisted status, except an awaiting-input row projects to Waiting) so
 * a displayed-Waiting row (stored `active`) sorts as Waiting and stays contiguous
 * with the other Waiting rows — not scattered among the Active rows the way an
 * order-by on the raw `artifact.status` column did. Ranks are the lifecycle order
 * Active → Waiting → Completed → Error → Abandoned.
 *
 * An UNKNOWN status (a future/legacy value not in the vocabulary) degrades to the
 * END in BOTH directions — direction-independent, exactly like the nulls-last
 * placement duration/owner use (FEA-4330 semantics). Applying `dir` to the raw
 * rank delta instead would flip the largest (unknown) rank to the FRONT of a
 * descending page, letting version-skewed statuses dominate — so unknown-vs-known
 * ordering is resolved BEFORE `dir` is applied, and `dir` flips only the ordering
 * among the known lifecycle ranks. Every row has a resolvable status (the column
 * is non-null), so there is no nulls-last case here — unlike duration/owner.
 */
export function compareByDisplayedStatus(
  a: DisplaySortCandidate,
  b: DisplaySortCandidate,
  dir: "asc" | "desc"
): number {
  // ISS-5366/ISS-6051: ONE instant per CANDIDATE, pinned by
  // {@link displayedStatusMemo} on first use. The displayed status folds a
  // long-silent `active` row to `stale`, so a row must be judged against ONE
  // cutoff for the whole sort — re-reading the clock per comparison let a row
  // sitting on the cutoff be judged `active` in one comparison and `stale` in
  // another, an inconsistent comparator whose output order is undefined.
  const aStatus = displayedStatusSortKey(a);
  const bStatus = displayedStatusSortKey(b);
  // Unknown statuses sort last regardless of direction (mirrors compareNullsLast).
  const unknownLast = compareUnknownStatusLast(aStatus, bStatus);
  if (unknownLast !== 0) {
    return unknownLast;
  }
  const aRank = displayedStatusRank(aStatus);
  const bRank = displayedStatusRank(bStatus);
  if (aRank !== bRank) {
    const delta = aRank - bRank;
    return dir === "asc" ? delta : -delta;
  }
  return compareTiebreaker(a, b);
}

/**
 * The displayed status of a candidate — the SAME projection the Status cell
 * renders, the Status facet filters by, and the list response serves
 * (`projectDisplayedSessionStatus`).
 *
 * ISS-6270: ONE owner for every comparator that needs it. The Status comparator
 * has read it since FEA-4301; the Duration comparator now reads it too, so the
 * two columns and the served payload cannot disagree about what state a row is
 * in. `null` only where the candidate carries no status at all — a shape the
 * `DisplaySortCandidate` select cannot produce, but which the narrower
 * {@link DurationSortCandidate} type admits; an absent status asserts nothing
 * and resolves by evidence rather than being coerced into a real state.
 */
function resolveDisplayedStatus(
  candidate: DurationSortCandidate,
  now: Date
): string | null {
  const status = candidate.artifact?.status;
  if (status == null) {
    return null;
  }
  return projectDisplayedSessionStatus(
    {
      status,
      awaitingInputSince: candidate.awaitingInputSince ?? null,
      sessionEndedAt: candidate.sessionEndedAt,
      lastActivityAt: candidate.lastActivityAt,
      sessionStartedAt: candidate.sessionStartedAt,
    },
    now
  );
}

/**
 * Unknown-status-last ordering independent of direction (FEA-4330): a KNOWN
 * displayed status always precedes an unknown (future/legacy) one, regardless of
 * `dir`. Returns 0 when both are known (the caller compares ranks) or both unknown
 * (the caller falls to the tiebreaker), so a descending page cannot promote an
 * unknown status to the front the way a direction-flipped rank delta would.
 */
function compareUnknownStatusLast(a: string, b: string): number {
  const aUnknown = !isKnownDisplayedStatus(a);
  const bUnknown = !isKnownDisplayedStatus(b);
  if (aUnknown === bUnknown) {
    return 0;
  }
  return aUnknown ? 1 : -1;
}

/**
 * Nulls-last ordering independent of direction (FEA-4330): a present value always
 * precedes a null. Returns 0 when both are present (the caller compares values)
 * or both null (the caller falls to the tiebreaker).
 */
function compareNullsLast(a: unknown, b: unknown): number {
  const aNull = a === null;
  const bNull = b === null;
  if (aNull === bNull) {
    return 0;
  }
  return aNull ? 1 : -1;
}

/**
 * FEA-4329: the stable unique tiebreaker — `artifactId` descending, matching
 * `SESSION_UNIQUE_TIEBREAKER` on the DB path — so equal-value candidates paginate
 * deterministically.
 */
function compareTiebreaker(
  a: DisplaySortCandidate,
  b: DisplaySortCandidate
): number {
  if (a.artifactId === b.artifactId) {
    return 0;
  }
  return a.artifactId < b.artifactId ? 1 : -1;
}

/**
 * Memo of a candidate's resolved duration sort key.
 *
 * ISS-5131 makes this load-bearing for CORRECTNESS, not only for cost: a running
 * session's key is measured against `Date.now()`, so re-deriving it on each of
 * the O(log n) comparisons `Array#sort` asks for could return two different
 * values for one candidate within a single sort — an inconsistent comparator,
 * whose output order is undefined. Resolving each candidate's key ONCE per
 * request (weak-keyed by {@link memoizedSortKey}) pins every running session to
 * one clock reading.
 */
const displayDurationKeyMemo = new WeakMap<object, number | null>();

/**
 * The memoized {@link resolveDisplayDurationMs} used by the comparator.
 *
 * ISS-6270: it hands over the ALREADY-MEMOIZED displayed status
 * ({@link displayedStatusSortKey}) rather than letting the default re-derive
 * one. Two reasons, both correctness. The Duration and Status columns then key
 * one row off a single pinned verdict, so a row cannot sort as Stale in one
 * column and Active in the other. And the staleness cutoff stays off the
 * QUANTIZED duration clock: `durationSortClockMs` floors to a minute, which is
 * right for a growing span and wrong for a 24h cutoff (see
 * {@link displayedStatusMemo}).
 */
function displayDurationSortKey(
  candidate: DisplaySortCandidate
): number | null {
  return memoizedSortKey(displayDurationKeyMemo, candidate, (row) =>
    resolveDisplayDurationMs(
      row,
      durationSortClockMs(),
      displayedStatusSortKey(row)
    )
  );
}

/**
 * ISS-5131 (#4409 review): the clock a RUNNING session's duration sort key is
 * measured against, QUANTIZED to {@link DURATION_SORT_CLOCK_QUANTUM_MS}.
 *
 * `findDisplayValueSortedPage` re-materializes the candidate set, re-sorts it in
 * memory and slices `offset..offset+limit` on EVERY request, so page 2 sorts
 * against its own clock. Running rows grow by the seconds between the two calls
 * while terminal rows do not, and any running row sitting within that gap of a
 * terminal row on the page boundary crosses it — the reader sees that session
 * twice, or never. The {@link displayDurationKeyMemo} pins the clock WITHIN one
 * sort, which the comparator needs to be consistent at all, but it does nothing
 * ACROSS requests.
 *
 * Flooring to a fixed bucket makes consecutive page requests resolve the
 * byte-identical key set unless they straddle a bucket boundary, which turns "a
 * phantom duplicate row is possible on every page-2 request" into "possible in
 * the one request that crosses a minute". A minute also matches what the reader
 * can actually see: `formatDuration` renders a multi-hour span at minute
 * granularity, so within a bucket the keys and the rendered values move
 * together.
 *
 * It does NOT eliminate the boundary case. Doing that needs a request timestamp
 * pinned on the pagination cursor so every page of one traversal shares a clock,
 * which is an additive API-contract change this correctness fix does not carry.
 */
function durationSortClockMs(): number {
  return (
    Math.floor(Date.now() / DURATION_SORT_CLOCK_QUANTUM_MS) *
    DURATION_SORT_CLOCK_QUANTUM_MS
  );
}

/** The bucket {@link durationSortClockMs} floors the running-session clock to. */
const DURATION_SORT_CLOCK_QUANTUM_MS = 60 * 1000;

/**
 * ISS-6005: a candidate's record-mutation instant — the value the `Updated`
 * column renders (`recordUpdatedAt`).
 *
 * The MAX of the two DB-maintained `@updatedAt` columns the session record
 * spans: `session_detail.updated_at` (advanced by sync/upsert writes) and its
 * parent `artifacts.updated_at` (advanced by parent-row mutations — a status
 * fold by the reaper, and the forward-looking comment/tag cases — that never
 * touch the detail row). One derivation, shared by this module's comparator and
 * the list projection (`projections.ts`), so the order and the rendered value
 * cannot drift.
 *
 * NOT `session_detail.session_updated_at`: that is the harness-reported
 * recompute stamp (the wire `updatedAt`), which does not advance on a
 * cloud-side record mutation.
 *
 * Returns `null` when NEITHER column is present. Both are `@updatedAt` and so
 * non-null in the schema, but presence here is a property of the caller's
 * SELECT, not of the row: `toSessionListItem` is shared by the list read and
 * the detail read, and a select that does not project these columns (or a test
 * double standing in for one) yields `undefined` at runtime with no type error.
 * Dereferencing that threw a 500 on the whole response — a blank `Updated` cell
 * is the honest degradation, and the caller omits the field rather than
 * serializing a null or substituting a lookalike timestamp.
 */
export function resolveRecordUpdatedAt(candidate: {
  updatedAt?: Date | null;
  artifact?: { updatedAt?: Date | null } | null;
}): Date | null {
  const detailUpdatedAt = candidate.updatedAt ?? null;
  const parentUpdatedAt = candidate.artifact?.updatedAt ?? null;
  if (!(detailUpdatedAt && parentUpdatedAt)) {
    return detailUpdatedAt ?? parentUpdatedAt;
  }
  return detailUpdatedAt.getTime() >= parentUpdatedAt.getTime()
    ? detailUpdatedAt
    : parentUpdatedAt;
}

/**
 * ISS-6005: order candidates by the record-mutation instant the `Updated` cell
 * renders, then the FEA-4329 unique `artifactId` tiebreaker.
 *
 * Both source columns are `@updatedAt` and this comparator's own select
 * (`displaySortCandidateSelect`) projects both, so an unresolvable key is not a
 * reachable state for a real page — but it is collected LAST if it ever occurs,
 * matching the duration/owner comparators rather than sorting a blank cell
 * among real instants.
 */
export function compareByRecordUpdatedAt(
  a: DisplaySortCandidate,
  b: DisplaySortCandidate,
  dir: "asc" | "desc"
): number {
  const aMs = recordUpdatedAtSortKey(a);
  const bMs = recordUpdatedAtSortKey(b);
  const nullsLast = compareNullsLast(aMs, bMs);
  if (nullsLast !== 0) {
    return nullsLast;
  }
  if (aMs !== null && bMs !== null && aMs !== bMs) {
    const delta = aMs - bMs;
    return dir === "asc" ? delta : -delta;
  }
  return compareTiebreaker(a, b);
}

/**
 * ISS-6051: read a candidate's sort key, deriving it ONCE per candidate and
 * holding it for the rest of the sort.
 *
 * `Array#sort` asks a comparator for O(n log n) comparisons, so a key derived
 * inside the comparator is recomputed ~2·n·log n times — over the 10,000-row
 * candidate cap `findDisplayValueSortedPage` materializes, ~266,000 derivations
 * where 10,000 do. Deriving on first use collapses that to one per row, the same
 * decorate-sort-undecorate the desktop twin applies in `sortSyncedSessions`
 * (FEA-4426).
 *
 * Keyed on the candidate OBJECT and held WEAKLY, so entries are bounded by GC
 * and can never accumulate across requests the way a plain `Map` cache would.
 * `undefined` is the miss sentinel; no derivation here returns it (`null` is the
 * "no orderable value" key), so a resolved key is never re-derived.
 */
function memoizedSortKey<TKey>(
  memo: WeakMap<object, TKey>,
  candidate: DisplaySortCandidate,
  derive: (candidate: DisplaySortCandidate) => TKey
): TKey {
  const cached = memo.get(candidate);
  if (cached !== undefined) {
    return cached;
  }
  const resolved = derive(candidate);
  memo.set(candidate, resolved);
  return resolved;
}

/** Memo of a candidate's resolved owner sort key (ISS-6051). */
const ownerSortKeyMemo = new WeakMap<object, string | null>();

/**
 * The memoized {@link resolveOwnerSortKey} used by the comparator. Rebuilt per
 * comparison it re-ran the whole `displayUserName` derivation — an array filter,
 * join, trim and lower-case — on both operands every time.
 */
function ownerSortKey(candidate: DisplaySortCandidate): string | null {
  return memoizedSortKey(ownerSortKeyMemo, candidate, resolveOwnerSortKey);
}

/**
 * Memo of a candidate's resolved DISPLAYED status.
 *
 * Load-bearing for CORRECTNESS as well as cost, exactly like
 * {@link displayDurationKeyMemo}: the projection folds a long-silent `active`
 * row to `stale` against a clock, so a row whose silence sits on the cutoff
 * could be judged `active` in one comparison and `stale` in the next while the
 * same sort was still running — an inconsistent comparator, whose output order
 * is undefined. Pinning ONE instant per candidate — read on first use rather
 * than per comparison — gives every row a single verdict for the whole sort.
 *
 * That instant is per CANDIDATE, not one pinned instant for the whole page: a
 * row can still be judged against a clock reading milliseconds later than its
 * neighbour's, so a row crossing the cutoff mid-sort lands on whichever side its
 * own read saw. Two things make that the right trade rather than a gap left
 * open. It is the same granularity the row's OWN payload uses — the status the
 * response carries is projected per row in `projections.ts`, each against its
 * own `new Date()` — so the sort key and the rendered badge can only disagree
 * inside that same sub-millisecond window. And closing it properly means one
 * pinned `now` threaded through the sort, which is a decorate-sort-undecorate at
 * the two call sites (`findDisplayValueSortedPage` and the cost path's
 * `postFilterCompare`), not a change to this memo.
 *
 * The clock is deliberately NOT quantized the way the duration key's is. That
 * would pin every candidate to one instant, but a 60s floor on a 24h cutoff
 * would rank a row `active` for up to a minute after its own payload started
 * saying `stale` — trading a sub-millisecond divergence for a minute-long one,
 * which is the badge-vs-position mismatch ISS-5366 exists to prevent.
 */
const displayedStatusMemo = new WeakMap<object, string>();

/**
 * The memoized {@link resolveDisplayedStatus} used by the Status AND (since
 * ISS-6270) the Duration comparator.
 *
 * The `?? UNKNOWN` covers the statusless shape {@link DurationSortCandidate}
 * admits and `displaySortCandidateSelect` cannot produce: a row this server has
 * no status for is displayed as Unknown, which is the same answer the shared
 * fold gives every value it cannot read, rather than a rank borrowed from a
 * state we have no evidence of.
 */
function displayedStatusSortKey(candidate: DisplaySortCandidate): string {
  return memoizedSortKey(
    displayedStatusMemo,
    candidate,
    (row) =>
      resolveDisplayedStatus(row, new Date()) ??
      DISPLAYED_SESSION_STATUS.UNKNOWN
  );
}

/** Memo of a candidate's resolved record-mutation sort key (ISS-6051). */
const recordUpdatedAtKeyMemo = new WeakMap<object, number | null>();

/**
 * The memoized {@link resolveRecordUpdatedAt} used by the comparator, as epoch
 * milliseconds — `null` when neither `@updatedAt` column is present, so the
 * unresolvable case collects last through {@link compareNullsLast} exactly as
 * the hand-rolled null branch it replaced did.
 */
function recordUpdatedAtSortKey(
  candidate: DisplaySortCandidate
): number | null {
  return memoizedSortKey(
    recordUpdatedAtKeyMemo,
    candidate,
    (row) => resolveRecordUpdatedAt(row)?.getTime() ?? null
  );
}

/**
 * @file session-timestamp-form.ts
 * @description The single source of truth for what a session timestamp's TEXT
 * FORM means, as matched SQL/JS pairs: the `started_at` floor expression and the
 * canonical UTC form, each spelled once for SQL and once for JS.
 *
 * These columns are TEXT, so every SQL comparison over them — a `<` predicate,
 * SQLite's SCALAR `max(a, b)` — is BYTE-WISE, and byte order is only time order
 * for a fixed-width canonical value. Every guard in the store therefore has to
 * agree on the same two definitions, and several of them (the sweep in
 * session-maintenance.ts, the heals in token-cost-maintenance.ts and
 * timestamp-format-maintenance.ts) need the SQL and the JS spelling of the SAME
 * predicate. Keeping the pairs adjacent in one leaf module is what stops them
 * drifting; that is why this is a module and not four constants scattered
 * across their consumers.
 *
 * ISS-5497 added the third member of the same family: the CANONICALIZING SQL
 * (`canonicalizeHealableTimestampSql`) that re-expresses a stored value as that
 * canonical form so a comparison over mixed forms is chronological rather than
 * byte-wise, plus the one value expression built from all three —
 * {@link SESSION_LAST_ACTIVITY_AT_VALUE_SQL}. It also moved the FEA-3743 heal's
 * two discovery globs here, because that heal and this canonicalization must
 * rewrite the SAME set of shapes or the two fight over `last_activity_at`.
 *
 * ISS-7579 added the fourth member, and the first with no JS mirror:
 * {@link storedUtcDaySql}, the stored UTC DAY bucket. It belongs here because it
 * is built from the same {@link ISO_DATE_PREFIX_GLOB_SQL} the floor uses, and
 * because its three former copies had no owner to be found at.
 *
 * Extracted from write-core.ts (ISS-5429, and the recompute's value expression
 * on ISS-5497) — this is a cohesive unit lifted out whole, not a line-count
 * slice. Imports nothing, so it can be
 * pulled in from anywhere in the DB layer without risking a cycle.
 */

// FEA-3591 floor: the GLOB-guarded started_at (epoch for legacy/malformed
// values). ISO-8601 UTC strings sort lexicographically, so string MAX ==
// chronological max. Single source of truth for the floor value — referenced
// as the MAX floor arg and the COALESCE fallback in the recompute (so the two
// can never drift) AND by the heal's discovery predicate (so discovery and
// repair agree on what "violating" means). Mirrors SESSION_STARTED_AT_TS_EXPR
// (sync-source.ts) but unqualified, since these run against `sessions` without
// an alias.
/**
 * The epoch literal the timestamp floors fall back to, and the schema DEFAULT on
 * `sessions.last_activity_at`.
 *
 * ISS-8601 exported it: the session INSERT omits `last_activity_at` (the value is
 * recomputed by a LATER write-queue group), so a row carries this default while
 * its import is still in flight. Any consumer that reads the column as evidence
 * of ACTIVITY has to be able to tell the default apart from a real timestamp.
 */
export const SESSION_TIMESTAMP_EPOCH = "1970-01-01T00:00:00.000Z";
const SESSION_STARTED_AT_EPOCH = SESSION_TIMESTAMP_EPOCH;

// The DATE-SHAPED guard both timestamp families use: a value carrying a leading
// `YYYY-MM-DD`. Spelled once because the floor and the `events.created_at` fold
// mean the SAME thing by it — reject a value with no date at all, which SQLite
// would otherwise read as a time-of-day on 2000-01-01 — and a drift between them
// would silently admit a value on one side of the comparison but not the other.
// Exported since ISS-5497 (review) for the pre-sweep heal's discovery pre-gate
// (token-cost-maintenance.ts), which has to ask the fold's own question — "is
// this event date-shaped at all?" — about the same rows the fold reads.
export const ISO_DATE_PREFIX_GLOB_SQL =
  "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'";

// ISS-5497: the two shapes the FEA-3743 heal REWRITES — a `T`-form timestamp,
// and the EXACT 10-character date-only value. Spelled here, in the module that
// owns what a timestamp's text form means, and imported by the heal's discovery
// predicate (timestamp-format-maintenance.ts) so the heal and the recompute
// cannot disagree about which values get canonicalized. They must not: the
// recompute writes `last_activity_at` and the heal rewrites it, so a shape one
// canonicalizes and the other does not ping-pongs forever, bumping `updated_at`
// and re-syncing an alternating instant on every boot.
//
// Deliberately NOT the open `YYYY-MM-DD*` the floor uses, which would also admit
// the SQLite space form `2026-06-22 10:00:00` — see the heal's own note on why
// that shape is held back rather than moved.
export const HEALABLE_TIMESTAMP_T_FORM_GLOB_SQL =
  "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'";

export const HEALABLE_TIMESTAMP_DATE_ONLY_GLOB_SQL =
  "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'";

// ISS-5497 (review): the one out-of-range field SQLite ACCEPTS — an hour of
// exactly `24`. Its date parser admits `0 <= hour <= 24`, and for a value with
// no zone or a `Z` one it re-emits the parsed fields VERBATIM rather than
// rolling them into the next day, so `2026-06-22T24:30:00Z` canonicalizes to
// `2026-06-22T24:30:00.000Z` — text that MATCHES the canonical glob, so no heal
// ever revisits it, yet sorts BELOW a genuinely earlier `2026-06-23T00:15…` and
// would move the retention cutoff BACKWARD. Every other out-of-range field
// (hour >= 25, minute or second >= 60, month 13) already yields NULL and falls
// to legacy mode on its own, and an out-of-range calendar DATE (`2026-06-31`)
// rolls over exactly as `Date.parse` rolls it, so this is the whole residue.
// Measured on the bundled engine under `TZ` = UTC and `America/Chicago`.
//
// Rejected into legacy mode rather than repaired: the FEA-3743 heal declines the
// shape too (`Date.parse('…T24:30:00Z')` is NaN), so legacy mode is both what
// every release before this one did with it and the only reading the two passes
// agree on. `T24:00` is the near-miss — `Date.parse` DOES accept it — and it is
// rejected with the rest rather than special-cased, because a one-shape carve-out
// would put this expression's accepted set out of step with the glob above for a
// value no harness emits.
const RANGE_INVALID_HOUR_GLOB_SQL =
  "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T24:*'";

export const SESSION_STARTED_AT_FLOOR_SQL = `CASE WHEN started_at GLOB ${ISO_DATE_PREFIX_GLOB_SQL} THEN started_at ELSE '${SESSION_STARTED_AT_EPOCH}' END`;

// ISS-5182 / ISS-5330: the CANONICAL UTC timestamp form — the FIXED-WIDTH
// `YYYY-MM-DDTHH:mm:ss.sssZ` (24 chars) `Date#toISOString` emits and the
// FEA-3743 timestamp-format heal rewrites stored text into. Only a FIXED width
// makes byte order time order: a legacy offset form breaks it one way
// (`2026-06-22T07:00:00-05:00` is 12:00Z yet sorts BELOW
// `2026-06-22T10:00:00Z`) and MIXED PRECISION the other (`…:00Z` beats
// `…:00.500Z` because `Z` 0x5A sorts after `.` 0x2E, so MAX returns the EARLIER
// instant — ISS-5330, whitlockk). Declared as a matched pair (SQL glob + JS mirror)
// so the two spellings cannot drift: the SQL side guards the FEA-3743 heal's
// discovery predicates (token-cost-maintenance.ts) and its own candidate
// predicate (timestamp-format-maintenance.ts); the JS side guards the ISS-5182
// stale-session sweep (session-maintenance.ts). Tightening strands nothing — a
// whole-second 'Z' row is no longer canonical, so the heal now rewrites it.
export const CANONICAL_UTC_TIMESTAMP_GLOB_SQL =
  "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'";

const CANONICAL_UTC_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const ISO_DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}/;

export function isCanonicalUtcTimestamp(value: string | null): boolean {
  return value !== null && CANONICAL_UTC_TIMESTAMP_RE.test(value);
}

/**
 * ISS-5429: the JS mirror of {@link SESSION_STARTED_AT_FLOOR_SQL} — what that
 * CASE evaluates to for a given stored `started_at`, computed in JS.
 *
 * The stale sweep has to decide, BEFORE issuing the UPDATE, whether the floor's
 * VALUE is safe to compare byte-wise against `last_activity_at`. Reading the
 * raw column is not the same question: a `started_at` the floor rejects (NULL,
 * or any value the date-prefix GLOB does not match) never reaches the
 * comparison at all — the canonical 1970 literal does. Built from the same
 * epoch constant as the SQL so the two cannot drift.
 */
export function sessionStartedAtFloor(startedAt: string | null): string {
  return startedAt !== null && ISO_DATE_PREFIX_RE.test(startedAt)
    ? startedAt
    : SESSION_STARTED_AT_EPOCH;
}

// ISS-5497: the `strftime` format that emits EXACTLY the canonical form
// `CANONICAL_UTC_TIMESTAMP_GLOB_SQL` pins — `%f` is `SS.sss`, so the output is
// the fixed-width `YYYY-MM-DDTHH:mm:ss.sssZ`. Declared next to that glob for the
// same reason the glob/regex pair is: the producer and the guard must agree.
const CANONICAL_UTC_STRFTIME_FORMAT = "%Y-%m-%dT%H:%M:%fZ";

/**
 * ISS-5497: re-expresses a stored timestamp as the CANONICAL UTC form without
 * leaving SQLite — the SQL counterpart of `toCanonicalIso` (db-helpers.ts), and
 * what lets a comparison over these TEXT columns be chronological rather than
 * byte-wise: SQLite applies the offset while parsing, so an offset form and a
 * `Z` form of the same instant emit the SAME 24 bytes, and byte order over the
 * results IS time order.
 *
 * This is SQLite's DEFAULT parse, with no `utc` modifier, for every shape it is
 * applied to. The modifier reads a value as LOCAL time and converts, which is
 * wrong here twice over. Measured on the bundled engine under `TZ` = UTC and
 * `America/Chicago`:
 *
 *  - ISS-5496 settled that a stored ZONE-LESS date-time is read as UTC, which is
 *    what the default parse does and what `canonicalizeStoredTimestamp` (the
 *    FEA-3743 heal, timestamp-format-maintenance.ts) now does by supplying the
 *    missing `Z` before `Date.parse`. It is also what SQLite's `unixepoch()` in
 *    local-insights.ts and every lexical comparison over these TEXT columns
 *    already assume. The `utc` modifier instead shifts such a value by the
 *    operator's offset — `…T10:00:00` becomes `…T15:00:00.000Z` on a Chicago box
 *    — so the recompute and the heal would disagree about the same stored text,
 *    and since one runs on every hook event and the other on every boot,
 *    `last_activity_at` would ping-pong forever, bumping `updated_at` and
 *    re-syncing the alternation each time.
 *  - It also SILENTLY BAILS on an out-of-range calendar date: with the modifier
 *    `2026-06-31T10:00:00Z` comes back as `2026-06-31T10:00:00.000Z`, the
 *    invalid date re-emitted in canonical SHAPE, where the default parse rolls
 *    it to `2026-07-01T10:00:00.000Z` exactly as `Date.parse` does.
 *
 * Yields NULL for a value SQLite cannot parse, so every caller MUST supply its
 * own fallback rather than let a NULL reach a NOT NULL column.
 */
function canonicalUtcTimestampSql(timestampExpr: string): string {
  return `strftime('${CANONICAL_UTC_STRFTIME_FORMAT}', ${timestampExpr})`;
}

/**
 * ISS-5497 (review): canonicalizes EXACTLY the shapes the FEA-3743 heal rewrites
 * — reading each one the way that heal's `toCanonicalIso` reads it — and yields
 * NULL for anything else, which is the signal the caller switches modes on.
 *
 * Matching the heal's set is the whole point, not a nicety. The value this feeds
 * is written to `sessions.last_activity_at` on every live hook event and every
 * import, and the heal rewrites that same column on every boot; a shape one
 * canonicalizes and the other does not PING-PONGS forever, bumping `updated_at`
 * and re-syncing an alternating instant. Every arm below was measured against
 * the bundled engine and V8 under `TZ` = UTC, `Asia/Kolkata` and
 * `America/Chicago`, on in-range AND out-of-range calendar dates:
 *
 *  - Already canonical — passed through untouched, which is also the cheap path
 *    for the overwhelmingly common row.
 *  - Any `T`-form (`…T10:00:00Z`, `…+05:30`, and the zone-less `…T10:00:00`) —
 *    the DEFAULT parse, one arm for all three. ISS-5496 made the zone-less shape
 *    read as UTC in the heal too, which is exactly what the default parse does;
 *    see {@link canonicalUtcTimestampSql} for why the `utc` modifier is wrong on
 *    both that shape and an out-of-range date.
 *  - EXACT date-only (`2026-06-22`) — the same DEFAULT parse; `Date.parse` reads
 *    it as UTC midnight, and so does SQLite.
 *  - An hour of `24` — NULL, the one out-of-range field SQLite accepts and
 *    re-emits verbatim. See {@link RANGE_INVALID_HOUR_GLOB_SQL}.
 *  - The SQLite space form (`2026-06-22 10:00:00`) — NULL. The heal deliberately
 *    holds this shape back rather than move it by the operator's offset, so the
 *    fixed point is the stored text and canonicalizing it would be this
 *    expression doing what that heal refuses to.
 *  - The BASIC-format offset `2026-06-22T10:00:00.000+0530` — NULL, because
 *    SQLite cannot parse it even though V8 can. Reproducing V8's lenient
 *    non-spec parsing in SQL is not worth it.
 *
 * KNOWN RESIDUAL — the NULL arms are where this and the heal still disagree.
 * `toCanonicalIso` accepts the basic-format offset and `…T24:00`, and the heal
 * rewrites any `T`-form value, so a session that falls to legacy mode still
 * ping-pongs with the heal whenever its byte-wise winner is one of those
 * healable shapes: heal → canonical, recompute → raw, forever, with an
 * `updated_at` bump and a cloud re-sync each boot. That is exactly `main`'s
 * behavior, so nothing regresses — ISS-5497 NARROWS this ping-pong to sessions
 * holding an un-canonicalizable event rather than every session with any
 * non-canonical one. Closing it means teaching this SQL those spellings or
 * teaching the heal to decline them; both are their own change, and neither is
 * safe to fold into a fix for the byte-wise fold.
 *
 * `timestampExpr` reaches the emitted SQL six times (five literally, once more
 * through {@link canonicalUtcTimestampSql}), so pass a column reference or a
 * cheap deterministic expression — never a subquery.
 *
 * Exported since ISS-6414 for the `getSkills` fold (dashboard-skill-sql.ts),
 * which folds `events.created_at` and needs the same two-mode discipline. That
 * read has no heal to stay in step with — `events.created_at` is outside
 * `HEALED_COLUMNS` — but it does need the accepted set to agree with the
 * `Date.parse` its JS consumer re-sorts on, which is what this expression's
 * glob arms buy.
 */
export function canonicalizeHealableTimestampSql(
  timestampExpr: string
): string {
  return `CASE
      WHEN ${timestampExpr} GLOB ${RANGE_INVALID_HOUR_GLOB_SQL}
        THEN NULL
      WHEN ${timestampExpr} GLOB ${CANONICAL_UTC_TIMESTAMP_GLOB_SQL}
        THEN ${timestampExpr}
      WHEN ${timestampExpr} GLOB ${HEALABLE_TIMESTAMP_T_FORM_GLOB_SQL}
        OR ${timestampExpr} GLOB ${HEALABLE_TIMESTAMP_DATE_ONLY_GLOB_SQL}
        THEN ${canonicalUtcTimestampSql(timestampExpr)}
    END`;
}

// ISS-5497: {@link SESSION_STARTED_AT_FLOOR_SQL} in canonical form — NULL when
// the stored `started_at` is one of the shapes above that cannot be
// canonicalized, which propagates through the scalar `MAX` (SQLite returns NULL
// if ANY argument is NULL) and drops the whole expression into legacy mode.
// A `started_at` the floor's GLOB rejects takes the epoch literal, which is
// already canonical.
//
// ISS-6893: UNQUALIFIED, exactly like the floor it canonicalizes, so inside an
// `UPDATE agents` it resolves to the AGENT's own start. That is why the agent
// value expression below reuses it rather than spelling a second one — the same
// reason `session-maintenance.ts` aliases the raw floor instead of re-spelling
// it. `events` has no `started_at` column, so the reference cannot be shadowed
// by the fold's derived table either.
const CANONICAL_STARTED_AT_FLOOR_SQL = `CASE WHEN started_at GLOB ${ISO_DATE_PREFIX_GLOB_SQL} THEN ${canonicalizeHealableTimestampSql("started_at")} ELSE '${SESSION_STARTED_AT_EPOCH}' END`;

// The date-shaped `events.created_at` values for one owner — the rows that
// count as an activity timestamp at all.
const EVENT_IS_DATE_SHAPED_SQL = `e.created_at GLOB ${ISO_DATE_PREFIX_GLOB_SQL}`;

/**
 * ISS-6893: which `events` rows belong to the row being updated. The ONLY thing
 * that differs between the session fold and the agent fold, so it is the only
 * thing parameterized — everything else (the two modes, the all-or-nothing
 * canonicalization guard, the floor, the legacy fallback) is shared by
 * construction rather than by copy.
 */
const SESSION_EVENT_SCOPE_SQL = "e.session_id = sessions.id";

const AGENT_EVENT_SCOPE_SQL = "e.agent_id = agents.id";

/**
 * ISS-5497 (review): the event fold in CANONICAL mode — the latest instant among
 * the session's events, as canonical text — or NULL if even ONE date-shaped
 * event cannot be canonicalized.
 *
 * The all-or-nothing guard is the load-bearing part, and it is not conservatism.
 * Canonicalizing LOWERS a value's text whenever it applies a positive offset, so
 * mixing canonical and raw operands in one byte-wise `MAX` lets an
 * un-canonicalizable sibling out-sort the true winner. Measured against the real
 * store: events `2026-06-22T23:00:00+05:00` (18:00Z) and
 * `2026-06-22T21:00:00.000+0530` (15:30Z, which SQLite cannot parse) fold to
 * 18:00Z on `main` but would fold to 15:30Z if the first were canonicalized
 * while the second stayed raw — a 2.5h BACKWARD move of the cutoff
 * `sweepExpiredSessions` purges a terminal session and all of its child rows on,
 * IRREVERSIBLY, and re-derived corpus-wide by the DATA_REVISION bump.
 *
 * So the two modes are never mixed. Either every operand canonicalizes and the
 * comparison is exact, or this yields NULL and the caller falls back to the
 * PRE-ISS-5497 expression verbatim — which cannot regress anything, because it
 * is what shipped. An event-less session yields the floor, matching the
 * legacy-mode COALESCE arm.
 *
 * The derived table exists so `canonicalizeHealableTimestampSql` is evaluated
 * ONCE per row rather than once for the all-canonical test and again for the
 * fold. `COUNT(canonical) = COUNT(*)` is that test — `COUNT(expr)` skips NULLs —
 * and the date-shaped filter moved into the WHERE, so a non-date-shaped row
 * costs one GLOB and is never canonicalized at all. This statement runs inside
 * the ingest transaction on the serialized write queue for every live hook event
 * and every import, so the duplication was not free.
 */
function canonicalEventFoldSql(eventScopeSql: string): string {
  return `(
      SELECT CASE
        WHEN COUNT(*) = 0 THEN ${CANONICAL_STARTED_AT_FLOOR_SQL}
        WHEN COUNT(canonical) = COUNT(*) THEN MAX(canonical)
      END
      FROM (
        SELECT ${canonicalizeHealableTimestampSql("e.created_at")} AS canonical
        FROM events e
        WHERE ${eventScopeSql}
          AND ${EVENT_IS_DATE_SHAPED_SQL}
      )
    )`;
}

// The PRE-ISS-5497 expression, verbatim: a byte-wise `MAX` over the raw stored
// text, floored at the raw `started_at`. Reached only when something in the
// session cannot be canonicalized, so the worst case of this change is exactly
// the behavior that shipped before it. Evaluated lazily — SQLite's `COALESCE`
// short-circuits, so this subquery does not run in the common case.
//
// KNOWN COST, accepted: a session that DOES fall here scans `events` twice — the
// canonical fold runs, yields NULL, and is discarded, then this rescans. Folding
// both into one pass is possible but needs the empty-events and floor arms
// duplicated per mode inside a single subquery, and this expression sits on the
// irreversible retention-purge path where the two modes being separately
// readable is worth more than a second scan of one session's events. The path is
// rare by construction: it needs an event whose stored text is the SQLite space
// form or a basic-format offset.
function legacyEventFoldValueSql(eventScopeSql: string): string {
  return `MAX(
    ${SESSION_STARTED_AT_FLOOR_SQL},
    COALESCE(
      (
        SELECT MAX(CASE WHEN ${EVENT_IS_DATE_SHAPED_SQL} THEN e.created_at END)
        FROM events e
        WHERE ${eventScopeSql}
      ),
      ${SESSION_STARTED_AT_FLOOR_SQL}
    )
  )`;
}

/**
 * The value `recomputeSessionLastActivityAt` (write-core.ts) assigns to
 * `sessions.last_activity_at` — the denormalized cursor sort key — recomputed
 * from the session's current `events` / `started_at` rows. Unqualified, so it
 * runs against `sessions` without an alias.
 *
 * FEA-3591 floor: the value is `MAX(started_at floor, MAX(events.created_at))`
 * rather than the bare event max, because the denormalized value must satisfy
 * the `last_activity_at >= started_at` invariant the cloud read path documents
 * on `SessionDetail.lastActivityAt`. Without the floor, a resumed/continued run
 * whose events carry `created_at` timestamps from the PARENT transcript (before
 * this session's resume `started_at`) landed last activity hours *before* the
 * session started, and FEA-3580 derives the sweep's `ended_at` FROM this value,
 * so the floor is also what keeps duration non-negative.
 *
 * ISS-5497 canonicalization: every operand is canonicalized BEFORE the fold,
 * rather than the fold running over raw stored text. Two distinct defects fell
 * out of not doing that:
 *
 *  - `MAX(e.created_at)` was a BYTE comparison over a column that holds mixed
 *    forms, so it could return the EARLIER instant — verified in SQLite, where
 *    `MAX` over `…T10:00:00Z` / `…T10:00:00.500Z` returns the whole-second value
 *    (`Z` 0x5A sorts after `.` 0x2E). Canonicalizing first makes the operands
 *    fixed-width, where byte order IS time order, so the winner is the genuine
 *    latest instant.
 *  - The winning RAW text was then copied straight into `last_activity_at`,
 *    which IS in the FEA-3743 heal's `HEALED_COLUMNS`. Since this recompute runs
 *    on every live hook event and every import, it re-introduced non-canonical
 *    text into the column the heal had just canonicalized — so the heal was not
 *    convergent for any active session, and the stale sweep's canonical-only
 *    guard could hold such a session back indefinitely (the recurring `heldBack`
 *    condition ISS-5429 added reporting for). Emitting text the heal agrees with
 *    makes the recompute a FIXED POINT of it instead of its adversary, which is
 *    also why `events.created_at` need not join `HEALED_COLUMNS`.
 *
 *    That fixed point holds for every shape SQLite can canonicalize, which is
 *    all of them EXCEPT the basic-format offset and the `T24:` hour — see the
 *    KNOWN RESIDUAL on {@link canonicalizeHealableTimestampSql}. A session
 *    holding one of those falls to legacy mode and keeps ping-ponging with the
 *    heal exactly as it does on `main`; the residual is narrowed, not closed.
 *
 * TWO MODES, never mixed. The canonical arm applies only when the `started_at`
 * floor AND every date-shaped event canonicalize; otherwise the whole expression
 * falls back to {@link legacyEventFoldValueSql}, the pre-ISS-5497
 * text verbatim. Mixing them is not merely imprecise, it REGRESSES: canonicalizing
 * lowers a value's text whenever it applies a positive offset, so a canonicalized
 * true winner can sort below an un-canonicalizable sibling and move
 * `last_activity_at` BACKWARD past where `main` put it — into range of the
 * irreversible retention purge. See the fold's own note for the measured case.
 * The NULL propagates for free: SQLite's scalar `MAX` returns NULL if ANY
 * argument is NULL, and `COALESCE` short-circuits, so the legacy subquery is not
 * even evaluated in the common case.
 *
 * So the guarantee is: a session whose timestamps all canonicalize — the whole
 * corpus after a successful format-heal boot, and every layer2 golden — gets an
 * exact instant comparison and canonical output; any other session behaves
 * EXACTLY as it did before this change, which is the only claim a change to this
 * column can safely make.
 */
/**
 * ISS-5497 (review): the CANONICAL arm of {@link SESSION_LAST_ACTIVITY_AT_VALUE_SQL}
 * on its own — the exact instant comparison, or NULL when any operand cannot be
 * canonicalized and the value expression falls back to legacy mode.
 *
 * Exported because the pre-sweep heal (`healSessionLastActivityAtFloor`,
 * token-cost-maintenance.ts) has to discover the rows THIS ticket corrects
 * WITHOUT reaching into the legacy ones. In legacy mode the fold is `main`'s
 * verbatim, so there is nothing new to heal there — and healing on a comparison
 * against it would be a byte-wise judgement over mixed forms, which is exactly
 * the unsoundness the heal's own FEA-3743 guard exists to avoid. That heal spells
 * both the mode test and the exact test as one
 * `COALESCE(<this>, last_activity_at) IS NOT last_activity_at`, so this
 * subquery-bearing expression is evaluated once per row rather than twice.
 */
export const SESSION_CANONICAL_LAST_ACTIVITY_AT_SQL =
  canonicalEventFoldValueSql(SESSION_EVENT_SCOPE_SQL);

export const SESSION_LAST_ACTIVITY_AT_VALUE_SQL = `COALESCE(
  ${SESSION_CANONICAL_LAST_ACTIVITY_AT_SQL},
  ${legacyEventFoldValueSql(SESSION_EVENT_SCOPE_SQL)}
)`;

/**
 * ISS-6893: the same two-mode value expression, scoped to ONE AGENT's events —
 * what the stale sweep assigns to `agents.ended_at` (session-maintenance.ts).
 *
 * The agent arm of that sweep shipped as the pre-ISS-5497 byte-wise fold, and
 * `session-maintenance.ts` documented the gap in place: `events.created_at` is
 * raw harness transcript text and the one timestamp column the FEA-3743 heal
 * never repairs, so a byte-wise `MAX()` over it returns the EARLIER instant on a
 * mixed-precision or offset-form column, and `hasCanonicalTimestampForm` does
 * NOT cover it — that guard gates only the SESSION columns the heal repairs.
 * A too-early `ended_at` SHORTENS the derived agent duration (the subagent-type
 * `avg_duration` in local-insights.ts, `durationMs` in agent-tree-utils.ts) and
 * is exported to the cloud verbatim from the column (sync-source.ts), so the
 * drift is persisted and replicated, not merely rendered.
 *
 * Built from the same two helpers as the session value above rather than a
 * second expression: the event-scope predicate is the only real difference
 * between the two folds, and a copy would be free to drift on the parts that
 * are load-bearing (the all-or-nothing canonicalization guard, the started_at
 * floor, the legacy fallback). Unqualified `started_at` resolves to the AGENT's
 * own start inside `UPDATE agents`, so the floor keeps `ended_at >= started_at`
 * for the agent exactly as it does for the session (ISS-5182).
 *
 * Same two-mode guarantee, so the same safety claim: an agent whose own
 * `started_at` and every date-shaped event of its own canonicalize gets an exact
 * instant comparison and canonical output; ANY other agent falls to the
 * pre-ISS-5497 expression verbatim and behaves exactly as it did before.
 */
/**
 * ISS-7069: the CANONICAL arm of {@link AGENT_ENDED_AT_VALUE_SQL} on its own —
 * the agent twin of {@link SESSION_CANONICAL_LAST_ACTIVITY_AT_SQL}, and factored
 * out for the same reason that one was.
 *
 * The ISS-6893 backfill (`agent-ended-at-heal.ts`) has to DISCOVER the agents
 * that ticket corrects without reaching into the legacy ones. In legacy mode the
 * fold is `main`'s verbatim, so there is nothing to repair there — and judging a
 * row by comparing against it would be the byte-wise comparison over mixed forms
 * that produced the defect in the first place. NULL here says "this agent is in
 * legacy mode", which is the discovery test, and a non-NULL value is canonical
 * fixed-width UTC, which is what makes the heal's comparison sound.
 *
 * Deliberately the arm, not a second expression: {@link AGENT_ENDED_AT_VALUE_SQL}
 * is defined in terms of it below, so the heal's discovery and the sweep's write
 * cannot drift apart on the parts that are load-bearing (the all-or-nothing
 * canonicalization guard, the `started_at` floor).
 */
export const AGENT_CANONICAL_ENDED_AT_SQL = canonicalEventFoldValueSql(
  AGENT_EVENT_SCOPE_SQL
);

export const AGENT_ENDED_AT_VALUE_SQL = `COALESCE(
  ${AGENT_CANONICAL_ENDED_AT_SQL},
  ${legacyEventFoldValueSql(AGENT_EVENT_SCOPE_SQL)}
)`;

/**
 * The CANONICAL arm on its own: the canonicalized `started_at` floor and the
 * canonical event fold, or NULL when either cannot be canonicalized.
 */
function canonicalEventFoldValueSql(eventScopeSql: string): string {
  return `MAX(
    ${CANONICAL_STARTED_AT_FLOOR_SQL},
    ${canonicalEventFoldSql(eventScopeSql)}
  )`;
}

/**
 * ISS-6906: whether a stored value denotes a REAL INSTANT — the VALUE half of a
 * readability test, to be ANDed with the shape half.
 *
 * {@link CANONICAL_UTC_TIMESTAMP_GLOB_SQL} pins the fixed WIDTH that makes byte
 * order time order, and says nothing about the value, because every field in it
 * is a bare `[0-9]` class: `2025-13-01T00:00:00.000Z` is canonical by that glob
 * and is not a date. Shape alone is therefore the wrong readability test for any
 * pass that goes on to SHIP the value — `Date.parse` is non-finite for it, so
 * the cloud's `isoDateSchema` rejects whatever payload it rides in.
 *
 * Deliberately the value half ONLY, rather than a single predicate that also
 * spells the glob. `no-lexical-timestamp-compare` requires the canonical GLOB to
 * be visible against each operand in the statement that compares them, and
 * folding it in here would hide it from that gate — trading a live check for a
 * suppression. Callers keep the glob and add this.
 *
 * The accepted set is built to agree with `Date.parse`, the consumer that
 * actually adjudicates these values. Measured on the bundled engine, `strftime`
 * returns NULL for exactly the fields V8 rejects — month 0 or 13, day 0, minute
 * 60, second 60 — and both engines ROLL an out-of-range day over identically
 * (`2026-06-31` → July 1 in each), so a rollover value is a real instant to both
 * and is admitted. The single disagreement is an hour of `24`, which SQLite
 * re-emits verbatim while `Date.parse` refuses; that is exactly the residue
 * {@link RANGE_INVALID_HOUR_GLOB_SQL} already exists to name, so it is spelled
 * here rather than discovered again.
 *
 * `timestampExpr` reaches the emitted SQL twice, so pass a column reference or a
 * cheap deterministic expression — never a subquery.
 */
export function isRealInstantSql(timestampExpr: string): string {
  return `${timestampExpr} NOT GLOB ${RANGE_INVALID_HOUR_GLOB_SQL}
            AND ${canonicalUtcTimestampSql(timestampExpr)} IS NOT NULL`;
}

/**
 * ISS-6815: the ranking key for a grouped `MAX`/`MIN` over one of these TEXT
 * columns — canonical for EVERY row in the group, or raw for every row in it,
 * never a mix.
 *
 * ISS-5497's two-mode rule is what makes that all-or-nothing shape load-bearing
 * rather than conservative, and both ways of half-applying it move a value
 * BACKWARD past where the unfixed query puts it. Mixing a canonical operand with
 * a raw one loses a true winner that canonicalization LOWERED (applying a
 * positive offset does), and dropping the un-canonicalizable operand is the same
 * defect from the other side — the row it drops is exactly the one that could
 * have won. So the window `COUNT`s compare how many rows in the partition
 * canonicalize against how many hold a value at all, and a single dissenter
 * drops the whole group back to the raw column verbatim, which cannot regress
 * anything because it is what shipped.
 *
 * Both column arguments must already be materialized by an inner select — pass
 * column REFERENCES, not expressions. {@link canonicalizeHealableTimestampSql}
 * repeats its argument six times and each name here reaches the emitted SQL
 * twice, so inlining the canonicalization would expand it twelve-fold and
 * re-evaluate it per window.
 *
 * `windowSpecSql` is the window body, and it must match the set the reader
 * actually COMPARES across — which is not always its `GROUP BY`. When each group
 * yields a value from WITHIN itself (`MAX` projected, or a bare column beside it)
 * the comparison never leaves the group, so partition BY the grouping key:
 * `PARTITION BY tool_name` beside `GROUP BY tool_name`. When the reader's answer
 * IS the comparison BETWEEN groups — an `ORDER BY MAX(sort)` whose ranking is the
 * output — the compared set is every group at once, so the spec is EMPTY even
 * though the query groups. Getting that wrong reintroduces the exact mix this
 * exists to prevent: a canonicalized key from one group ranked against a raw key
 * from another orders WORSE than the unfixed query, because canonicalizing an
 * offset form LOWERS its text.
 *
 * ISS-6414 (`SKILL_SUMMARY_SQL`, dashboard-skill-sql.ts) is the first consumer;
 * this is that expression lifted out whole so the sweep's remaining sites cannot
 * drift from it.
 */
export function allOrNothingCanonicalSortSql(
  canonicalColumn: string,
  rawColumn: string,
  windowSpecSql: string
): string {
  return `CASE
        WHEN COUNT(${canonicalColumn}) OVER (${windowSpecSql})
           = COUNT(${rawColumn}) OVER (${windowSpecSql})
          THEN ${canonicalColumn}
        ELSE ${rawColumn}
      END`;
}

/**
 * ISS-6815 (review): {@link canonicalizeHealableTimestampSql} for a RANKING key
 * — canonical text only when the value is also a real instant.
 *
 * That expression's canonical arm is a SHAPE test and nothing more: every field
 * in {@link CANONICAL_UTC_TIMESTAMP_GLOB_SQL} is a bare `[0-9]` class, so
 * `2025-13-01T00:00:00.000Z` passes through untouched and counts as canonical in
 * the {@link allOrNothingCanonicalSortSql} fold. It then WINS that fold — month
 * 13 sorts above every real month — and, because the fold saw no dissenter, it
 * beats a valid offset form that canonicalization LOWERED. Adding the value half
 * ({@link isRealInstantSql}) drops the group to the raw column instead, which is
 * exactly what shipped for such a row.
 *
 * Composed rather than folded into the inner expression: that one's accepted set
 * has to keep matching the FEA-3743 heal's, or `sessions.last_activity_at`
 * ping-pongs every boot, and it is also read by callers that are not ranking
 * anything. This gate only ever REMOVES values from the canonical set — every
 * shape the inner expression CONVERTS goes through `strftime`, so it already
 * satisfies the value check, and the shapes it declines are NULL either way.
 *
 * `timestampExpr` reaches the emitted SQL eight times, so pass a column
 * reference or a cheap deterministic expression — never a subquery.
 */
export function canonicalRankingKeySql(timestampExpr: string): string {
  return `CASE
      WHEN (${isRealInstantSql(timestampExpr)})
        THEN ${canonicalizeHealableTimestampSql(timestampExpr)}
    END`;
}

/**
 * ISS-7579: the stored UTC DAY bucket — the `YYYY-MM-DD` prefix of a stored
 * timestamp, or NULL when the value is not date-shaped.
 *
 * The single owner. `component-session-usage-rollup.ts` imports it rather than
 * accepting it as a parameter, deliberately: an injected expression is a seam
 * every caller can diverge through, and three had.
 *
 * Guarded by {@link ISO_DATE_PREFIX_GLOB_SQL} rather than the fixed-width
 * canonical glob: this is the DATE-shaped question, not the comparability one.
 * A value with no leading date would otherwise `substr` to a meaningless
 * 10 characters, where NULL is the honest answer.
 *
 * FEA-2430 / ISS-6760 — the terms every copy of this value inherits. They live
 * on the expression itself so a copy site can find them. `started_day` is a
 * stored UTC-day derivation: storage-only, with zero
 * DISPLAY readers. It must stay UTC — a stored LOCAL day goes stale when the
 * user changes timezone or DST shifts, forcing full-table rebuilds. Any DISPLAY
 * read must re-bucket from the raw timestamp with `strftime(…, 'localtime')`
 * (`localDay` in db-helpers.ts; see local-insights.ts's timezone contract),
 * never read the stored column.
 *
 * "Zero readers" is exact about DISPLAY, not about copies. THREE copies of this
 * UTC day exist, and ALL inherit the contract wholesale — storage-only, never a
 * cohort/group-by axis:
 *   1. `session_activity_metrics.started_day` (activity-metrics.ts), per
 *      session, local to this store. Its index was dropped (migration 0060) so
 *      the copy cannot read as a sanctioned UTC day axis.
 *   2. `agent_component_session_usage.started_day`, written by
 *      `component-session-usage-rollup.ts` from this helper. It is the copy that
 *      actually produced the FEA-2999 bug — a `GROUP BY started_day` there
 *      landed pull-in activity on the wrong calendar day for non-UTC users, and
 *      optimization-analytics-queries.ts had to be rewritten onto
 *      `localDay(s.started_at)`. It still carries `idx_acsu_day`: ISS-6760
 *      scoped its index drop to `session_activity_metrics` (the table it was
 *      raised against), so that index is a KNOWN outstanding one, not an
 *      endorsement. Treat it as ISS-6760 treats the one it dropped.
 *   3. `AgentSessionUsageRollup.startedDay` in the CLOUD — sync-source.ts
 *      uploads this column and apps/api persists it (persist-session-children
 *      .ts) and serves it (agent-sessions/service.ts). That copy is the one to
 *      watch: `localDay()` and local-insights.ts's timezone contract are
 *      desktop-local, so nothing cloud-side re-bucketing this value exists to
 *      catch a `GROUP BY started_day` there. A cloud day series must bucket from
 *      the session's own timestamp in the viewer's timezone, never here. It is
 *      also the one copy this helper cannot reach.
 * Any further copy inherits the same terms.
 *
 * `col` reaches the emitted SQL twice, so pass a column reference or a cheap
 * deterministic expression — never a subquery.
 */
export function storedUtcDaySql(col: string): string {
  return `CASE WHEN ${col} GLOB ${ISO_DATE_PREFIX_GLOB_SQL} THEN substr(${col}, 1, 10) ELSE NULL END`;
}

/**
 * ISS-11317: the JS mirror of a `MAX` over {@link allOrNothingCanonicalSortSql} —
 * the latest of a set of stored TEXT timestamps, as canonical text.
 *
 * `getPack` rolls its installs up in JS rather than in SQL, so the SQL helper cannot
 * reach it; without this it kept the byte-wise `.sort()` that `listPacks` just stopped
 * doing, and the same pack answered `…00Z` in the detail IPC and `…00.500Z` in the
 * list. Two readings of one column is the defect, not either reading.
 *
 * All-or-nothing for the same reason the SQL is, and the reason is not conservatism:
 * canonicalization LOWERS a value's text whenever it applies a positive offset, so a
 * set holding one value that cannot be read as an instant would let that value
 * out-sort a canonicalized true winner. One dissenter therefore drops the WHOLE set
 * back to the byte-wise maximum of the raw text — exactly what shipped, so the worst
 * case of this helper cannot regress anything.
 *
 * `Date.parse` is the value half {@link isRealInstantSql} is in SQL: it rejects the
 * shapes SQLite would admit but no clock can name (hour 24), which is what keeps such
 * a row from winning the canonical fold.
 */
export function allOrNothingLatestByInstant(
  values: readonly (string | null)[]
): string | null {
  const present = values.filter((value): value is string => value !== null);
  if (present.length === 0) {
    return null;
  }
  const instants = present.map((value) => Date.parse(value));
  if (instants.every((ms) => Number.isFinite(ms))) {
    return new Date(Math.max(...instants)).toISOString();
  }
  return present.reduce((latest, value) => (value > latest ? value : latest));
}

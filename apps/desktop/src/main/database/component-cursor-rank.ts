/**
 * @file component-cursor-rank.ts
 * @description The component sync lane's KEYSET RANKING KEY, as a matched
 * SQL/JS pair: {@link componentCursorCanonicalRankSql} and {@link componentCursorRank}.
 *
 * ISS-11327. `agent_components.last_seen_at` is TEXT, and the lane used to page
 * on the stored bytes — `COALESCE(last_seen_at,'') > $1`, ordered the same way,
 * against a cursor the lane persisted VERBATIM. Both sides agreeing on bytes is
 * self-consistent but it is NOT the contract the lane makes. The contract is
 * `advanceComponentCursor`'s own: "a row whose `last_seen_at` later ADVANCES past
 * this position is naturally re-selected (re-sync-on-change)". "Advances" is a
 * claim about INSTANTS, and byte order is instant order only for fixed-width
 * canonical text. A row re-stamped to a later instant in a spelling that sorts
 * LOWER — `2026-06-22T09:30:00-01:00` is 10:30Z yet sorts below
 * `2026-06-22T10:00:00Z` — satisfies neither keyset disjunct and is never
 * selected again. In a sync cursor that is silent, permanent data loss.
 *
 * So byte order here was an ACCIDENT, not a contract. Contrast
 * `component-tombstone.ts`'s `HIGHEST_ORDERING_KEY_SQL`, where byte order genuinely
 * IS the contract: that read derives a key that must OUT-SORT the lane's frontier,
 * so it has to speak whatever order the lane speaks. It is a consumer of this
 * order, not an independent choice — which is why ISS-11327 moves BOTH sides in one
 * commit, and why that floor now ranks through this same expression.
 *
 * WHY A PER-ROW FOLD RATHER THAN `allOrNothingCanonicalSortSql`. That helper exists
 * because mixing a canonicalized operand with a raw one inside an AGGREGATE can lose
 * a true winner — canonicalizing a positive offset LOWERS its text. There is no
 * winner to lose here: this is a TOTAL-ORDER WALK, and every row is visited exactly
 * once as long as the key is a deterministic, stable function of the stored value.
 * All-or-nothing would be actively worse: one unreadable row anywhere in the table
 * would drop the WHOLE table back to byte order, which is the defect this fixes,
 * reinstated by a single bad row.
 *
 * AN UNREADABLE VALUE RANKS FIRST, tied with NULL, rather than keeping its raw text.
 * Raw text can sort ABOVE every real instant (`banana` does), and a cursor parked
 * there can never come back to a canonical row — the same strand from the other
 * side. Ranking first cannot strand anything: the row is still walked exactly once,
 * and it re-enters the moment its value becomes readable. The value is not coerced
 * away silently — the lane reports a batch carrying one.
 *
 * KNOWN RESIDUAL, stated so the pair is not over-trusted: the two halves agree on the
 * grammar SQLite's date parser actually accepts (measured — `Z`, an EXTENDED
 * `±HH:MM` offset, or no zone at all, over `HH:MM`, `HH:MM:SS` and a fractional
 * second), and the JS half declines everything else so V8's lenient non-spec parsing
 * cannot admit a shape the SQL half calls unreadable. The BASIC-format offset
 * `…+0100` is the shape that motivates that gate: `strftime` returns NULL for it and
 * `Date.parse` does not. The MIRROR hazard is a value that is canonical in SHAPE and
 * impossible in VALUE (`…T10:60:00.000Z`), which is why the canonical fast path below
 * carries a value check rather than trusting the shape: shape alone would hand the
 * lane a watermark no real rank can exceed.
 * `component-cursor-instant-order.test.ts` holds the two halves to one fixture set so
 * the agreement is pinned rather than assumed.
 */

import { COMPONENT_CURSOR_RANK_FLOOR } from "../../shared/component-cursor-rank-floor.js";
import { readZoneLessAsUtc, toCanonicalIso, validIso } from "./db-helpers.js";
import {
  canonicalRankingKeySql,
  isCanonicalUtcTimestamp,
} from "./session-timestamp-form.js";

/** `YYYY-MM-DDT24:` — the one out-of-range field SQLite re-emits verbatim. */
const HOUR_24_RE = /^\d{4}-\d{2}-\d{2}T24:/;

/** The EXACT date-only shape `canonicalizeHealableTimestampSql` admits. */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The `T`-form grammar the SQL half's `strftime` actually accepts, measured on the
 * bundled engine: `HH:MM`, optional `:SS`, optional fractional second, and a zone
 * that is absent, `Z`, or an EXTENDED `±HH:MM`. Deliberately NOT the open
 * `YYYY-MM-DDT*` the SQL shape glob uses — that glob is followed by `strftime`,
 * which returns NULL for the rest, while V8 would parse some of them.
 */
const SQLITE_T_FORM_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/;

/**
 * The lane's ranking key for a stored `last_seen_at`, in SQL.
 *
 * `col` reaches the emitted SQL eight times through
 * {@link canonicalRankingKeySql}, so pass a column reference or a cheap
 * deterministic expression — never a subquery.
 *
 * `COALESCE(…, '')` rather than `COALESCE(…, col, '')`: see the file header on why
 * an unreadable value takes the floor instead of its own bytes. The empty string
 * also keeps the first-run position `('', '')` meaning exactly what it meant before.
 */
export function componentCursorCanonicalRankSql(col: string): string {
  return `COALESCE(${canonicalRankingKeySql(col)}, '${COMPONENT_CURSOR_RANK_FLOOR}')`;
}

/**
 * The JS mirror: what {@link componentCursorCanonicalRankSql} evaluates to for a given
 * stored value.
 *
 * Two callers, and neither is a row the SQL already ranked — the SQL owns every
 * row's key, and the lane carries that value through rather than recomputing it.
 * This half exists for the values SQL never sees: a DURABLE cursor an already-
 * installed build persisted (which is a raw `last_seen_at` of a row that build
 * read, so ranking it lands on precisely that row's new key — the position is
 * preserved exactly, for any spelling), and an injected sync source that supplies
 * no `cursor_key`.
 */
export function componentCursorRank(stored: string | null): string {
  if (stored === null || HOUR_24_RE.test(stored)) {
    return COMPONENT_CURSOR_RANK_FLOOR;
  }
  // The canonical fast path is a SHAPE test plus a VALUE test, never shape alone.
  // Every field of `isCanonicalUtcTimestamp` is a bare digit class, so
  // `2026-06-22T10:60:00.000Z` and `2026-13-22T10:00:00.000Z` match it — and the SQL
  // half floors both, because `canonicalRankingKeySql` gates its canonical arm behind
  // `isRealInstantSql`, whose `strftime` refuses month 0/13, day 0, minute 60 and
  // second 60. Returning such text verbatim here would hand the lane a watermark no
  // real rank can ever exceed, permanently skipping every row below it. `Date.parse`
  // is the value half: measured across all 34 field boundaries of this shape it is
  // non-finite for exactly the set `strftime` returns NULL for, including the
  // agreement that matters in the other direction — an out-of-range calendar day,
  // which both engines ROLL and the SQL canonical arm then passes through verbatim.
  if (isCanonicalUtcTimestamp(stored)) {
    return validIso(stored) === null ? COMPONENT_CURSOR_RANK_FLOOR : stored;
  }
  if (!(SQLITE_T_FORM_RE.test(stored) || DATE_ONLY_RE.test(stored))) {
    return COMPONENT_CURSOR_RANK_FLOOR;
  }
  const readable = readZoneLessAsUtc(stored);
  return validIso(readable) === null
    ? COMPONENT_CURSOR_RANK_FLOOR
    : toCanonicalIso(readable);
}

/**
 * Whether a stored value carries an instant this ranking can read.
 *
 * The bad-data half of the pair: a non-null value that ranks to the floor is
 * CORRUPT, not merely absent, and the two must stay distinguishable at the call
 * site that reports it. Spelled here so a caller cannot re-derive the test and
 * drift from the fold.
 */
export function isUnreadableComponentCursorValue(
  stored: string | null
): boolean {
  return (
    stored !== null &&
    componentCursorRank(stored) === COMPONENT_CURSOR_RANK_FLOOR
  );
}

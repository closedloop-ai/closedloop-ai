/**
 * ISS-9482 (PRD-706 R10-S07) — the vocabulary a list query uses to state what
 * it does with a value it cannot judge, for filter predicates and for sort
 * keys.
 *
 * This module names cases and dispositions only. Which disposition a given
 * field takes is declared by that list's own registry (Branches:
 * `./branch-list-value-semantics.ts`), and the query compilers derive the
 * predicates that can express a different answer from those declarations
 * rather than writing the answer out a second time.
 *
 * `artifact-status-rank.ts` states the sort half of this in prose and names
 * three implementations of it; `ListQuerySortDisposition` is that prose given a
 * symbol those implementations can read.
 *
 * ORDERING among values that ARE present — case, locale, timezone — is
 * `./list-query-ordering-semantics.ts` (ISS-9585) and is deliberately not
 * expressible here.
 */

/** What a list query's parse boundary decides about one request operand. */
export const ListQueryOperandCase = {
  /** Cannot be parsed into the field's domain. */
  Malformed: "malformed",
  /** Parses, but names no member of a closed domain. */
  Unknown: "unknown",
  /** Sent with a blank value — the serialization of a cleared control. */
  Blank: "blank",
  /** A parameter this release stopped honoring that older clients still send. */
  Retired: "retired",
} as const;
export type ListQueryOperandCase =
  (typeof ListQueryOperandCase)[keyof typeof ListQueryOperandCase];

/** The two ways a ROW's value for a field can fail to be judgeable. */
export const ListQueryRowValueCase = {
  /** The row carries no value for the field. */
  Missing: "missing",
  /** The value could not be computed or loaded for this read. */
  Unavailable: "unavailable",
} as const;
export type ListQueryRowValueCase =
  (typeof ListQueryRowValueCase)[keyof typeof ListQueryRowValueCase];

/** What the parse boundary does with a request operand it cannot use. */
export const ListQueryOperandDisposition = {
  /**
   * The request is refused.
   *
   * Dropping the operand instead answers with the row set of a DIFFERENT query
   * — usually a wider one — and the caller cannot tell that from a correct
   * answer. `CustomFieldQueryRejection` carries the refusal codes.
   */
  Refuse: "refuse",
  /**
   * The operand is read as if the caller had not sent the parameter, so the
   * field's own default applies. Legitimate only where the absent reading is
   * the one a caller means, never as a fallback for a value that failed to
   * parse.
   */
  TreatAsAbsent: "treatAsAbsent",
  /**
   * The parameter is stripped before validation and the request proceeds.
   * Reserved for a retired parameter an already-shipped client still sends,
   * where refusing would answer its whole read with a 400.
   */
  Ignore: "ignore",
} as const;
export type ListQueryOperandDisposition =
  (typeof ListQueryOperandDisposition)[keyof typeof ListQueryOperandDisposition];

/** What an active filter predicate does with a row it cannot judge. */
export const ListQueryFilterDisposition = {
  /** Retained: the predicate cannot judge the row, so it does not cut it. */
  Retain: "retain",
  /** Cut whenever the predicate is active. */
  Exclude: "exclude",
  /**
   * Folded into a member of the field's own domain before the predicate runs,
   * so the reader can select it deliberately and only that selection keeps it.
   */
  Selectable: "selectable",
  /** No row can reach this field without a value, so the case does not arise. */
  Total: "total",
} as const;
export type ListQueryFilterDisposition =
  (typeof ListQueryFilterDisposition)[keyof typeof ListQueryFilterDisposition];

/** Where a row the sort key cannot rank lands, in BOTH sort directions. */
export const ListQuerySortDisposition = {
  First: "first",
  Last: "last",
} as const;
export type ListQuerySortDisposition =
  (typeof ListQuerySortDisposition)[keyof typeof ListQuerySortDisposition];

/**
 * One field's declared behavior for the two row-side cases.
 *
 * `evidence` names the production expression that makes the declaration true,
 * so a reader can check the claim rather than trust it.
 */
export type ListQueryFieldValueSemantics = Readonly<
  Record<ListQueryRowValueCase, ListQueryFilterDisposition>
> & {
  readonly evidence: string;
};

/**
 * Whether an unjudgeable row survives a predicate carrying this disposition.
 *
 * Every compiler asks THIS, never the inverse: a predicate that expresses
 * "do not cut" by omitting a guard does not retain anything under SQL's
 * three-valued logic, so the two mirrors would answer differently.
 */
export function listQueryRetainsUnjudgeableRow(
  disposition: ListQueryFilterDisposition
): boolean {
  return disposition === ListQueryFilterDisposition.Retain;
}

/** Whether a row the sort key cannot rank is ordered ahead of ranked rows. */
export function listQueryOrdersUnrankedRowFirst(
  disposition: ListQuerySortDisposition
): boolean {
  return disposition === ListQuerySortDisposition.First;
}

/**
 * The one disposition a predicate that cannot tell the two row-value cases apart
 * may honour.
 *
 * A predicate reading a single nullable column — `dims.loc_change`,
 * `dims.last_active_at` — sees one NULL for both cases and can implement exactly
 * one answer. Asking for it here rather than reaching for `.missing` is what
 * makes the OTHER column load-bearing in such a predicate: a declaration it
 * cannot honour fails loudly instead of being silently ignored while the record
 * still claims it.
 */
export function listQueryFoldedRowDisposition(
  semantics: ListQueryFieldValueSemantics
): ListQueryFilterDisposition {
  if (semantics.missing !== semantics.unavailable) {
    throw new TypeError(
      `A folded predicate cannot honour "${semantics.missing}" for a missing value and "${semantics.unavailable}" for an unavailable one (${semantics.evidence}). Give the field a predicate that can tell the two apart, or declare one answer for both.`
    );
  }
  return semantics.missing;
}

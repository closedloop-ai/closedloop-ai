/**
 * ISS-8335: the wire spelling of the Sessions list's ORDERED sort rules.
 *
 * The v2 toolbar lets a reader stack sort rules ("Status, then Cost"), and the
 * list read has carried exactly one — a scalar `sortBy`/`sortDir` pair — since
 * it was written. A toolbar that displays a second rule the query never sends is
 * a control that lies about the order it produced, so the rules travel as a
 * REPEATABLE `sorts` param, one entry per rule, in priority order.
 *
 * `sortBy`/`sortDir` stay accepted and unchanged. They are the one-rule spelling
 * of the same axis, which is what every version-skewed Desktop build and every
 * generated API client sends today; `sorts` wins when present and the scalar pair
 * is read otherwise. Nothing here narrows the column — the server validates it
 * against `AGENT_SESSION_SORT_COLUMNS` and the client against its own
 * `SessionSortKey`, so this module owns the ENCODING and neither side's
 * vocabulary. Duplicating the column list here to "validate properly" is how the
 * two lists drift out of agreement.
 */

/** Separates a rule's column from its direction. No column id contains it. */
export const SESSION_SORT_RULE_SEPARATOR = ":";

/** The repeatable query param carrying one {@link formatSessionSortRule} per rule. */
export const SESSION_SORT_RULES_QUERY_PARAM = "sorts";

/** One rule as it arrives off the wire, before either side narrows it. */
export type SessionSortRuleParts = {
  column: string;
  dir: string;
};

/** Encode one rule as its `<column>:<dir>` wire entry. */
export function formatSessionSortRule(column: string, dir: string): string {
  return `${column}${SESSION_SORT_RULE_SEPARATOR}${dir}`;
}

/**
 * Decode one `<column>:<dir>` wire entry, or `null` when it is not that shape.
 *
 * Splits on the FIRST separator and rejects an entry with an empty half, so a
 * malformed value is refused by the caller's validator rather than parsing into
 * a rule with a blank column that would silently order by nothing.
 */
export function parseSessionSortRule(raw: string): SessionSortRuleParts | null {
  const separatorIndex = raw.indexOf(SESSION_SORT_RULE_SEPARATOR);
  if (separatorIndex <= 0) {
    return null;
  }
  const column = raw.slice(0, separatorIndex);
  const dir = raw.slice(separatorIndex + SESSION_SORT_RULE_SEPARATOR.length);
  if (dir.length === 0) {
    return null;
  }
  return { column, dir };
}

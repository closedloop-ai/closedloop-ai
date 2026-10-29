/**
 * @file The encoding shared by the two STORED natural-key columns the Claude
 * Code OTel lane derives — `claude_code_cost_event.attribution_key` and
 * `claude_code_error_event.occurrence_key`.
 *
 * Both flatten a fixed tuple of optional attribute values into one TEXT column
 * that participates in a UNIQUE index, so the flattening must be INJECTIVE:
 * two different tuples that produce one key make the persister's upsert merge
 * two different facts into a single row, silently, under whichever arrived
 * first.
 */

/** Separates a part's length from the part itself — see {@link joinKeyParts}. */
const KEY_PART_LENGTH_DELIMITER = ":";

/**
 * The parts of a fixed-arity tuple, flattened injectively.
 *
 * LENGTH-PREFIXED rather than separator-joined. Both keys used to join their
 * parts with the ASCII unit separator on the claim that no accepted attribute
 * value can contain one — but nothing enforces that claim: `readString` only
 * trims, and U+001F is not whitespace, so a value carrying the separator shifts
 * the part boundaries and two different tuples flatten to the same key (whitlockk,
 * ISS-7352 review). A length prefix cannot be spoofed by content: the decoder
 * reads digits up to the first `:` and then consumes exactly that many units,
 * so for a fixed arity the mapping is one-to-one whatever the values contain.
 *
 * Callers own the "the producer named nothing" case and return `""` themselves
 * — that sentinel is the value the migration gives every pre-existing row, and
 * what it means differs per column.
 */
export function joinKeyParts(parts: readonly (string | undefined)[]): string {
  return parts
    .map((part) => part ?? "")
    .map((part) => `${part.length}${KEY_PART_LENGTH_DELIMITER}${part}`)
    .join("");
}

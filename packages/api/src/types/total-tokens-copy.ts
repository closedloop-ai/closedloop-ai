/**
 * ISS-10667: the ONE phrase for the token total.
 *
 * The quantity is `input + output + cache read + cache write` (ISS-7175, and
 * DOC-27 R3). Sentence case by operator ruling 6 on 2026-09-18 — DOC-27 writes
 * it title case and is amended, rather than the code changed to match.
 *
 * Lives beside `total-estimated-cost-copy.ts` and for the same reason: a
 * bundle-sensitive client and a Playwright spec can name the metric without
 * importing a component runtime.
 *
 * This is NOT the label of the Session-detail Properties token row. That row
 * prints the four counters broken out and never sums them, so it is a different
 * quantity wearing the same word; ISS-7175 ruled it keeps a plain noun, and
 * `SESSION_TOKENS_PROPERTY_LABEL` still owns it.
 */
export const TOTAL_TOKENS_LABEL = "Total tokens" as const;

/**
 * ISS-10667 ruling 7: the ONE authorized short form. No site has produced a
 * measurement requiring it yet — every token label measured fits the canonical
 * phrase — so this is declared for the vocabulary's completeness and carries the
 * same burden of proof as the dollar alias.
 */
export const TOTAL_TOKENS_ALIAS_LABEL = "Tokens" as const;

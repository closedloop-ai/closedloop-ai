import type { CountNoun } from "@repo/design-system/lib/count-noun";

/**
 * What one Sessions row IS, said once (ISS-9574).
 *
 * `agents-table` declared this for its linked-session `CountCell` and the
 * Sessions bulk rail declared the same two words again for its own label, so the
 * product carried two "session" nouns in two shapes. Every surface that counts
 * sessions — a count cell, the bulk rail's visible label, the selection
 * announcer a screen reader hears — reads this one, which is what keeps
 * "1 sessions selected" from shipping on the surface nobody re-read.
 */
export const SESSIONS_NOUN: CountNoun = { one: "session", other: "sessions" };

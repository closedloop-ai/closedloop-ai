import type { z } from "zod";

/**
 * The two character classes a Postgres `text` or `jsonb` column refuses at the
 * write (SQLSTATE 22021 for NUL; an invalid escape for a lone surrogate), owned
 * once so a guard and a sanitizer can never disagree on what "unstorable" means.
 *
 * A guard REJECTS (this module's schema wrapper); the sanitizer in
 * `apps/api/lib/agent-sessions-text-sanitizer.ts` STRIPS. A lane picks by asking
 * whether a hash reconciles the stored value against the wire value: the
 * invocation sync lane rehashes persisted rows and compares against the wire
 * generation id, so any mutation there becomes a permanent `generation_conflict`
 * (ISS-9174), and it rejects instead.
 */

/** U+0000, spelled as the escape per `scripts/lint/rules/no-raw-nul-byte.ts`. */
export const NUL_CHARACTER = "\u0000";

/**
 * A high surrogate not followed by a low one, or a low surrogate not preceded by
 * a high one. Deliberately NOT global: `RegExp.prototype.test` on a `/g` regex
 * advances `lastIndex`, so a global flag here would make
 * {@link containsLoneSurrogate} alternate true/false across calls on the same
 * value and intermittently accept what it exists to reject. The sanitizer builds
 * its own `/g` copy, carrying every flag declared here with it.
 */
export const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Issue messages the shared wire schemas raise, one per class. */
export const PostgresTextRejection = {
  ContainsNul: "contains_nul",
  ContainsLoneSurrogate: "contains_lone_surrogate",
} as const;
export type PostgresTextRejection =
  (typeof PostgresTextRejection)[keyof typeof PostgresTextRejection];

export function containsNulCharacter(value: string): boolean {
  return value.includes(NUL_CHARACTER);
}

export function containsLoneSurrogate(value: string): boolean {
  return LONE_SURROGATE_RE.test(value);
}

/**
 * Reject, never rewrite, a string Postgres could not store. Refines change no
 * value, so a hash computed over the input is the hash computed over the output.
 */
export function postgresStorableTextSchema<T extends z.ZodType<string>>(
  schema: T
): T {
  return schema
    .refine(
      (value) => !containsNulCharacter(value),
      PostgresTextRejection.ContainsNul
    )
    .refine(
      (value) => !containsLoneSurrogate(value),
      PostgresTextRejection.ContainsLoneSurrogate
    );
}

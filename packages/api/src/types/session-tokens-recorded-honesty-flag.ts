/**
 * @file session-tokens-recorded-honesty-flag.ts
 * @description Shared key for the closed-by-default session-detail Tokens row
 * unknown state (ISS-5637, under ISS-4779).
 *
 * ISS-5565 gave the Tokens row a null-per-counter unknown state, but neither
 * producer can emit that null — the cloud reads four `BigInt @default(0)`
 * columns through a `toNumber` that maps null to `0`, and the desktop folds
 * `sumTokenUsage` out of `zeroTotals()`. A session with no token-usage rows
 * therefore asserted `0 in | 0 out | 0 cache read | 0 cache write` two rows
 * above a Cost dash meaning "no token usage recorded to price": one panel,
 * two contradictory statements about one session.
 *
 * The Properties panel it gates mounts on BOTH surfaces, so the gate must exist
 * on both or the corrected row leaks on the ungated one. Both surfaces read it
 * as a PostHog flag — the desktop renderer resolves the signed-in account's
 * PostHog assignment from the same key space `apps/app` reads — and both alias
 * THIS constant so the two strings cannot drift. It lives in `@repo/api`
 * because that is the only dependency-free module both surfaces can import.
 */
export const SESSION_TOKENS_RECORDED_HONESTY_FLAG_KEY =
  "session-tokens-recorded-honesty" as const;

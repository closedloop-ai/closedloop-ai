import { API_KEY_SCOPES, type ApiKeyScope } from "@repo/api/src/types/api-key";

/**
 * The Prisma `where` fragment describing an API key row that could actually
 * authenticate a request today.
 *
 * ISS-4905 made `verifyKeyWithMetadata` reject a key whose stored scope array is
 * empty, absent, or entirely unrecognized. Projections that report a key as
 * present must agree with that, or the product lies: the desktop onboarding and
 * compute-target security readers treated any non-revoked row as protective, so
 * a key the verifier now refuses would still render "Protected" and "setup
 * complete", suppressing the reprovisioning that would actually fix it.
 *
 * The scope predicate mirrors `resolveApiKeyScopes`: sanitization keeps only
 * recognized entries, so "at least one recognized scope survives" is exactly
 * `hasSome` over the shared vocabulary. `hasSome` on an empty stored array is
 * false, which is the fail-closed answer.
 *
 * Spread this into a query's `where`; it owns the `revokedAt`, `expiresAt`, and
 * `scopes` keys, so a caller that needs its own disjunction must compose it
 * rather than declaring a second top-level `OR`.
 *
 * The return type is declared rather than inferred with `as const`: Prisma's
 * generated `ApiKeyWhereInput.OR` is a mutable `ApiKeyWhereInput[]`, and a
 * `readonly` tuple is not assignable to it, so `as const` made every caller's
 * `where` fail to typecheck. The explicit type keeps the per-branch precision
 * callers and tests read while staying spreadable into a Prisma query.
 */
export function usableApiKeyWhere(now: Date = new Date()): UsableApiKeyWhere {
  return {
    revokedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    scopes: { hasSome: [...API_KEY_SCOPES] },
  };
}

/** The `where` fragment {@link usableApiKeyWhere} contributes. */
export type UsableApiKeyWhere = {
  revokedAt: null;
  OR: [{ expiresAt: null }, { expiresAt: { gt: Date } }];
  scopes: { hasSome: ApiKeyScope[] };
};

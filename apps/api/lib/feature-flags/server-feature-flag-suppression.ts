import type { ServerFeatureFlag } from "./server-feature-flag";
import type { RegisteredGrantFeatureFlag } from "./server-feature-flags";

/**
 * Module-private nominal marker. Nothing outside this file can name the key,
 * which is what stops a caller hand-rolling a `GrantSuppression` object literal
 * holding a RESTRICTION key. Without it the type is structurally just
 * `{ suppressedKeys: ReadonlySet<string> }`, and the unrepresentability claim
 * below would rest on caller discipline rather than on the compiler — the
 * `suppressGrants` signature alone constrains only that one function.
 */
const GRANT_SUPPRESSION_BRAND: unique symbol = Symbol("grantSuppression");

/**
 * ISS-7778: a blanket withholding of server flags that can only ever withhold
 * GRANTS.
 *
 * TWO THINGS MAKE THAT STRUCTURAL RATHER THAN CONVENTIONAL. The set is built
 * from {@link RegisteredGrantFeatureFlag} values, so `suppressGrants` rejects a
 * restriction at compile time; and the brand means `suppressGrants` and
 * `suppressAllGrants` are the only expressions in the codebase that can produce
 * a value of this type at all. Suppressing enforcement is not discouraged here,
 * it is unrepresentable, and no runtime check has to be trusted to notice.
 *
 * Deliberately opaque about WHY flags are being withheld. This module owns the
 * mechanism only; which mode or caller applies a suppression, and to whom, is a
 * separate decision this substrate does not make.
 */
export type GrantSuppression = {
  /** The grant keys whose enabled state is withheld. */
  readonly suppressedKeys: ReadonlySet<string>;
  readonly [GRANT_SUPPRESSION_BRAND]: true;
};

/**
 * Builds a suppression over the given grants.
 *
 * Restrictions are excluded BY TYPE and never by filtering: a runtime filter
 * here would keep a misclassified restriction out of the set even when the
 * classification is wrong, which would make the classification untestable — the
 * survival test would pass for the wrong reason. Membership is the only rule, so
 * reclassifying a restriction as a grant is immediately visible.
 *
 * THE PARAMETER IS THE REGISTRY'S OWN GRANT DESCRIPTORS, not the open
 * `GrantFeatureFlag<string>` this used to accept. That wider type let the KIND
 * be re-declared for an arbitrary key: `defineGrantFlag` is public and generic
 * over `Key extends string`, so `defineGrantFlag(
 * DESKTOP_MANAGED_POP_ENFORCEMENT_SERVER_FLAG.key)` type-checked and produced a
 * grant-typed value carrying a RESTRICTION's key. Since `isFlagSuppressed` is
 * deliberately pure set membership, that value suppressed proof-of-possession
 * enforcement with nothing able to see it. Narrowing to the registry-derived
 * union means the only admissible arguments are the descriptors the registry
 * itself classified, so the key and its kind can no longer be separated.
 */
export function suppressGrants(
  flags: readonly RegisteredGrantFeatureFlag[]
): GrantSuppression {
  return {
    suppressedKeys: new Set(flags.map((flag) => flag.key)),
    [GRANT_SUPPRESSION_BRAND]: true,
  };
}

/**
 * Whether a suppression withholds this flag's enabled state.
 *
 * Set membership and nothing else. It does NOT re-check `flag.kind`: a second,
 * independent guard here would silently rescue a restriction that had been
 * misclassified as a grant, hiding exactly the defect the classification exists
 * to prevent.
 */
export function isFlagSuppressed(
  suppression: GrantSuppression | undefined,
  flag: ServerFeatureFlag
): boolean {
  return suppression?.suppressedKeys.has(flag.key) === true;
}

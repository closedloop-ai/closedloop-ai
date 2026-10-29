/**
 * Where each numerator provider's values COME FROM (ISS-8399).
 *
 * This is the typecheck gate the seam is built around. `NumeratorProvider` in
 * `@repo/api` is the open, closed-at-any-instant set of providers; this map is
 * typed `Record<NumeratorProvider, …>`, so adding a member there — JIRA story
 * points, say — fails `tsc` HERE until someone states whether the new provider
 * is derived from data we already hold or needs an external association store,
 * and, if the latter, which persisted provider it is stored as.
 *
 * The alternative (a `switch` with a `default`, or a partial map) is what lets a
 * new provider ship silently reading as "no data" — which is indistinguishable
 * on screen from a real zero.
 */

import type { NumeratorProvider } from "@repo/api/src/types/numerator-provider";
import { NumeratorProvider as NumeratorProviderValues } from "@repo/api/src/types/numerator-provider";
import { DeliveryPointProvider } from "@repo/database";

/**
 * How a provider's per-artifact values are obtained.
 *
 * `derived` providers are computed from records we already hold (LOC comes out
 * of our own PR diffs), so they have no backfill, no association store, and no
 * coverage question — every artifact we have, we can value.
 *
 * `association` providers arrive from an external feed and must be matched to
 * our records first, so their coverage is a property of the match and a missing
 * row is NEVER a zero.
 */
export type DeliveryProviderBinding =
  | { readonly kind: "derived" }
  | {
      readonly kind: "association";
      /** The persisted provider column value for this numerator provider. */
      readonly storedAs: DeliveryPointProvider;
    };

/** EXHAUSTIVE binding for every numerator provider. See the module docstring. */
export const DELIVERY_PROVIDER_BINDINGS: Record<
  NumeratorProvider,
  DeliveryProviderBinding
> = {
  [NumeratorProviderValues.Loc]: { kind: "derived" },
  [NumeratorProviderValues.Pensero]: {
    kind: "association",
    storedAs: DeliveryPointProvider.PENSERO,
  },
};

/**
 * The persisted provider column for a numerator provider, or `null` when the
 * provider is derived and has no association rows.
 *
 * Returning `null` rather than throwing keeps a derived provider a legitimate
 * argument at every call site; the caller that needs association rows checks
 * for `null` explicitly instead of discovering it at query time.
 */
export function deliveryPointProviderFor(
  providerId: NumeratorProvider
): DeliveryPointProvider | null {
  const binding = DELIVERY_PROVIDER_BINDINGS[providerId];
  return binding.kind === "association" ? binding.storedAs : null;
}

import "server-only";

/**
 * ISS-11117 — the Sessions listing's Pensero points-per-dollar numerator.
 *
 * The Sessions summary's LOC/$ card divides merged gross lines by the total
 * estimated cost of the matched sessions. This is the same ratio with Pensero
 * delivery points as its numerator, over the IDENTICAL denominator, so the two
 * describe one population and only the numerator differs.
 *
 * ## How a SESSION population acquires a POINTS numerator
 *
 * Pensero measures delivery against branches, not sessions. The bridge already
 * exists: the branch attribution lens (`aggregateSessionAttributionLenses`)
 * keys each matched session's spend by `branchArtifactId`, so the branches
 * those sessions touched are exactly the population this reads points for. The
 * summary reads that branch set whenever it is handed a reader — with the lens
 * when the lens is published, on its own when it is not (ISS-12284) — so this
 * module hands out a reader only inside the rollout.
 *
 * ## The points total covers the request's date range
 *
 * `costUsd` is the cost of the sessions this request matched, which its date
 * range narrows. The reader therefore carries that range down to the delivery
 * fold, which sums only the shares the provider dated inside it
 * (`DeliveryPointWindow`). Without it the ratio would divide a branch-lifetime
 * total by a windowed cost and read high by an amount nothing on screen shows.
 * The NON-date facets are a different misalignment with a different answer —
 * `pensero-population-alignment.ts` owns that one.
 *
 * ## Gating and failure, both inherited
 *
 * `sessionsPenseroPointsReader` checks the SERVER half of
 * `pensero-points-per-dollar` before the summary runs, so a reader outside the
 * rollout gets no reader and pays for no lens hydration (ISS-11895).
 * `readCohortPenseroNumerator` checks it again before any database work and
 * swallows every throw to `null`, so a delivery outage cannot 500 the Sessions
 * summary. A `null` here means the response omits the field, and the card keeps
 * rendering LOC/$ exactly as today.
 */

import { locPerDollarFromLines } from "@repo/api/src/utils/loc-per-dollar";
import {
  isPenseroPointsPerDollarEnabled,
  readCohortPenseroNumerator,
} from "@/app/branches/branch-pensero-numerator";
import type { DeliveryPointWindow } from "@/lib/delivery-points/delivery-point-attribution";
import type { FeatureFlagIdentity } from "@/lib/feature-flag-identity";

/**
 * The Sessions summary's points ratio, or `null` when there is none to publish.
 *
 * A MEASURED ZERO publishes as `0`: `locPerDollarFromLines` divides a known
 * zero numerator (ISS-9980 — "this population delivered nothing, and you spent
 * $X" is a fact), and `0` is a value the field can carry, distinct from the
 * field being absent. That distinction is the whole fallback contract, so it is
 * never collapsed with `?? 0` or with a falsy test.
 */
export async function readSessionsPenseroPointsPerDollar(
  identity: FeatureFlagIdentity,
  organizationId: string,
  branchArtifactIds: readonly string[],
  costUsd: number,
  /**
   * ISS-11117: the request's date window. `costUsd` is the cost of the sessions
   * this range matched, so the points total must cover the same range or the
   * ratio inflates as the window narrows.
   */
  window?: DeliveryPointWindow
): Promise<number | null> {
  const numerator = await readCohortPenseroNumerator(
    identity,
    organizationId,
    branchArtifactIds,
    window
  );
  if (numerator === null) {
    return null;
  }
  return locPerDollarFromLines(numerator.points, costUsd);
}

/** How the Sessions usage route hands this reader to the summary builder. */
export type SessionsPenseroPointsReader = (
  branchArtifactIds: readonly string[],
  costUsd: number
) => Promise<number | null>;

/**
 * Bind the identity and org once, at the route, so the summary builder never
 * has to know which principal is asking or that PostHog exists.
 *
 * ISS-11895: `undefined` outside the rollout. A reader's presence is what makes
 * the summary read the attribution branch set, so a reader that could only
 * ever answer `null` would cost every out-of-rollout listing that read.
 */
export async function sessionsPenseroPointsReader(
  identity: FeatureFlagIdentity,
  organizationId: string,
  /** ISS-11117: the request's date window, bound once with the identity. */
  window?: DeliveryPointWindow
): Promise<SessionsPenseroPointsReader | undefined> {
  if (!(await isPenseroPointsPerDollarEnabled(identity))) {
    return undefined;
  }
  return (branchArtifactIds, costUsd) =>
    readSessionsPenseroPointsPerDollar(
      identity,
      organizationId,
      branchArtifactIds,
      costUsd,
      window
    );
}

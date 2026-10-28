/**
 * ISS-8424 (cr, davetho): the Delivery read starts the unmeasured-population
 * resync in a `waitUntil` lane, and the platform bounds that lane by the ROUTE's
 * ceiling — not by when the response was sent. So the route owes the same
 * declaration the connect lane makes for the same chain.
 *
 * The cost of omitting it is worse than a lost sweep. `claimOrganizationRun`
 * writes `cooldownUntil` at CLAIM time, so a pass killed mid-sweep has already
 * spent the org's hour: Delivery stays unmeasured with no verification written,
 * and nothing retries until the cooldown expires. A ceiling shorter than the
 * lease would also hold the gate past the point where the run it describes can
 * still be alive — the ISS-7721 argument, one lane over.
 *
 * Route-segment config must be a static literal, so the route writes the number
 * and this pins it to the constants that carry the reasoning — the shape
 * `integrations/github/post-connect-max-duration.test.ts` uses.
 */

import { describe, expect, it } from "vitest";
import { POST_CONNECT_SYNC_LEASE_MS } from "@/app/integrations/github/post-connect-sync-service";
import { maxDuration as deliveryMaxDuration } from "./delivery/route";
import { UNMEASURED_DELIVERY_RESYNC_LEASE_MS } from "./unmeasured-delivery-resync";

const MS_PER_SECOND = 1000;

describe("the Delivery route declares the ceiling its resync lane runs under", () => {
  it("runs for exactly the resync gate's own lease", () => {
    expect(deliveryMaxDuration * MS_PER_SECOND).toBe(
      UNMEASURED_DELIVERY_RESYNC_LEASE_MS
    );
  });

  /**
   * The outer gate wraps `runPostConnectObservedSync`, which claims its own
   * lease over the actual work. A route ceiling under THAT one would kill the
   * chain while its inner gate still reads as in-flight, refusing the next
   * connect for a run nothing is working in.
   */
  it("also covers the inner post-connect chain it reuses", () => {
    expect(deliveryMaxDuration * MS_PER_SECOND).toBeGreaterThanOrEqual(
      POST_CONNECT_SYNC_LEASE_MS
    );
  });
});

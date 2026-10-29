/**
 * ISS-7721: the post-connect sync's gate lease and the route that starts it
 * encode one ceiling. The platform kills the `waitUntil` lane at the route's
 * `maxDuration`, so a lease longer than that would hold the gate past the point
 * where the run it describes can still be alive — the next connect would be
 * refused by a lane nothing is working in.
 *
 * Route-segment config must be a static literal, so the route writes the number
 * and this pins it to the constant that carries the reasoning.
 */

import { describe, expect, it } from "vitest";
import { maxDuration as clerkLinkMaxDuration } from "./clerk-link/route";
import { POST_CONNECT_SYNC_LEASE_MS } from "./post-connect-sync-service";

const MS_PER_SECOND = 1000;

describe("post-connect sync lease matches its route's ceiling", () => {
  it("leases the gate for exactly the clerk-link route's maxDuration", () => {
    expect(clerkLinkMaxDuration * MS_PER_SECOND).toBe(
      POST_CONNECT_SYNC_LEASE_MS
    );
  });
});

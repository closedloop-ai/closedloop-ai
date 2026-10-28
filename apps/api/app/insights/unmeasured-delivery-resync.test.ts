/**
 * ISS-8424: the read-triggered resync, and the bound that keeps it from
 * becoming ISS-8423's unbounded rescue arm.
 *
 * The trigger fires from a Dashboard READ, so the interesting property is not
 * "it runs" — it is that a second read cannot run it again, and that a FAILING
 * org is bounded exactly like a succeeding one. Each case pins one of those.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn((promise: Promise<unknown>) => promise),
}));
vi.mock("@/app/integrations/github/post-connect-sync-service", () => ({
  runPostConnectObservedSync: vi.fn(),
}));
vi.mock("@/lib/organization-run-gate", () => ({
  claimOrganizationRun: vi.fn(),
  releaseOrganizationRun: vi.fn(),
}));

import { waitUntil } from "@vercel/functions";
import { runPostConnectObservedSync } from "@/app/integrations/github/post-connect-sync-service";
import {
  claimOrganizationRun,
  releaseOrganizationRun,
} from "@/lib/organization-run-gate";
import {
  scheduleUnmeasuredDeliveryResync,
  UNMEASURED_DELIVERY_RESYNC_COOLDOWN_MS,
} from "./unmeasured-delivery-resync";

const ORG = "org-1";

/**
 * `waitUntil` is stubbed to return the promise it is given, so a case can await
 * the background work instead of racing it. Nothing here relies on a timer.
 */
function scheduled(): Promise<unknown> {
  const [promise] = vi.mocked(waitUntil).mock.calls.at(-1) ?? [];
  return promise instanceof Promise ? promise : Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(claimOrganizationRun).mockResolvedValue({ claimed: true });
  vi.mocked(runPostConnectObservedSync).mockResolvedValue({} as never);
  vi.mocked(releaseOrganizationRun).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scheduleUnmeasuredDeliveryResync", () => {
  it("runs the observed-sync chain once it takes the lane", async () => {
    scheduleUnmeasuredDeliveryResync(ORG);
    await scheduled();

    expect(runPostConnectObservedSync).toHaveBeenCalledWith({
      organizationId: ORG,
    });
  });

  it("runs nothing when the lane is already claimed or cooling down", async () => {
    vi.mocked(claimOrganizationRun).mockResolvedValue({
      claimed: false,
      settings: {},
      blockedUntil: Date.now() + 1000,
    });

    scheduleUnmeasuredDeliveryResync(ORG);
    await scheduled();

    // The bound. Without it every Dashboard read of an unverifiable org would
    // start another five-repo GitHub sweep.
    expect(runPostConnectObservedSync).not.toHaveBeenCalled();
  });

  it("restarts the cooldown even when the chain throws", async () => {
    vi.mocked(runPostConnectObservedSync).mockRejectedValue(
      new Error("github unreachable")
    );

    scheduleUnmeasuredDeliveryResync(ORG);
    await scheduled();

    // Releasing only on success would re-admit a permanently unverifiable org
    // as soon as the lease expired, which is the starvation shape ISS-8423 hit.
    expect(releaseOrganizationRun).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({
        cooldownMs: UNMEASURED_DELIVERY_RESYNC_COOLDOWN_MS,
      })
    );
  });

  it("swallows a chain failure rather than rejecting into the read", async () => {
    vi.mocked(runPostConnectObservedSync).mockRejectedValue(
      new Error("github unreachable")
    );

    scheduleUnmeasuredDeliveryResync(ORG);

    await expect(scheduled()).resolves.toBeUndefined();
  });

  it("bounds the read-triggered arm to one pass per org per hour", () => {
    // Pinned as a value, not a shape: the connect lane's own gate is a minute,
    // and inheriting that here is the mistake this constant exists to prevent.
    expect(UNMEASURED_DELIVERY_RESYNC_COOLDOWN_MS).toBe(60 * 60 * 1000);
  });
});

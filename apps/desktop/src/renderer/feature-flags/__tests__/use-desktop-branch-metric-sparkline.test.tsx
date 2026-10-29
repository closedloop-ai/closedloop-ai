import { BRANCH_METRIC_SPARKLINE_FEATURE_FLAG_KEY } from "@repo/api/src/types/branch-metric-sparkline-flag";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DesktopFeatureFlagProvider,
  useDesktopFeatureFlagsResolved,
} from "../desktop-feature-flag-provider";
import { useDesktopBranchMetricSparkline } from "../use-desktop-branch-metric-sparkline";

/**
 * ISS-10544 — the half of the operator's 2026-09-17 ruling that STAYS gated.
 *
 * The web half graduated because a signed-out desktop reader can never resolve
 * this key true, so no rollout percentage could have shipped the mark there.
 * That claim is the reason the ruling is shaped the way it is, and until now it
 * lived only in prose: the cross-shell parity suite drives this hook through the
 * shared static adapter, which cannot say anything about desktop's own
 * resolution. These cases mount the REAL `DesktopFeatureFlagProvider`.
 *
 * The signed-out case is deliberately handed a bridge that WOULD answer true.
 * A guest closed against an empty bridge proves only that nothing said yes.
 *
 * EVERY capability assertion here waits on SETTLED-ness first (whitlockk, #7525).
 * `useDesktopPostHogFlagAssignment` starts at `PENDING`, whose `flags` is `{}`,
 * so this hook answers `false` on the very first commit — before the provider's
 * effect has run at all. A bare `waitFor(... "false")` is therefore satisfied by
 * the pending frame and would stay green if the signed-out branch later adopted
 * the bridge's `true`. `useDesktopFeatureFlagsResolved` is that provider's own
 * settled signal (`false` while pending, `true` on every terminal delivery), so
 * gating on it is what makes the negative case able to fail for the reason its
 * name claims. Since ISS-11945 a signed-out reader DOES ask the bridge, for its
 * node_uuid-keyed assignment, so the signed-out case waits for that answer to
 * land and be filtered to the anonymous allow-list before reading the mark.
 */

const CAPABILITY_TEST_ID = "branch-metric-sparkline-capability";
const RESOLVED_TEST_ID = "branch-metric-sparkline-resolved";

const ASSIGNMENT_WITH_MARK_ON = {
  userId: "user_1",
  resolved: true,
  flags: { [BRANCH_METRIC_SPARKLINE_FEATURE_FLAG_KEY]: true },
} as const;

function Probe() {
  return (
    <>
      <span data-testid={CAPABILITY_TEST_ID}>
        {String(useDesktopBranchMetricSparkline())}
      </span>
      <span data-testid={RESOLVED_TEST_ID}>
        {String(useDesktopFeatureFlagsResolved())}
      </span>
    </>
  );
}

async function capability(): Promise<string> {
  return (await screen.findByTestId(CAPABILITY_TEST_ID)).textContent ?? "";
}

/**
 * Block until the provider has SETTLED, so what `capability()` reads next is an
 * answer rather than the `PENDING` frame every case starts in.
 */
async function settledCapability(): Promise<string> {
  await waitFor(async () => {
    expect((await screen.findByTestId(RESOLVED_TEST_ID)).textContent).toBe(
      "true"
    );
  });
  return await capability();
}

let originalDesktopApi: PropertyDescriptor | undefined;

beforeEach(() => {
  originalDesktopApi = Object.getOwnPropertyDescriptor(window, "desktopApi");
});

afterEach(() => {
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

function stubDesktopApi(api: Record<string, unknown>): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: api,
    writable: true,
  });
}

describe("useDesktopBranchMetricSparkline (ISS-10544)", () => {
  it("withholds the mark from a signed-out reader whose bridge says yes", async () => {
    // No auth member, so the auth store falls back to SIGNED_OUT and the
    // assignment settles closed at the `!authedUserId` branch. That is what
    // "no rollout reaches a guest" means.
    const getDesktopFeatureFlags = vi.fn(() =>
      Promise.resolve(ASSIGNMENT_WITH_MARK_ON)
    );
    stubDesktopApi({ getDesktopFeatureFlags });
    render(
      <DesktopFeatureFlagProvider>
        <Probe />
      </DesktopFeatureFlagProvider>
    );
    expect(await settledCapability()).toBe("false");
    // ISS-11945: the guest's anonymous read is issued and ANSWERS `true` for
    // this key; it is discarded because the key is outside the allow-list.
    await waitFor(() =>
      expect(getDesktopFeatureFlags).toHaveBeenCalledTimes(1)
    );
    await act(async () => {
      await getDesktopFeatureFlags.mock.results[0]?.value;
    });
    expect(await capability()).toBe("false");
  });

  it("serves the mark when the same provider does resolve the key true", async () => {
    // The positive twin on the SAME locator, the same provider and the same
    // settled gate: without it, the `false` above would be satisfied by a
    // provider that answers false to everything, which proves nothing about
    // this key.
    stubDesktopApi({
      getE2eSeededFeatureFlags: () =>
        Promise.resolve({ ...ASSIGNMENT_WITH_MARK_ON, userId: "harness" }),
    });
    render(
      <DesktopFeatureFlagProvider>
        <Probe />
      </DesktopFeatureFlagProvider>
    );
    // Through the SAME settled gate as the negative case, so the two differ only
    // in what the provider resolved — not in how long each waited.
    expect(await settledCapability()).toBe("true");
  });

  it("withholds the mark, rather than throwing, with no provider mounted", async () => {
    // Why the hook reads the OPTIONAL hook. Desktop subtrees mount without the
    // flag provider in their own suites and in Storybook; a capability question
    // must degrade to "no" there instead of crashing the tree.
    render(<Probe />);
    expect(await capability()).toBe("false");
  });
});

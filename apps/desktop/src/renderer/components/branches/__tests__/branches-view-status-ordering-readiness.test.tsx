/**
 * ISS-9437 (marisolashgrove review on #6928): the Desktop Branches surface must not
 * hand rows to the status comparator before it knows which order to sort them in.
 *
 * `useFeatureFlagEnabled` reads `false` while the account's PostHog assignment is
 * still in flight, and that is indistinguishable from a real "off". Acting on it
 * sorted the table in vocabulary order and re-sorted it under the reader when the
 * assignment landed. `useBranchServedStatusOrderingReset` does not cover this: the
 * local desktop source issues no evaluation clock, so `servedStatusOrdering` is
 * null on this path.
 *
 * The desktop adapter reports real SETTLED-ness
 * (`DesktopPostHogFlagAssignment.resolved`), which is why this file builds its own
 * adapter rather than using `createStaticFeatureFlagAdapter` — that one implements
 * no `useFeatureFlagResolved`, so every flag reads as already resolved and the
 * unresolved window this suite exists for cannot be reached.
 */

import type {
  BranchAnalytics,
  BranchUsageSummary,
} from "@repo/api/src/types/branch";
import { BranchViewerScope } from "@repo/api/src/types/branch";
import { unavailableBranchTraceResult } from "@repo/api/src/types/branch-trace";
import { makeBranchAnalytics } from "@repo/app/branches/components/branch-analytics-fixtures";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import type { FeatureFlagAdapter } from "@repo/app/shared/feature-flags/feature-flag-adapter";
import { ARTIFACT_STATUS_ROOT_ORDER_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderView, wireRow } from "./test-helpers";

vi.mock("../use-desktop-github-connect", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../use-desktop-github-connect")>();
  return {
    ...actual,
    useDesktopGitHubConnect: () => ({
      connectState: actual.DesktopGitHubConnectState.Idle,
      connectGitHub: vi.fn(),
    }),
  };
});

const pageDataMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {},
  });
  pageDataMock.mockImplementation(() =>
    Promise.resolve({
      list: {
        items: [wireRow],
        total: 1,
        viewerScope: BranchViewerScope.Self,
      },
      analytics: makeBranchAnalytics(),
    })
  );
});

describe("BranchesView status-ordering readiness (ISS-9437)", () => {
  it("does not read while the ordering assignment is still unresolved", async () => {
    const view = renderView(
      dataSource(),
      undefined,
      [],
      "/branches",
      true,
      adapter({ resolved: false, enabled: false })
    );

    // Give the read every chance to fire: the mount's effects have flushed by
    // the time this resolves, so a missing hold would already have called.
    await waitFor(() => expect(view.queryClient).toBeDefined());
    expect(pageDataMock).not.toHaveBeenCalled();
    view.unmount();
  });

  it("reads once the ordering assignment has settled", async () => {
    const view = renderView(
      dataSource(),
      undefined,
      [],
      "/branches",
      true,
      adapter({ resolved: true, enabled: false })
    );

    await waitFor(() => expect(pageDataMock).toHaveBeenCalled());
    view.unmount();
  });

  it("reads on a settled assignment that turns the key ON", async () => {
    const view = renderView(
      dataSource(),
      undefined,
      [],
      "/branches",
      true,
      adapter({ resolved: true, enabled: true })
    );

    await waitFor(() => expect(pageDataMock).toHaveBeenCalled());
    view.unmount();
  });
});

/**
 * Reports settled-ness for the ordering key alone. Every other key stays
 * resolved-and-off, so a case cannot pass by accidentally holding some unrelated
 * gate the view also consults.
 */
function adapter(options: {
  resolved: boolean;
  enabled: boolean;
}): FeatureFlagAdapter {
  return {
    useFeatureFlagEnabled: (key: string) =>
      key === ARTIFACT_STATUS_ROOT_ORDER_FEATURE_FLAG_KEY
        ? options.enabled
        : false,
    useFeatureFlagResolved: (key: string) =>
      key === ARTIFACT_STATUS_ROOT_ORDER_FEATURE_FLAG_KEY
        ? options.resolved
        : true,
  };
}

function dataSource(): BranchesDataSource {
  return {
    scope: "local",
    list: () =>
      Promise.resolve({
        items: [wireRow],
        total: 1,
        viewerScope: BranchViewerScope.Self,
      }),
    detail: () => new Promise<never>(() => undefined),
    comments: () => new Promise<never>(() => undefined),
    trace: () => Promise.resolve(unavailableBranchTraceResult()),
    usage: () => new Promise<BranchUsageSummary>(() => undefined),
    analytics: () => new Promise<BranchAnalytics>(() => undefined),
    cohortAnalytics: () => new Promise<never>(() => undefined),
    pageData: pageDataMock,
  } as unknown as BranchesDataSource;
}

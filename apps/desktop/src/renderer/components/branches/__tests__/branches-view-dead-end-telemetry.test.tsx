/**
 * @file branches-view-dead-end-telemetry.test.tsx
 * @description ISS-9725: the Branches list reaching the monitored
 * `desktop:dead-end-telemetry` channel, asserted through the REAL rendered tree
 * and the REAL preload reporter rather than a stubbed hook.
 *
 * A classifier unit test (`branches-dead-end-cause.test.ts`) proves the four
 * states stay four things. It cannot prove anyone calls it — deleting the hook
 * call from `BranchesViewContent` leaves that file green. So this suite drives a
 * data source that rejects, waits for the treatment the user would actually be
 * looking at, and asserts what arrived at `window.desktopApi`. Every failure
 * assertion is paired with the SAME locator in the opposite state, because an
 * error path that returns early satisfies almost any negative assertion.
 *
 * The keep-alive cases TOGGLE `isActive` on one instance rather than remounting
 * (review, synchronizing-susan): production never remounts the panel, and a
 * remount resets every ref in `useDeadEndTelemetry`, so an unmount/remount pair
 * cannot see the stale-dedupe-key behaviour those cases exist to pin.
 */
import {
  type BranchAnalytics,
  type BranchUsageSummary,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import { unavailableBranchTraceResult } from "@repo/api/src/types/branch-trace";
import type { SurfaceAnalyticsCapture } from "@repo/api/src/types/surface-analytics";
import { makeBranchAnalytics } from "@repo/app/branches/components/branch-analytics-fixtures";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import { ApiError } from "@repo/app/shared/api/api-error";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DeadEndFlowPhase,
  DeadEndFlowReason,
  DeadEndFlowRetryOutcome,
  DeadEndFlowState,
  DeadEndFlowTreatment,
} from "../../../../shared/dead-end-telemetry-contract";
import { renderView, wireRow } from "./test-helpers";

vi.mock("@repo/app/branches/components/branches-summary-cards", () => ({
  BranchesSummaryCards: () => null,
}));

vi.mock("@repo/app/shared/hooks/use-shared-date-range", () => ({
  useSharedDateRange: () => ({ dateRange: "all", setDateRange: vi.fn() }),
}));

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

const UNAVAILABLE_COPY = "Couldn't load branches";
const RETRY_BUTTON_NAME = /retry/i;

let listMock: ReturnType<typeof vi.fn<BranchesDataSource["list"]>>;
let recordDeadEndTelemetry: ReturnType<typeof vi.fn>;
let desktopApiDescriptor: PropertyDescriptor | undefined;

function makeDataSource(): BranchesDataSource {
  return {
    scope: "local",
    list: listMock,
    detail: () => new Promise<never>(() => undefined),
    comments: () => new Promise<never>(() => undefined),
    trace: () => Promise.resolve(unavailableBranchTraceResult()),
    usage: () => new Promise<BranchUsageSummary>(() => undefined),
    analytics: () => new Promise<BranchAnalytics>(() => undefined),
    pageData: async (filters) => ({
      list: await listMock(filters),
      analytics: makeBranchAnalytics(),
    }),
  };
}

/**
 * The shared provider stack, with retries off and no infinite `staleTime` — the
 * suite drives a read that must be able to re-run when Retry is pressed.
 */
function renderBranches(
  isActive = true,
  surfaceAnalyticsCapture?: SurfaceAnalyticsCapture,
  enabledFlags: string[] = []
) {
  return renderView(
    makeDataSource(),
    new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    enabledFlags,
    "/branches",
    isActive,
    undefined,
    surfaceAnalyticsCapture
  );
}

function resolveWith(items: (typeof wireRow)[]) {
  listMock.mockImplementation(() =>
    Promise.resolve({
      items,
      total: items.length,
      viewerScope: BranchViewerScope.Self,
    })
  );
}

function recordedPayloads() {
  return recordDeadEndTelemetry.mock.calls.map(([payload]) => payload);
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock = vi.fn();
  recordDeadEndTelemetry = vi.fn().mockResolvedValue({ ok: true });
  desktopApiDescriptor = Object.getOwnPropertyDescriptor(window, "desktopApi");
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { onDbChanged: vi.fn(() => undefined), recordDeadEndTelemetry },
  });
});

afterEach(() => {
  cleanup();
  if (desktopApiDescriptor) {
    Object.defineProperty(window, "desktopApi", desktopApiDescriptor);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
  desktopApiDescriptor = undefined;
});

describe("Branches list dead-end telemetry, real tree (ISS-9725)", () => {
  it("reports a failed read to the preload reporter as unavailable", async () => {
    listMock.mockRejectedValue(new ApiError("branches unavailable", 503));

    renderBranches();

    expect(await screen.findByText(UNAVAILABLE_COPY)).toBeTruthy();
    await waitFor(() => expect(recordDeadEndTelemetry).toHaveBeenCalled());
    expect(recordedPayloads()).toContainEqual({
      treatment: DeadEndFlowTreatment.BranchesListUnavailable,
      state: DeadEndFlowState.Unavailable,
      reason: DeadEndFlowReason.FetchFailed,
      retryOffered: true,
      httpStatus: 503,
      phase: DeadEndFlowPhase.Rendered,
      retryAttempt: 0,
    });
  });

  it("reports a 403 as permission_denied, carrying the status", async () => {
    listMock.mockRejectedValue(new ApiError("forbidden", 403));

    renderBranches();

    expect(await screen.findByText(UNAVAILABLE_COPY)).toBeTruthy();
    await waitFor(() => expect(recordDeadEndTelemetry).toHaveBeenCalled());
    expect(recordedPayloads()).toContainEqual(
      expect.objectContaining({
        treatment: DeadEndFlowTreatment.BranchesListUnavailable,
        reason: DeadEndFlowReason.PermissionDenied,
        httpStatus: 403,
      })
    );
  });

  it("reports a genuinely empty org as a different record from a failure", async () => {
    resolveWith([]);

    renderBranches();

    await waitFor(() => expect(recordDeadEndTelemetry).toHaveBeenCalled());
    const payloads = recordedPayloads();
    // The positive: an empty org IS reported, as its own treatment/state…
    expect(payloads).toContainEqual(
      expect.objectContaining({
        treatment: DeadEndFlowTreatment.BranchesListEmpty,
        state: DeadEndFlowState.TrueZero,
        reason: DeadEndFlowReason.Absent,
      })
    );
    // …and the sibling negative it exists to guarantee: never as the failure.
    expect(payloads).not.toContainEqual(
      expect.objectContaining({
        treatment: DeadEndFlowTreatment.BranchesListUnavailable,
      })
    );
  });

  it("reports nothing once rows are on screen", async () => {
    resolveWith([wireRow]);

    renderBranches();

    // The paired positive: the rows really did render, so the silence below is
    // "no dead end" and not "the tree never mounted".
    expect(await screen.findByText(wireRow.branchName)).toBeTruthy();
    expect(recordDeadEndTelemetry).not.toHaveBeenCalled();
  });

  it("withholds the record while the panel is mounted but not on screen", async () => {
    listMock.mockRejectedValue(new ApiError("branches unavailable", 503));

    const view = renderBranches(false);

    // The read itself is gated (ISS-8055), so a hidden panel never reaches a
    // treatment at all — assert on the sink, which is the contract that matters.
    await waitFor(() => expect(listMock).not.toHaveBeenCalled());
    expect(recordDeadEndTelemetry).not.toHaveBeenCalled();

    // The paired positive: the SAME instance, shown, does read and does report.
    view.setActive(true);
    expect(await screen.findByText(UNAVAILABLE_COPY)).toBeTruthy();
    await waitFor(() =>
      expect(recordedPayloads()).toContainEqual(
        expect.objectContaining({
          treatment: DeadEndFlowTreatment.BranchesListUnavailable,
          phase: DeadEndFlowPhase.Rendered,
        })
      )
    );
  });

  it("does not let a hidden panel keep reading behind the reader", async () => {
    // The case the `isActive` read gate exists for. `useDeadEndTelemetry`
    // deliberately leaves its dedupe key untouched while hidden, so a read that
    // could recover and re-fail out of sight would come back carrying the
    // already-emitted key and have the treatment the reader is looking at
    // swallowed as a duplicate. Freezing the read is what prevents that.
    listMock.mockRejectedValue(new ApiError("branches unavailable", 503));
    const view = renderBranches(true);

    expect(await screen.findByText(UNAVAILABLE_COPY)).toBeTruthy();
    await waitFor(() =>
      expect(recordDeadEndTelemetry).toHaveBeenCalledTimes(1)
    );
    const readsWhileVisible = listMock.mock.calls.length;

    view.setActive(false);
    // A source that would answer differently if it were asked at all.
    resolveWith([wireRow]);
    await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
    expect(listMock.mock.calls.length).toBe(readsWhileVisible);

    // The paired positive: shown again, the same instance DOES ask, and picks
    // up the answer that changed while it was not looking.
    view.setActive(true);
    expect(await screen.findByText(wireRow.branchName)).toBeTruthy();
    expect(listMock.mock.calls.length).toBeGreaterThan(readsWhileVisible);
  });

  it("tracks the Retry the unavailable treatment actually renders", async () => {
    listMock.mockRejectedValue(new ApiError("branches unavailable", 503));

    renderBranches();
    expect(await screen.findByText(UNAVAILABLE_COPY)).toBeTruthy();
    await waitFor(() => expect(recordDeadEndTelemetry).toHaveBeenCalled());

    resolveWith([wireRow]);
    fireEvent.click(screen.getByRole("button", { name: RETRY_BUTTON_NAME }));

    expect(await screen.findByText(wireRow.branchName)).toBeTruthy();
    await waitFor(() =>
      expect(recordedPayloads()).toContainEqual(
        expect.objectContaining({
          phase: DeadEndFlowPhase.RetrySettled,
          retryOutcome: DeadEndFlowRetryOutcome.Recovered,
          retryAttempt: 1,
        })
      )
    );
    expect(recordedPayloads()).toContainEqual(
      expect.objectContaining({
        phase: DeadEndFlowPhase.RetryAttempted,
        treatment: DeadEndFlowTreatment.BranchesListUnavailable,
        retryAttempt: 1,
      })
    );
  });
});

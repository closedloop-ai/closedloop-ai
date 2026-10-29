import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalsPanel } from "../ApprovalsPanel";
import {
  installApprovalsApi,
  PENDING_APPROVAL,
  restoreDesktopApi,
} from "./install-approvals-api";

const REFRESH_BUTTON_LABEL = "Refresh";

/**
 * Four branches `approvals-panel.test.tsx` and
 * `approvals-panel-busy-state.test.tsx` do not reach — every one of them is a
 * `cancelled.current` guard (ApprovalsPanel.tsx L56, L74, L81, L104). A real
 * unmount cannot prove any of them did anything: React already refuses to
 * commit a setState on an unmounted tree with or without the guard. Replacing
 * the hook with a ref this file flips itself, while the component stays
 * mounted, is the only way to observe each guard's own effect on rendered
 * output — same technique as `activity-panel.coverage.test.tsx`.
 */

const cancelledRefState = vi.hoisted(() => ({ current: false }));
vi.mock("../../../hooks/use-cancelled-ref", () => ({
  useCancelledRef: () => cancelledRefState,
}));

beforeEach(() => {
  cancelledRefState.current = false;
});

afterEach(() => {
  cancelledRefState.current = false;
  restoreDesktopApi();
});

describe("ApprovalsPanel — a settled read dropped once cancelled", () => {
  it("does not commit pending approvals once the cancelled ref is set (L74)", async () => {
    let releaseApprovals: ((value: unknown[]) => void) | undefined;
    installApprovalsApi({
      overrides: {
        getPendingApprovals: vi.fn(
          () =>
            new Promise((resolve) => {
              releaseApprovals = resolve;
            })
        ),
      },
    });
    render(<ApprovalsPanel />);

    cancelledRefState.current = true;
    await act(async () => {
      releaseApprovals?.([PENDING_APPROVAL]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText(PENDING_APPROVAL.reason)).toBeNull();
  });

  it("leaves the loading state up once cancelled, instead of clearing it (L81)", async () => {
    let releaseApprovals: ((value: unknown[]) => void) | undefined;
    installApprovalsApi({
      overrides: {
        getPendingApprovals: vi.fn(
          () =>
            new Promise((resolve) => {
              releaseApprovals = resolve;
            })
        ),
      },
    });
    render(<ApprovalsPanel />);
    expect(screen.getByText("Loading approvals...")).toBeTruthy();

    cancelledRefState.current = true;
    await act(async () => {
      releaseApprovals?.([]);
      await Promise.resolve();
      await Promise.resolve();
    });

    // `setLoading(false)` is gated by the same guard as the approvals commit
    // above — cancelled mid-flight, the panel is stuck announcing a load that
    // will never finish rather than falling through to the empty state.
    expect(screen.getByText("Loading approvals...")).toBeTruthy();
    expect(screen.queryByText("No pending approvals")).toBeNull();
  });

  it("does not commit always-allow rules once the cancelled ref is set (L56)", async () => {
    let releaseSettings:
      | ((value: { alwaysAllowRules: unknown[] }) => void)
      | undefined;
    installApprovalsApi({
      overrides: {
        getSettings: vi.fn(
          () =>
            new Promise((resolve) => {
              releaseSettings = resolve;
            })
        ),
      },
    });
    render(<ApprovalsPanel />);

    cancelledRefState.current = true;
    await act(async () => {
      releaseSettings?.({
        alwaysAllowRules: [{ id: "rule-1", method: "GET", path: "/x" }],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText("GET /x")).toBeNull();
  });

  it("leaves the Refresh control stuck reporting busy once cancelled mid-action (L104)", async () => {
    let releaseApprovals: ((value: unknown[]) => void) | undefined;
    const api = installApprovalsApi({ approvals: [PENDING_APPROVAL] });
    render(<ApprovalsPanel />);
    await screen.findByText(PENDING_APPROVAL.reason);

    api.getPendingApprovals.mockReturnValue(
      new Promise((resolve) => {
        releaseApprovals = resolve;
      })
    );
    fireEvent.click(screen.getByRole("button", { name: REFRESH_BUTTON_LABEL }));
    await screen.findByRole("button", { name: "Refreshing..." });

    cancelledRefState.current = true;
    await act(async () => {
      releaseApprovals?.([PENDING_APPROVAL]);
      await Promise.resolve();
      await Promise.resolve();
    });

    // `setRefreshing(false)` in `runUserAction`'s `finally` is gated by the
    // same guard — cancelled mid-action, the control never reports idle again.
    expect(screen.getByRole("button", { name: "Refreshing..." })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: REFRESH_BUTTON_LABEL })
    ).toBeNull();
  });
});

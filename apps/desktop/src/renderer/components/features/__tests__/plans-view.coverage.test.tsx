import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlansView } from "../PlansView";

/**
 * Four branches with no existing coverage (PlansView.tsx L76, L112, L129,
 * L185). `LightPlansShell` and `useQueryCache` are mocked so the wrapper's own
 * branching is observable without the real shared shell or a live cache/IPC
 * stack — the marker exposes the exact props the wrapper computed.
 */

const plansListState = vi.hoisted(() => ({
  data: [] as unknown[] | null,
  loading: false,
  error: false,
}));

vi.mock("../../../hooks/useQueryCache", () => ({
  useQueryCache: vi.fn((key: string) => {
    if (key === "db:plans-list") {
      return plansListState;
    }
    return { data: [], loading: false, error: false };
  }),
  invalidateCache: vi.fn(),
}));

type LightPlansShellMockProps = {
  isLoading: boolean;
  actionError: { planId: string; action: string; message: string } | null;
  pendingAction: { planId: string; action: string } | null;
  onSelectPlan: (id: string) => void;
  onConfirmPlan: (id: string) => void;
  onRejectPlan: (id: string) => void;
};

vi.mock("@repo/app/agents/components/plans/light-plans-shell", () => ({
  getLightPlanStatusLabel: (status: string) => status,
  resolveLightPlanConfirmationState: () => "none",
  LightPlansShell: (props: LightPlansShellMockProps) => (
    <div>
      <span data-testid="is-loading">{String(props.isLoading)}</span>
      <span data-testid="action-error">
        {props.actionError
          ? `${props.actionError.planId}:${props.actionError.action}:${props.actionError.message}`
          : "none"}
      </span>
      <span data-testid="pending-action">
        {props.pendingAction
          ? `${props.pendingAction.planId}:${props.pendingAction.action}`
          : "none"}
      </span>
      <button onClick={() => props.onSelectPlan("p1")} type="button">
        select-p1
      </button>
      <button onClick={() => props.onSelectPlan("p2")} type="button">
        select-p2
      </button>
      <button onClick={() => props.onConfirmPlan("p1")} type="button">
        confirm-p1
      </button>
      <button onClick={() => props.onRejectPlan("p2")} type="button">
        reject-p2
      </button>
    </div>
  ),
}));

let resolveConfirm: (() => void) | undefined;
let rejectConfirm: ((error: Error) => void) | undefined;
let resolveReject: (() => void) | undefined;
let rejectReject: ((error: Error) => void) | undefined;

const confirmPlan = vi.fn(
  () =>
    new Promise<void>((resolve, reject) => {
      resolveConfirm = resolve;
      rejectConfirm = reject;
    })
);
const rejectPlan = vi.fn(
  () =>
    new Promise<void>((resolve, reject) => {
      resolveReject = resolve;
      rejectReject = reject;
    })
);

beforeEach(() => {
  Object.assign(plansListState, { data: [], loading: false, error: false });
  confirmPlan.mockClear();
  rejectPlan.mockClear();
  resolveConfirm = undefined;
  rejectConfirm = undefined;
  resolveReject = undefined;
  rejectReject = undefined;
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      db: {
        confirmPlan,
        getPlanVersions: vi.fn(async () => []),
        getPlansList: vi.fn(async () => []),
        rejectPlan,
      },
    },
  });
});

describe("PlansView — stale action error on re-select (L76)", () => {
  it("keeps the action error when re-selecting the plan it belongs to, clears it for a different plan", async () => {
    render(<PlansView />);

    fireEvent.click(screen.getByRole("button", { name: "confirm-p1" }));
    rejectConfirm?.(new Error("boom"));
    await waitFor(() =>
      expect(screen.getByTestId("action-error").textContent).toBe(
        "p1:confirm:Plan confirmation failed. Try again."
      )
    );

    // Re-selecting the SAME plan the error belongs to must not discard it.
    fireEvent.click(screen.getByRole("button", { name: "select-p1" }));
    expect(screen.getByTestId("action-error").textContent).toBe(
      "p1:confirm:Plan confirmation failed. Try again."
    );

    // Selecting a DIFFERENT plan clears a stale error that belongs to p1.
    fireEvent.click(screen.getByRole("button", { name: "select-p2" }));
    expect(screen.getByTestId("action-error").textContent).toBe("none");
  });
});

describe("PlansView — per-action error copy (L185)", () => {
  it("reports the reject-specific message on a failed reject", async () => {
    render(<PlansView />);

    fireEvent.click(screen.getByRole("button", { name: "reject-p2" }));
    rejectReject?.(new Error("boom"));

    await waitFor(() =>
      expect(screen.getByTestId("action-error").textContent).toBe(
        "p2:reject:Plan rejection failed. Try again."
      )
    );
  });
});

describe("PlansView — pending-action race between two plans (L112)", () => {
  it("does not clear a still-in-flight action for a different plan once an unrelated one settles", async () => {
    render(<PlansView />);

    fireEvent.click(screen.getByRole("button", { name: "confirm-p1" }));
    expect(screen.getByTestId("pending-action").textContent).toBe("p1:confirm");

    // A second in-flight action overwrites the tracked pending action.
    fireEvent.click(screen.getByRole("button", { name: "reject-p2" }));
    expect(screen.getByTestId("pending-action").textContent).toBe("p2:reject");

    // p1's confirm settling must NOT clear p2's still-in-flight reject.
    resolveConfirm?.();
    await waitFor(() => expect(confirmPlan).toHaveBeenCalledWith("p1"));
    expect(screen.getByTestId("pending-action").textContent).toBe("p2:reject");

    // p2's own reject settling clears it — the matching case.
    resolveReject?.();
    await waitFor(() =>
      expect(screen.getByTestId("pending-action").textContent).toBe("none")
    );
  });
});

describe("PlansView — isLoading derivation (L129)", () => {
  it("reports not-loading once cached plans exist, whether or not a background refresh is underway", () => {
    Object.assign(plansListState, {
      data: [{ id: "p1" }],
      loading: false,
      error: false,
    });
    const { unmount } = render(<PlansView />);
    expect(screen.getByTestId("is-loading").textContent).toBe("false");
    unmount();

    Object.assign(plansListState, {
      data: [{ id: "p1" }],
      loading: true,
      error: false,
    });
    render(<PlansView />);
    // `loading` is true, but cached `plans` are already present — the shell
    // must not re-announce a full loading state over cached content.
    expect(screen.getByTestId("is-loading").textContent).toBe("false");
  });
});

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalsPanel } from "../ApprovalsPanel";
import {
  installApprovalsApi,
  PENDING_APPROVAL,
  restoreDesktopApi,
} from "./install-approvals-api";

/**
 * ISS-5301: what the panel's controls report WHILE something is in flight, and
 * what the 3s background poll is allowed to do to them. Split out of
 * `approvals-panel.test.tsx`, which keeps the rendering and dispatch cases —
 * these all need a parked promise and a released one, and share nothing with a
 * test that just asserts a label.
 */

/** Matches the panel's own background re-read cadence. */
const POLL_INTERVAL_MS = 3000;

afterEach(restoreDesktopApi);

describe("ApprovalsPanel — busy state and background poll", () => {
  it("reports an in-flight Refresh on the control that started it", async () => {
    // The poll going quiet must not take the EXPLICIT controls' feedback with
    // it: `load` is Refresh's onClick and the reload tail of every action, and
    // once it stops re-raising `loading` there is nothing else in this panel
    // that answers a click. Parked mid-read for the same reason as above — an
    // instant read never paints the busy state.
    let releaseRead: (() => void) | undefined;
    let parkNextRead = false;
    installApprovalsApi({
      overrides: {
        getPendingApprovals: vi.fn(async () => {
          if (parkNextRead) {
            parkNextRead = false;
            await new Promise<void>((resolve) => {
              releaseRead = resolve;
            });
          }
          return [PENDING_APPROVAL];
        }),
      },
    });
    try {
      render(<ApprovalsPanel />);
      const deny = await screen.findByRole("button", { name: "Deny" });

      parkNextRead = true;
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
        // Let `refresh` run as far as the parked read before asserting.
        await Promise.resolve();
      });

      // The button itself says a read is running, and refuses a second one.
      const busy = screen.getByRole("button", { name: "Refreshing..." });
      expect((busy as HTMLButtonElement).disabled).toBe(true);
      expect(
        (
          screen.getByRole("button", {
            name: "Clear Queue",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(true);
      // …and buying that feedback must not buy back the teardown: the queue is
      // still the same mounted node it was before the click.
      expect(screen.getByRole("button", { name: "Deny" })).toBe(deny);

      await act(async () => {
        releaseRead?.();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
      });
    } finally {
      releaseRead?.();
    }
  });

  it("refuses every decision control while a decision is still in flight", async () => {
    // The MUTATION is the half the busy state used to skip — the flag was raised
    // only around the reload that ran AFTER it. Not because it is the slow half:
    // it resolves a promise the gateway is already parked on and returns, one
    // round trip like the read. It is that it CHANGES the store, so every moment
    // after it is one where the queue on screen is already stale. That is why the
    // decision is parked here rather than the read: a panel that reports only its
    // reload leaves all three of these enabled at this point, and the seconds
    // after a click look exactly like the seconds before it.
    let releaseDeny: (() => void) | undefined;
    const api = installApprovalsApi({
      approvals: [PENDING_APPROVAL],
      overrides: {
        denyApproval: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              releaseDeny = resolve;
            })
        ),
      },
    });
    try {
      render(<ApprovalsPanel />);
      await screen.findByText(PENDING_APPROVAL.reason);

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Deny" }));
        await Promise.resolve();
      });
      expect(api.denyApproval).toHaveBeenCalledWith(PENDING_APPROVAL.id);

      // The card is still on screen unchanged — the reload has not run — so a
      // user who mis-clicked is looking at the same row and the same controls.
      // Every one that could take a SECOND decision on it has to refuse, or the
      // correcting click resolves nothing and reads exactly like a success.
      for (const name of ["Approve", "Deny", "Always Allow"]) {
        expect(
          (screen.getByRole("button", { name }) as HTMLButtonElement).disabled
        ).toBe(true);
      }
      expect(
        (
          screen.getByRole("button", {
            name: "Refreshing...",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(true);

      await act(async () => {
        releaseDeny?.();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(
          (screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement)
            .disabled
        ).toBe(false);
      });
    } finally {
      releaseDeny?.();
    }
  });

  it("still reloads and re-enables the controls when the decision IPC rejects", async () => {
    // The other decision cases all resolve, which left the THROW path — a
    // gateway that is gone, or a request the store already dropped — covered
    // nowhere. `decide` swallows that rejection precisely so the reload behind
    // it STILL RUNS ("reload will pick up current state"), which is the only
    // thing that reconciles the queue on screen with a store the failed decision
    // may already have moved. Drop that `catch` and the rejection escapes before
    // `load()`, stranding the panel on a queue it has no way to correct — so the
    // re-read assertion below is the one that holds it, not the re-enable.
    let rejectDeny: ((error: Error) => void) | undefined;
    const api = installApprovalsApi({
      approvals: [PENDING_APPROVAL],
      overrides: {
        denyApproval: vi.fn(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectDeny = reject;
            })
        ),
      },
    });
    try {
      render(<ApprovalsPanel />);
      await screen.findByText(PENDING_APPROVAL.reason);
      const readsBefore = api.getPendingApprovals.mock.calls.length;

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Deny" }));
        await Promise.resolve();
      });
      expect(api.denyApproval).toHaveBeenCalledWith(PENDING_APPROVAL.id);
      // Precondition, so the re-enable below is a transition and not a control
      // that was never disabled in the first place.
      expect(
        (screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement)
          .disabled
      ).toBe(true);

      await act(async () => {
        rejectDeny?.(new Error("gateway is gone"));
        await Promise.resolve();
      });

      // The failed decision is followed by a real re-read, not abandoned.
      await waitFor(() => {
        expect(api.getPendingApprovals.mock.calls.length).toBeGreaterThan(
          readsBefore
        );
      });
      // And the panel comes back actionable rather than stranding every control
      // disabled with no error on screen and no way back but a reload.
      await waitFor(() => {
        for (const name of ["Approve", "Deny", "Always Allow"]) {
          expect(
            (screen.getByRole("button", { name }) as HTMLButtonElement).disabled
          ).toBe(false);
        }
      });
      expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
    } finally {
      rejectDeny?.(new Error("test teardown"));
    }
  });

  it("refuses a second revoke while the first is still in flight", async () => {
    // `handleRevokeRule` is the sixth user-initiated path, and the one that
    // never reached the busy state at all: it reloaded only the rules list, so
    // its control answered a click with nothing at any point in the action.
    let releaseRevoke: (() => void) | undefined;
    const api = installApprovalsApi({
      overrides: {
        removeAlwaysAllowRule: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              releaseRevoke = resolve;
            })
        ),
      },
      rules: [{ id: "rule-1", method: "POST", path: "/api/gateway/exec" }],
    });
    try {
      render(<ApprovalsPanel />);
      const revoke = await screen.findByRole("button", { name: "Revoke" });

      await act(async () => {
        fireEvent.click(revoke);
        await Promise.resolve();
      });
      expect(api.removeAlwaysAllowRule).toHaveBeenCalledWith("rule-1");
      expect((revoke as HTMLButtonElement).disabled).toBe(true);

      await act(async () => {
        releaseRevoke?.();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(
          (screen.getByRole("button", { name: "Revoke" }) as HTMLButtonElement)
            .disabled
        ).toBe(false);
      });
    } finally {
      releaseRevoke?.();
    }
  });

  it("keeps each queued request's controls mounted and live while a background poll is still in flight", async () => {
    // The read has to be IN FLIGHT for this to mean anything: an instant read
    // resolves inside the same commit, so React never paints the intermediate
    // state and the regression hides. A slow read is also the only condition
    // under which the bug was reachable — on a loaded machine the gateway read
    // takes long enough to paint.
    let releasePoll: (() => void) | undefined;
    let reads = 0;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      installApprovalsApi({
        overrides: {
          getPendingApprovals: vi.fn(async () => {
            reads++;
            if (reads > 1) {
              await new Promise<void>((resolve) => {
                releasePoll = resolve;
              });
            }
            return [PENDING_APPROVAL];
          }),
        },
      });
      render(<ApprovalsPanel />);
      const denyBeforePoll = await screen.findByRole("button", {
        name: "Deny",
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      });
      expect(reads).toBeGreaterThan(1);

      // The panel re-reads, but the request the user is reaching for has to
      // survive that read. Re-raising the loading treatment on the poll swapped
      // the whole pending list out for the loading text, so a pointer already
      // travelling to Deny landed on a button that had been torn out mid-gesture.
      expect(screen.queryByText("Loading approvals...")).toBeNull();
      expect(screen.getByRole("button", { name: "Deny" })).toBe(denyBeforePoll);
      // Surviving is not enough — it has to still WORK. The poll is not a user
      // action and owes no busy state, so routing its `load()` through
      // `runUserAction` would leave every decision control dead for the length of
      // each read, on a 3s cycle, with the node identity above still intact.
      expect((denyBeforePoll as HTMLButtonElement).disabled).toBe(false);
    } finally {
      releasePoll?.();
      vi.useRealTimers();
    }
  });
});

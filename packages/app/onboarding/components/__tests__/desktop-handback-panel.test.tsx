import { DESKTOP_DEEP_LINK_URL } from "@repo/api/src/types/desktop-deep-link";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopHandbackPanel } from "../desktop-handback-panel";

/**
 * ISS-11429 operator scope — the browser half of the post-auth hand-back.
 *
 * Two contracts these cases exist to hold:
 *
 *  1. The four-state detection model is NOT collapsed into a running-or-download
 *     branch. `DesktopUndetectedNotice` exists to prevent exactly that, and its
 *     rule is that a stopped probe must never render as a proven negative it did
 *     not establish — so "still sweeping" and "we looked and did not find it"
 *     must render differently, and only the latter carries the control.
 *  2. Firing `closedloop://` is unobservable from the browser, so no state here
 *     may claim the launch succeeded or failed.
 */

const OPEN_BUTTON = /open the desktop app/i;
const OPENING_BUTTON = /opening the desktop app/i;
// DISJOINT on purpose. The ruled copy (2026-09-28) puts "is running" in the
// UNANSWERED sentence, so the old `/desktop app is running/i` matcher would now
// match the unanswered state while claiming to pin the ready one — a matcher
// that passes on the very string it exists to tell apart. Each of these two
// appears in exactly one of the two sentences.
const IN_BACKGROUND = /running in the background/i;
const READY_COPY = /pick up where you left off in the desktop app/i;
const CHECK_AGAIN = /check again/i;

const detectionState = vi.hoisted(() => ({
  detected: false,
  exhausted: false,
  version: null as string | null,
}));
const rearmMock = vi.hoisted(() => vi.fn());
const detectionCalls = vi.hoisted(() => [] as unknown[][]);
vi.mock("@repo/shared-platform/detection-store", () => ({
  isGatewayDetectionExhausted: () => detectionState.exhausted,
  rearmGatewayDetection: rearmMock,
  // Records its arguments: the poll MODE decides the probe budget that
  // `isGatewayDetectionExhausted` reads, so an argument-blind mock would let the
  // default loop be requested here and still report the four-state model intact.
  useGatewayDetection: (...args: unknown[]) => {
    detectionCalls.push(args);
    return {
      checkedAt: 1,
      detected: detectionState.detected,
      loading: false,
      version: detectionState.version,
    };
  },
}));

const openDesktopAppMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/desktop-deep-link-navigation", () => ({
  openDesktopApp: openDesktopAppMock,
}));

beforeEach(() => {
  vi.useFakeTimers();
  detectionState.detected = false;
  detectionState.exhausted = false;
  detectionState.version = null;
  rearmMock.mockClear();
  openDesktopAppMock.mockClear();
  detectionCalls.length = 0;
});

// Unconditional, so a throwing assertion cannot leak a frozen clock into the
// rest of this worker.
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DesktopHandbackPanel — the detection poll it asks for", () => {
  it("asks for the intentful poll, which is what the exhausted state is read against", () => {
    render(<DesktopHandbackPanel />);

    // Dropping `{ fastPoll: true }` silently swaps the probe budget for the
    // default one, so the panel reaches "we looked and did not find it" after
    // far fewer sweeps — the four-state collapse this file exists to prevent.
    expect(detectionCalls[0]).toEqual([true, { fastPoll: true }]);
  });
});

describe("DesktopHandbackPanel — a detected desktop", () => {
  beforeEach(() => {
    detectionState.detected = true;
    detectionState.version = "1.2.3";
  });

  // Absence and presence on the SAME locators, one case apart: the first two
  // cases below assert the button and the sentence are missing and then present,
  // so neither can pass on a locator that never resolves.
  it("asks nothing of the user while the hand-back may still land", () => {
    const { container } = render(<DesktopHandbackPanel />);

    // Operator ruling 2026-09-28: the happy path takes no user action. The
    // desktop brings itself forward off the loopback callback, so there is
    // nothing to offer for it and a control here would be the defect.
    expect(container.firstChild).toBeNull();
    expect(
      screen.queryByRole("button", { name: OPEN_BUTTON })
    ).not.toBeInTheDocument();
  });

  it("opens the panel only once the bound elapses with this tab still in front", () => {
    render(<DesktopHandbackPanel />);
    act(() => {
      vi.advanceTimersByTime(6500);
    });

    expect(screen.getByText(IN_BACKGROUND)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: OPEN_BUTTON })).toBeEnabled();
  });

  it("never auto-fires the scheme, on mount or on any poll", () => {
    const { rerender } = render(<DesktopHandbackPanel />);
    act(() => {
      vi.advanceTimersByTime(6500);
    });
    rerender(<DesktopHandbackPanel />);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    // Browsers gate external-protocol navigation behind a user gesture and drop
    // an ungated one SILENTLY — no error, no event — so an auto-fire would be
    // indistinguishable from one that worked, on a scheme that is already
    // unobservable. The click is the only fire, and it happens once.
    expect(openDesktopAppMock).not.toHaveBeenCalled();
  });

  it("never opens the panel when the tab hides, which is the hand-back working", () => {
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("visible");
    const { rerender } = render(<DesktopHandbackPanel />);

    visibility.mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(5000);
    });
    rerender(<DesktopHandbackPanel />);
    visibility.mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(60_000);
    });

    // TERMINAL. Returning to the tab must not resurrect a failure panel for a
    // hand-back that landed, however long the user stays.
    expect(screen.queryByText(IN_BACKGROUND)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: OPEN_BUTTON })
    ).not.toBeInTheDocument();
  });

  it("fires the payload-free deep link and nothing else", () => {
    render(<DesktopHandbackPanel />);
    act(() => {
      vi.advanceTimersByTime(6500);
    });
    fireEvent.click(screen.getByRole("button", { name: OPEN_BUTTON }));

    // The bare scheme, asserted through the shared constant. The desktop's
    // validator denies any host, path, query or fragment by default, so a link
    // carrying walkthrough state would be refused outright — the run resumes
    // from the state the desktop already holds.
    expect(openDesktopAppMock).toHaveBeenCalledTimes(1);
    expect(DESKTOP_DEEP_LINK_URL).toBe("closedloop://");
  });

  it("reports only that it is waiting, never that it worked", () => {
    render(<DesktopHandbackPanel />);
    act(() => {
      vi.advanceTimersByTime(6500);
    });
    fireEvent.click(screen.getByRole("button", { name: OPEN_BUTTON }));

    const button = screen.getByRole("button", { name: OPENING_BUTTON });
    expect(button).toBeDisabled();
    expect(screen.getByText(READY_COPY)).toBeInTheDocument();
    expect(screen.queryByText(IN_BACKGROUND)).not.toBeInTheDocument();
  });

  it("says the app is in the background once the click's own bound elapses, not that it failed", () => {
    render(<DesktopHandbackPanel />);
    act(() => {
      vi.advanceTimersByTime(6500);
    });
    fireEvent.click(screen.getByRole("button", { name: OPEN_BUTTON }));
    act(() => {
      vi.advanceTimersByTime(6500);
    });

    expect(screen.getByText(IN_BACKGROUND)).toBeInTheDocument();
    // An honest sentence in this state: `detection.detected` is what got the
    // component past its early return, so "is running" is established, and "in
    // the background" is exactly what the elapsed bound observed.
    // Re-offered rather than dead-ended: the browser never established that the
    // launch failed, so the control it had must not be withdrawn.
    expect(screen.getByRole("button", { name: OPEN_BUTTON })).toBeEnabled();
  });
});

describe("DesktopHandbackPanel — the verdict survives the detected poll loop", () => {
  beforeEach(() => {
    detectionState.detected = true;
  });

  // The detected store re-probes on its own cadence and every snapshot
  // re-renders this component. Both cases drive that re-render, and assert the
  // SAME locator in opposite directions.
  it("still reaches the verdict when a poll snapshot lands inside the bound", () => {
    const { rerender } = render(<DesktopHandbackPanel />);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    rerender(<DesktopHandbackPanel />);
    act(() => {
      vi.advanceTimersByTime(1500);
    });

    // A dep that changes per render re-arms a fresh 6s bound on every poll, so
    // the panel never opens on a tab the user is watching — the failure mode
    // becomes invisible rather than late.
    expect(screen.getByText(IN_BACKGROUND)).toBeInTheDocument();
  });

  it("retires an open attempt when the tab hides, and does not revive it on return", () => {
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("visible");
    const { rerender } = render(<DesktopHandbackPanel />);
    act(() => {
      vi.advanceTimersByTime(6500);
    });
    fireEvent.click(screen.getByRole("button", { name: OPEN_BUTTON }));
    expect(screen.getByText(READY_COPY)).toBeInTheDocument();

    visibility.mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(5000);
    });
    // A poll snapshot while hidden — this is what re-armed a fresh bound.
    rerender(<DesktopHandbackPanel />);
    visibility.mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(6500);
    });

    // Hiding IS the hand-back landing, so the whole panel retires rather than
    // flipping to a sentence telling the user to switch to an app that already
    // came forward.
    expect(screen.queryByText(IN_BACKGROUND)).not.toBeInTheDocument();
    expect(screen.queryByText(READY_COPY)).not.toBeInTheDocument();
  });
});

describe("DesktopHandbackPanel — the four-state detection model", () => {
  it("renders 'still looking' without a control while the probe is running", () => {
    render(<DesktopHandbackPanel />);

    // The collapse this guards against would show the terminal not-found state
    // (and its control) the moment detection reported not-detected, which it has
    // done here without having stopped probing.
    expect(
      screen.queryByRole("button", { name: CHECK_AGAIN })
    ).not.toBeInTheDocument();
  });

  it("offers 'Check again' only once the probe has actually stopped", () => {
    detectionState.exhausted = true;
    render(<DesktopHandbackPanel />);

    expect(
      screen.getByRole("button", { name: CHECK_AGAIN })
    ).toBeInTheDocument();
  });

  it("re-arms the store's probe on an explicit re-check", () => {
    detectionState.exhausted = true;
    render(<DesktopHandbackPanel />);
    fireEvent.click(screen.getByRole("button", { name: CHECK_AGAIN }));

    // Asserting the production call, not just that a phase changed: a re-check
    // that shows feedback without restarting the probe is the false-green shape.
    expect(rearmMock).toHaveBeenCalledTimes(1);
  });

  it("charges the re-check to the user, not to the passive re-arm budget", () => {
    detectionState.exhausted = true;
    render(<DesktopHandbackPanel />);
    fireEvent.click(screen.getByRole("button", { name: CHECK_AGAIN }));

    // The store counts an un-flagged call against `rearmAttempts`, which doubles
    // the focus/visibility debounce toward its 30-minute cap. Clicking this
    // button more often would then make a later automatic re-check arrive LATER,
    // so the flag is the contract and the bare call is the defect.
    expect(rearmMock).toHaveBeenCalledWith({ userInitiated: true });
  });

  it("never offers the desktop action while nothing was detected", () => {
    detectionState.exhausted = true;
    render(<DesktopHandbackPanel />);

    expect(
      screen.queryByRole("button", { name: OPEN_BUTTON })
    ).not.toBeInTheDocument();
  });
});

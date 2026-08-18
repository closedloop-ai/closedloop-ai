import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../../shared/local-session-source-status";
import { useLocalSessionSourceStatus } from "../sessions-view-source-status";

/**
 * ISS-4840: the local-source probe must survive a TRANSIENT rejection without
 * lying about the source.
 *
 * ISS-4772 added a focus/visibility re-probe that calls the probe on every
 * focus/visibilitychange. Its catch set `unavailable` unconditionally, so a
 * single dropped `getAgentMonitorUrl` at focus time flipped a healthy `ready`
 * view to `unavailable` — zeroing rows/total and dashing the summary cards while
 * the cached rows sat right there.
 *
 * The contract these pin, in both directions:
 *  - a currently-`ready` source HOLDS `ready` through one rejection and
 *    adjudicates it with a bounded re-probe;
 *  - a source whose re-probe ALSO rejects still lands on `unavailable`, so a
 *    genuine breakage is never papered over;
 *  - a `starting` source — which has never proven itself — still downgrades on
 *    the first rejection, unchanged;
 *  - (codex review on PR #4266) overlapping probes are COALESCED, so the several
 *    triggers one return-to-window fires cannot spend the whole tolerance at
 *    once and defeat the hold.
 *
 * Time is pinned with fake timers because the bounded retry is a real delay.
 */

const RETRY_DELAY_MS = 750;

/**
 * Installs a `window.desktopApi` whose probe resolves/rejects on demand, and
 * returns the controls. `resolveReady()` makes every subsequent call resolve
 * "ready"; `rejectAll()` makes every subsequent call reject; `deferNext()` makes
 * the next call hang until `settleDeferred()` decides its outcome, which is how
 * the coalescing test holds a probe IN FLIGHT across two window events.
 */
function installProbe(): {
  probe: ReturnType<typeof vi.fn>;
  resolveReady: () => void;
  rejectAll: () => void;
  deferNext: () => void;
  settleDeferred: (outcome: "ready" | "reject") => void;
} {
  let mode: "ready" | "reject" | "defer" = "ready";
  let settlePending: ((outcome: "ready" | "reject") => void) | null = null;
  const readyPayload = {
    localSessionSourceStatus: LOCAL_SESSION_SOURCE_STATUSES.ready,
  };
  const probe = vi.fn(() => {
    if (mode === "defer") {
      // Stay pending: the effect sees a probe in flight for as long as the test
      // needs, which is the only way to reproduce two overlapping triggers.
      mode = "ready";
      return new Promise((resolve, reject) => {
        settlePending = (outcome) => {
          settlePending = null;
          if (outcome === "reject") {
            reject(new Error("probe failed"));
            return;
          }
          resolve(readyPayload);
        };
      });
    }
    if (mode === "reject") {
      return Promise.reject(new Error("probe failed"));
    }
    return Promise.resolve(readyPayload);
  });
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { getAgentMonitorUrl: probe, onDbChanged: vi.fn(() => undefined) },
  });
  return {
    deferNext: () => {
      mode = "defer";
    },
    probe,
    rejectAll: () => {
      mode = "reject";
    },
    resolveReady: () => {
      mode = "ready";
    },
    settleDeferred: (outcome) => {
      if (!settlePending) {
        throw new Error("settleDeferred called with no deferred probe pending");
      }
      settlePending(outcome);
    },
  };
}

let desktopApiDescriptor: PropertyDescriptor | undefined;

describe("useLocalSessionSourceStatus transient probe rejection (ISS-4840)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    desktopApiDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "desktopApi"
    );
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    if (desktopApiDescriptor) {
      Object.defineProperty(window, "desktopApi", desktopApiDescriptor);
    } else {
      Reflect.deleteProperty(window, "desktopApi");
    }
    desktopApiDescriptor = undefined;
  });

  it("holds the healthy ready status through a single transient rejection at focus time", async () => {
    const { probe, rejectAll } = installProbe();
    const { result } = renderHook(() => useLocalSessionSourceStatus());

    // Settle the mount probe: the source is genuinely up.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.status).toBe(LOCAL_SESSION_SOURCE_STATUSES.ready);
    const callsAfterMount = probe.mock.calls.length;

    // Return to the window while the probe is momentarily failing. Before
    // ISS-4840 this single rejection set `unavailable` and blanked the list.
    rejectAll();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    // Last-known-good holds — the view does not flip to a breakage state on one
    // dropped call, and a re-probe was actually attempted (not just swallowed).
    expect(result.current.status).toBe(LOCAL_SESSION_SOURCE_STATUSES.ready);
    expect(probe.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  it("recovers to ready when the bounded re-probe succeeds", async () => {
    const { rejectAll, resolveReady } = installProbe();
    const { result } = renderHook(() => useLocalSessionSourceStatus());
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.status).toBe(LOCAL_SESSION_SOURCE_STATUSES.ready);

    rejectAll();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    // The blip is over before the bounded retry fires.
    resolveReady();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    });

    // The retry landed a real read, so the status is ready on evidence — not
    // merely held over from before.
    expect(result.current.status).toBe(LOCAL_SESSION_SOURCE_STATUSES.ready);
  });

  it("still reports unavailable when the bounded re-probe also rejects", async () => {
    const { rejectAll } = installProbe();
    const { result } = renderHook(() => useLocalSessionSourceStatus());
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.status).toBe(LOCAL_SESSION_SOURCE_STATUSES.ready);

    // A PERSISTENT failure, not a blip: every call from here rejects.
    rejectAll();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(result.current.status).toBe(LOCAL_SESSION_SOURCE_STATUSES.ready);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    });

    // The tolerance is spent — a genuine breakage still surfaces with its error
    // chrome and Retry, one bounded round trip later. The fix must not hide it.
    expect(result.current.status).toBe(
      LOCAL_SESSION_SOURCE_STATUSES.unavailable
    );
  });

  it("counts one return-to-window as a single incident when focus and visibilitychange both reject", async () => {
    // codex review on PR #4266: restoring a minimized/occluded window fires
    // `focus` AND `visibilitychange` back to back, so one shared IPC hiccup
    // rejects BOTH probes. Counting per rejection, the tally hit 2 and the
    // second rejection set `unavailable` immediately — which re-ran the effect
    // and cleared the retry the first had just armed, so the view blanked
    // despite the tolerance that was supposed to protect it.
    const { rejectAll, resolveReady } = installProbe();
    const { result } = renderHook(() => useLocalSessionSourceStatus());
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.status).toBe(LOCAL_SESSION_SOURCE_STATUSES.ready);

    // Both return-to-window signals in one tick, both probes rejecting.
    rejectAll();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });

    // ONE incident: last-known-good holds rather than the pair burning the
    // whole tolerance between them.
    expect(result.current.status).toBe(LOCAL_SESSION_SOURCE_STATUSES.ready);

    // …and the bounded retry armed by that incident actually survived to
    // adjudicate it, instead of being torn down by a premature downgrade.
    resolveReady();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    });
    expect(result.current.status).toBe(LOCAL_SESSION_SOURCE_STATUSES.ready);
  });

  it("still issues a fresh probe while one is in flight, so a wedged mount probe can heal (ISS-4772)", async () => {
    // Guard on the fix above: coalescing the INCIDENT must not become
    // suppressing the PROBE. The ISS-4772 latch this re-probe exists to heal is
    // a mount `getAgentMonitorUrl` that never settles at all, so an in-flight
    // guard would make the focus re-probe a no-op and wedge the view forever.
    const { probe, deferNext } = installProbe();
    deferNext();
    const { result } = renderHook(() => useLocalSessionSourceStatus());
    await act(async () => {
      await Promise.resolve();
    });
    // The mount probe is stuck, so the source is latched on `starting`.
    expect(result.current.status).toBe(LOCAL_SESSION_SOURCE_STATUSES.starting);
    const callsWhileWedged = probe.mock.calls.length;

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    // A genuinely fresh read went out despite the wedged one still pending, and
    // it healed the latch.
    expect(probe.mock.calls.length).toBeGreaterThan(callsWhileWedged);
    expect(result.current.status).toBe(LOCAL_SESSION_SOURCE_STATUSES.ready);
  });

  it("downgrades a never-ready (starting) source on the first rejection", async () => {
    // Cold start: the source has never proven itself, so there is no
    // last-known-good to preserve and no reason to delay the honest state.
    const { rejectAll } = installProbe();
    rejectAll();
    const { result } = renderHook(() => useLocalSessionSourceStatus());

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.status).toBe(
      LOCAL_SESSION_SOURCE_STATUSES.unavailable
    );
  });
});

/**
 * ISS-7596 — pin the four states `useSessionLimits` exists to keep apart, the
 * refresh cadence it derives from the shared freshness constant, and the
 * teardown that stops it.
 *
 * ISS-5354 (#4572) established the contract at the Labs gate, but its only
 * touch on this hook is `expect(getSessionLimits).toHaveBeenCalled()` — a bare
 * call check that says nothing about what the hook returned. Every case below
 * asserts the RETURNED STATE instead, so collapsing LOADING into UNAVAILABLE
 * (the exact failure PRD-538 R6 exists to prevent) reddens here rather than
 * shipping as a bar that renders an honest-looking empty meter while the
 * snapshot is still in flight.
 */
import { SESSION_LIMIT_STALE_DISPLAY_AFTER_MS } from "@repo/app/session-limits/lib/freshness";
import {
  SESSION_LIMIT_SOURCES,
  SessionLimitsStatus,
} from "@repo/app/session-limits/types";
import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionLimitsSnapshot } from "../../../shared/session-limits-channel";
import { useSessionLimits } from "../use-session-limits";

/**
 * The cadence is DERIVED, never transcribed. Restating `150_000` here would
 * make this suite agree with a hook that had quietly stopped refreshing inside
 * the freshness horizon — the drift the hook's own comment exists to prevent.
 */
const EXPECTED_REFRESH_MS = SESSION_LIMIT_STALE_DISPLAY_AFTER_MS / 2;

const NOW = new Date("2026-08-22T12:00:00.000Z");

const SNAPSHOT: SessionLimitsSnapshot = {
  fiveHour: { utilization: 42, resetsAt: "2026-08-22T15:00:00.000Z" },
  sevenDay: { utilization: 70, resetsAt: "2026-08-24T12:00:00.000Z" },
  sevenDayOpus: null,
  sevenDaySonnet: null,
  extraUsage: null,
  fetchedAt: NOW.toISOString(),
  source: SESSION_LIMIT_SOURCES.UsageApi,
};

/** The response a cleaned-up effect must never be able to publish. */
const SUPERSEDED_SNAPSHOT: SessionLimitsSnapshot = {
  ...SNAPSHOT,
  fiveHour: { utilization: 99, resetsAt: "2026-08-22T15:00:00.000Z" },
};

describe("useSessionLimits — the four states it keeps distinct", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("stays LOADING while the snapshot is still in flight", async () => {
    // Never settles, so "still loading" is a settled fact about the hook rather
    // than a race with the microtask queue.
    installBridge(vi.fn(() => new Promise<SessionLimitsSnapshot | null>(noop)));

    const { result } = renderHook(() => useSessionLimits());

    expect(result.current.status).toBe(SessionLimitsStatus.Loading);

    // Still LOADING several refresh cycles later: an unresolved read is not a
    // resolved absence, no matter how long it takes.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXPECTED_REFRESH_MS * 3);
    });
    expect(result.current.status).toBe(SessionLimitsStatus.Loading);
  });

  it("resolves to READY carrying the snapshot it was handed", async () => {
    installBridge(vi.fn(() => Promise.resolve(SNAPSHOT)));

    const { result } = renderHook(() => useSessionLimits());
    await flushLoad();

    expect(result.current.status).toBe(SessionLimitsStatus.Ready);
    expect(result.current).toEqual({
      status: SessionLimitsStatus.Ready,
      limits: SNAPSHOT,
    });
  });

  it("keeps a measured zero READY rather than folding it into UNAVAILABLE", async () => {
    // PRD-538 R6: a genuine 0% is real data and renders as a real empty bar. It
    // is the one value most likely to be lost to a truthiness shortcut.
    const zeroed: SessionLimitsSnapshot = {
      ...SNAPSHOT,
      fiveHour: {
        utilization: 0,
        resetsAt: SNAPSHOT.fiveHour?.resetsAt ?? null,
      },
      sevenDay: null,
    };
    installBridge(vi.fn(() => Promise.resolve(zeroed)));

    const { result } = renderHook(() => useSessionLimits());
    await flushLoad();

    expect(result.current).toEqual({
      status: SessionLimitsStatus.Ready,
      limits: zeroed,
    });
  });

  it("resolves to UNAVAILABLE when there is no bridge at all", async () => {
    vi.stubGlobal("desktopApi", undefined);

    const { result } = renderHook(() => useSessionLimits());

    // Resolved on the spot, not after a round trip: a non-Electron mount must
    // not spin a skeleton forever.
    expect(result.current.status).toBe(SessionLimitsStatus.Unavailable);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXPECTED_REFRESH_MS * 2);
    });
    expect(result.current.status).toBe(SessionLimitsStatus.Unavailable);
  });

  it("resolves to UNAVAILABLE when the bridge is present but cannot serve limits", async () => {
    // A version-skewed preload: `desktopApi` exists, this member does not.
    vi.stubGlobal("desktopApi", {});

    const { result } = renderHook(() => useSessionLimits());

    expect(result.current.status).toBe(SessionLimitsStatus.Unavailable);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXPECTED_REFRESH_MS);
    });
    expect(result.current.status).toBe(SessionLimitsStatus.Unavailable);
  });

  it("resolves to UNAVAILABLE on a resolved-null snapshot", async () => {
    // The common case on a default macOS install (Keychain-only sign-in), not
    // an edge case.
    installBridge(vi.fn(() => Promise.resolve(null)));

    const { result } = renderHook(() => useSessionLimits());
    await flushLoad();

    expect(result.current.status).toBe(SessionLimitsStatus.Unavailable);
  });

  it("resolves to UNAVAILABLE when the call rejects", async () => {
    installBridge(
      vi.fn(() => Promise.reject(new Error("ipc handler unavailable")))
    );

    const { result } = renderHook(() => useSessionLimits());
    await flushLoad();

    expect(result.current.status).toBe(SessionLimitsStatus.Unavailable);
  });
});

describe("useSessionLimits — refresh cadence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("re-reads at half the display-freshness horizon, and not before", async () => {
    const getSessionLimits = vi.fn(() => Promise.resolve(SNAPSHOT));
    installBridge(getSessionLimits);

    const { result } = renderHook(() => useSessionLimits());
    await flushLoad();
    expect(getSessionLimits).toHaveBeenCalledTimes(1);

    // One millisecond short of the derived interval: a hook that polled any
    // faster would already have fired. Both bounds are asserted, so widening
    // OR narrowing the cadence reddens.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXPECTED_REFRESH_MS - 1);
    });
    expect(getSessionLimits).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(getSessionLimits).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXPECTED_REFRESH_MS);
    });
    expect(getSessionLimits).toHaveBeenCalledTimes(3);
    expect(result.current.status).toBe(SessionLimitsStatus.Ready);
  });

  it("publishes each refresh rather than pinning the mount snapshot", async () => {
    const responses = [SNAPSHOT, null];
    let call = 0;
    installBridge(
      vi.fn(() =>
        Promise.resolve(responses[Math.min(call++, responses.length - 1)])
      )
    );

    const { result } = renderHook(() => useSessionLimits());
    await flushLoad();
    expect(result.current.status).toBe(SessionLimitsStatus.Ready);

    // A snapshot that stops being served must take the bars down with it; a
    // frozen READY would keep rendering a figure nothing is refreshing.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXPECTED_REFRESH_MS);
    });
    expect(result.current.status).toBe(SessionLimitsStatus.Unavailable);
  });
});

describe("useSessionLimits — teardown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("stops re-reading once the consumer unmounts", async () => {
    const getSessionLimits = vi.fn(() => Promise.resolve(SNAPSHOT));
    installBridge(getSessionLimits);

    const { unmount } = renderHook(() => useSessionLimits());
    await flushLoad();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXPECTED_REFRESH_MS);
    });
    expect(getSessionLimits).toHaveBeenCalledTimes(2);

    unmount();

    // Without `clearInterval` the sidebar's IPC traffic would outlive the
    // sidebar — including after the Labs gate closes and unmounts it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXPECTED_REFRESH_MS * 5);
    });
    expect(getSessionLimits).toHaveBeenCalledTimes(2);
  });

  it("discards a late RESOLUTION from an effect that was already cleaned up", async () => {
    // The renderer mounts under `<StrictMode>` (main.tsx), which runs
    // effect → cleanup → effect on mount. The first effect's in-flight read is
    // the one `cancelled` exists to drop: settle it LAST and it would
    // otherwise overwrite the live effect's answer with a superseded figure.
    const pending: Deferred[] = [];
    installBridge(collectDeferred(pending));

    const { result } = renderHook(() => useSessionLimits(), {
      wrapper: StrictMode,
    });

    // Asserted, not assumed: if the double-invoke ever stops happening this
    // test must fail loudly rather than quietly stop covering `cancelled`.
    expect(pending).toHaveLength(2);

    await act(async () => {
      pending[1].resolve(SNAPSHOT);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toEqual({
      status: SessionLimitsStatus.Ready,
      limits: SNAPSHOT,
    });

    await act(async () => {
      pending[0].resolve(SUPERSEDED_SNAPSHOT);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toEqual({
      status: SessionLimitsStatus.Ready,
      limits: SNAPSHOT,
    });
  });

  it("discards a late REJECTION from an effect that was already cleaned up", async () => {
    // The rejection half of the same guard, and the more damaging one: a
    // failure from a read nobody is waiting on would blank a live snapshot to
    // UNAVAILABLE, hiding bars the app can still legitimately draw.
    const pending: Deferred[] = [];
    installBridge(collectDeferred(pending));

    const { result } = renderHook(() => useSessionLimits(), {
      wrapper: StrictMode,
    });
    expect(pending).toHaveLength(2);

    await act(async () => {
      pending[1].resolve(SNAPSHOT);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe(SessionLimitsStatus.Ready);

    await act(async () => {
      pending[0].reject(new Error("ipc handler unavailable"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toEqual({
      status: SessionLimitsStatus.Ready,
      limits: SNAPSHOT,
    });
  });
});

type Deferred = {
  promise: Promise<SessionLimitsSnapshot | null>;
  resolve: (value: SessionLimitsSnapshot | null) => void;
  reject: (reason: unknown) => void;
};

function noop(): void {
  return;
}

function createDeferred(): Deferred {
  const handle: {
    settle?: (value: SessionLimitsSnapshot | null) => void;
    fail?: (reason: unknown) => void;
  } = {};
  const promise = new Promise<SessionLimitsSnapshot | null>(
    (resolve, reject) => {
      handle.settle = resolve;
      handle.fail = reject;
    }
  );
  return {
    promise,
    resolve: (value) => handle.settle?.(value),
    reject: (reason) => handle.fail?.(reason),
  };
}

/** A bridge whose every call hands back a promise the test settles by hand. */
function collectDeferred(
  pending: Deferred[]
): () => Promise<SessionLimitsSnapshot | null> {
  return vi.fn(() => {
    const deferred = createDeferred();
    pending.push(deferred);
    return deferred.promise;
  });
}

function installBridge(
  getSessionLimits: () => Promise<SessionLimitsSnapshot | null>
): void {
  vi.stubGlobal("desktopApi", { getSessionLimits });
}

/** Settle the mount read without moving the clock toward a refresh. */
function flushLoad(): Promise<void> {
  return act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

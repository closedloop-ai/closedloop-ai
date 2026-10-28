import type { AgentSessionAnalytics } from "@repo/api/src/types/agent-session";
import { describe, expect, it, vi } from "vitest";
import type {
  SharedAgentSessionsCancelReadResult,
  SharedAgentSessionsQuery,
} from "../../../shared/shared-agent-sessions-contract";
import type { DesktopApi } from "../../types/desktop-api";
import { createLocalAgentSessionsDataSource } from "../local-agent-sessions-data-source";

/**
 * ISS-9802 on the RENDERER side of the bridge.
 *
 * `apps/desktop/test/desktop-read-cancellation.test.ts` proves the far side —
 * that a cancelled op on the store thread stops doing work. What that cannot say
 * is whether the renderer ever sends the token, or sends a token that MATCHES
 * the read it means to cancel. A mismatch is the quiet failure here: every
 * assertion about the store thread stays green while production cancels a token
 * nothing is registered under, so nothing is ever abandoned.
 *
 * The version-skew half is pinned in the same file, because it is the half that
 * decides whether the shared hook hands this source a signal at all: a preload
 * with no cancel bridge must report `cancelsInFlightReads: false` and send a
 * byte-identical pre-ISS-9802 request.
 */

const ANALYTICS = {} as AgentSessionAnalytics;
const CANCELLED: SharedAgentSessionsCancelReadResult = { requested: true };

describe("desktop local source relays an abort as a cancellation token", () => {
  it("cancels the SAME token the in-flight read carried", async () => {
    const gate = deferred<AgentSessionAnalytics>();
    const analytics = vi.fn(
      (_request?: SharedAgentSessionsQuery) => gate.promise
    );
    const cancelRead = vi.fn(() => Promise.resolve(CANCELLED));
    const source = createLocalAgentSessionsDataSource(
      desktopApiDouble({ analytics, cancelRead })
    );
    const controller = new AbortController();

    const read = source.analytics({}, { signal: controller.signal });
    const sentToken = (
      analytics.mock.calls[0]?.[0] as { cancellationToken?: string } | undefined
    )?.cancellationToken;
    controller.abort();
    // The store thread abandons the op and the IPC call comes back failed. That
    // is what settles this promise — an abort alone never did, here or before
    // ISS-9802, because the signal is re-checked only once the call returns.
    gate.reject(new Error("db-host read abandoned"));
    await expect(read).rejects.toThrow();

    // The read's token and the cancelled token are the same string. Asserting
    // only that `cancelRead` was called would pass on a source that minted a
    // fresh token for the cancel — which cancels nothing.
    expect(sentToken).toEqual(expect.any(String));
    expect(cancelRead).toHaveBeenCalledWith(sentToken);
  });

  it("reports it can cancel, and stops listening once the read settles", async () => {
    const cancelRead = vi.fn(() => Promise.resolve(CANCELLED));
    const source = createLocalAgentSessionsDataSource(
      desktopApiDouble({
        analytics: () => Promise.resolve(ANALYTICS),
        cancelRead,
      })
    );
    const controller = new AbortController();

    expect(source.cancelsInFlightReads).toBe(true);
    await source.analytics({}, { signal: controller.signal });
    // The hidden-panel case: a flush that COMPLETED leaves nothing attached, so
    // a later abort of the same (now stale) signal cannot cancel a token that
    // belongs to no running read — which on the store thread would be a live
    // token belonging to somebody else's op.
    controller.abort();

    expect(cancelRead).not.toHaveBeenCalled();
  });

  it("still rejects as a cancellation when the cancel bridge itself fails", async () => {
    const gate = deferred<AgentSessionAnalytics>();
    const cancelRead = vi.fn(() =>
      Promise.reject(new Error("No handler registered"))
    );
    const source = createLocalAgentSessionsDataSource(
      desktopApiDouble({ analytics: () => gate.promise, cancelRead })
    );
    const controller = new AbortController();

    const read = source.analytics({}, { signal: controller.signal });
    controller.abort();
    gate.reject(new Error("db-host read abandoned"));

    // An older main process answers the cancel channel with exactly this
    // rejection. It must reach nobody: the caller sees its own abort, not a
    // transport error, and nothing is left unhandled.
    await expect(read).rejects.toThrow();
    expect(cancelRead).toHaveBeenCalledTimes(1);
  });
});

describe("a preload without the cancel bridge behaves exactly as it did before", () => {
  it("declares it cannot cancel and sends no token", async () => {
    const analytics = vi.fn((_request?: SharedAgentSessionsQuery) =>
      Promise.resolve(ANALYTICS)
    );
    const source = createLocalAgentSessionsDataSource(
      desktopApiDouble({ analytics })
    );
    const controller = new AbortController();

    expect(source.cancelsInFlightReads).toBe(false);
    await source.analytics({}, { signal: controller.signal });

    // OMITTED, not `undefined`: an installed build that predates the field is
    // handed the request it has always been handed.
    expect(analytics.mock.calls[0]?.[0]).not.toHaveProperty(
      "cancellationToken"
    );
  });
});

type AnalyticsBridge = (
  request?: SharedAgentSessionsQuery
) => Promise<AgentSessionAnalytics>;
type CancelBridge = (
  token?: string
) => Promise<SharedAgentSessionsCancelReadResult>;

function desktopApiDouble(bridges: {
  analytics: AnalyticsBridge;
  cancelRead?: CancelBridge;
}): Pick<DesktopApi, "agentSessionsApi"> {
  return {
    agentSessionsApi: {
      analytics: bridges.analytics,
      ...(bridges.cancelRead ? { cancelRead: bridges.cancelRead } : {}),
    },
  } as unknown as Pick<DesktopApi, "agentSessionsApi">;
}

/** A read whose settlement this test drives, so no assertion waits on a clock. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve: (value: T) => void = () => {
    // Replaced synchronously by the executor below.
  };
  let reject: (error: Error) => void = () => {
    // Replaced synchronously by the executor below.
  };
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  // Attached now so a rejection this test drives is never an unhandled one
  // before the assertion gets to it.
  promise.catch(() => {
    // Ignored; the assertion owns the rejection.
  });
  return { promise, resolve, reject };
}

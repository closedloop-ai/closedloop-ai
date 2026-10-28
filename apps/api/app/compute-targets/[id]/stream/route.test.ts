import type { RelayOperationDispatchRequest } from "@repo/api/src/types/compute-target";
import { RELAY_PRESENCE_HEARTBEAT_INTERVAL_MS } from "@repo/api/src/types/relay-heartbeat";
import { DB_POOL_ACQUIRE_TIMEOUT_MS } from "@repo/database/pool-config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveAnyAuthContext: vi.fn(),
  findOwnedById: vi.fn(),
  setOnlineState: vi.fn(),
  subscribeOperations: vi.fn(),
  subscribeTargetConnection: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("@/lib/auth/resolve-any-auth-context", () => ({
  resolveAnyAuthContext: mocks.resolveAnyAuthContext,
}));

vi.mock("@/lib/auth/auth-context-failure", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/auth/auth-context-failure")>();
  return {
    ...actual,
    authContextFailureResponse: () =>
      new Response("unauthorized", { status: 401 }),
  };
});

vi.mock("@repo/observability/log", () => ({
  log: {
    error: mocks.logError,
    info: mocks.logInfo,
    // `scheduleLogFlush`/`scheduleLogFlushAfter` (route-utils) call this
    // unconditionally on every successful request; a mock missing it would
    // throw before the route ever reached the behavior under test.
    flush: vi.fn(async () => undefined),
  },
}));

vi.mock("@/lib/relay-event-bus", () => ({
  relayEventBus: {
    subscribeOperations: mocks.subscribeOperations,
    subscribeTargetConnection: mocks.subscribeTargetConnection,
  },
}));

vi.mock("../../service", () => ({
  computeTargetsService: {
    findOwnedById: mocks.findOwnedById,
    setOnlineState: mocks.setOnlineState,
  },
}));

import { AuthContextFailure } from "@/lib/auth/auth-context-failure";
import { REQUEST_COMPLETED_EVENT } from "@/lib/route-utils";
import { GET, maxDuration, STREAM_DEADLINE_MS } from "./route";

const TARGET_ID = "target-1";
const ORGANIZATION_ID = "org-1";
const USER_ID = "user-1";

/** Inside a successful setup: auth plus the lookup can wait on the pool. */
const SLOW_SETUP_MS = 45_000;

/**
 * The literal `markOffline` logs on a failed offline write, pinned raw so a
 * reword of the message can't drift past this suite unnoticed.
 */
const MARK_OFFLINE_FAILURE_MESSAGE =
  "Failed to mark compute target offline after SSE close";

/**
 * The literal a failed presence refresh logs, pinned raw for the same reason:
 * a reword must not slip past this suite.
 */
const PRESENCE_REFRESH_FAILURE_MESSAGE =
  "Failed to refresh compute target presence on SSE stream";

const decoder = new TextDecoder();
let cleanupStreams: Array<() => Promise<void>> = [];

function buildRequest(): Request {
  return new Request(`https://api.test/compute-targets/${TARGET_ID}/stream`);
}

function callGet(): Promise<Response> {
  return GET(buildRequest(), { params: Promise.resolve({ id: TARGET_ID }) });
}

/**
 * Open the stream and drain it in the background, so reads never block the
 * test body and every frame the route enqueues lands in the returned array.
 */
async function openStream(): Promise<{
  frames: string[];
  cancel: () => Promise<void>;
  ended: () => boolean;
}> {
  const response = await callGet();
  const body = response.body;
  if (!body) {
    throw new Error("expected an SSE body");
  }
  const reader = body.getReader();
  const frames: string[] = [];
  let ended = false;
  const drain = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        return;
      }
      frames.push(decoder.decode(value));
    }
  })();
  const cancel = async () => {
    await reader.cancel().catch(() => {
      // Already closed.
    });
    await drain.catch(() => {
      // Stream cancelled by the test.
    });
  };
  cleanupStreams.push(cancel);
  return { frames, cancel, ended: () => ended };
}

/**
 * Advance fake time until `predicate` holds, instead of hanging the test on a
 * promise chain that never gets a real timer tick to settle on.
 */
async function waitUntilTrue(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (predicate()) {
      return;
    }
    await vi.advanceTimersByTimeAsync(0);
  }
  throw new Error("condition was never satisfied");
}

function dispatchedOperation(
  overrides: Partial<RelayOperationDispatchRequest> = {}
): RelayOperationDispatchRequest {
  return {
    operationId: "operation-1",
    operation: "git_action",
    params: {},
    streaming: false,
    ...overrides,
  };
}

describe("GET /compute-targets/:id/stream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cleanupStreams = [];
    mocks.resolveAnyAuthContext.mockReset();
    mocks.findOwnedById.mockReset();
    mocks.setOnlineState.mockReset();
    mocks.subscribeOperations.mockReset();
    mocks.subscribeTargetConnection.mockReset();
    mocks.logError.mockReset();
    mocks.logInfo.mockReset();
    mocks.resolveAnyAuthContext.mockResolvedValue({
      ok: true,
      context: { organizationId: ORGANIZATION_ID, userId: USER_ID },
    });
    mocks.findOwnedById.mockResolvedValue({ id: TARGET_ID });
    mocks.setOnlineState.mockResolvedValue(true);
    mocks.subscribeOperations.mockReturnValue(vi.fn());
    mocks.subscribeTargetConnection.mockReturnValue(vi.fn());
  });

  afterEach(async () => {
    await Promise.all(cleanupStreams.map((cleanup) => cleanup()));
    vi.useRealTimers();
  });

  it("returns the auth-failure response, requests write scope, and never marks the target online", async () => {
    mocks.resolveAnyAuthContext.mockResolvedValue({
      ok: false,
      failure: AuthContextFailure.Unauthenticated,
    });

    const response = await callGet();

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("unauthorized");
    expect(mocks.resolveAnyAuthContext).toHaveBeenCalledWith(
      expect.any(Request),
      { requiredScopes: ["write"] }
    );
    expect(mocks.setOnlineState).not.toHaveBeenCalled();
  });

  // ISS-6748: `findOwnedById` is mocked here, so this pins only how the route
  // maps a `null` lookup to a response. The org-scoping guarantee the lookup
  // itself enforces is proven against a fake Prisma in
  // `app/compute-targets/find-owned-by-id-authz.test.ts`.
  it("maps an unowned target to 403", async () => {
    mocks.findOwnedById.mockResolvedValue(null);

    const response = await callGet();

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Forbidden");
    expect(mocks.setOnlineState).not.toHaveBeenCalled();
  });

  it("marks the target online and forwards a dispatched operation to the client", async () => {
    const { frames } = await openStream();

    expect(mocks.setOnlineState).toHaveBeenCalledWith(
      TARGET_ID,
      ORGANIZATION_ID,
      USER_ID,
      true
    );

    const [, handler] = mocks.subscribeOperations.mock.calls[0] as [
      string,
      (operation: RelayOperationDispatchRequest) => void,
    ];
    handler(dispatchedOperation());

    await waitUntilTrue(() =>
      frames.some((frame) => frame.startsWith("data:"))
    );
    expect(
      frames.some((frame) => frame.includes('"operationId":"operation-1"'))
    ).toBe(true);
  });

  // ISS-10111. Every other transport that keeps a desktop present refreshes
  // `lastSeenAt` on a cadence; this stream stamped it once at open and never
  // again. `markStaleTargetsOffline` — which `GET /compute-targets` runs —
  // flips a target offline
  // once `lastSeenAt` falls past `COMPUTE_TARGET_STALE_MS`, three intervals of
  // the same knob used below, so a client holding this stream was reported
  // offline 90s in while connected.
  //
  // This pins the REFRESH; that the cadence leaves headroom under the cutoff is
  // pinned against the real constants in `../../stale-cutoff.test.ts`, which
  // this file cannot import because it replaces that module with a mock.
  it("re-stamps presence on the relay heartbeat cadence while the stream is held", async () => {
    await openStream();
    expect(onlineWrites()).toBe(1);

    await vi.advanceTimersByTimeAsync(RELAY_PRESENCE_HEARTBEAT_INTERVAL_MS);
    expect(onlineWrites()).toBe(2);

    await vi.advanceTimersByTimeAsync(RELAY_PRESENCE_HEARTBEAT_INTERVAL_MS);
    expect(onlineWrites()).toBe(3);
  });

  it("survives a failed presence refresh instead of tearing the stream down", async () => {
    mocks.setOnlineState
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("refresh write failed"));

    await openStream();
    await vi.advanceTimersByTimeAsync(RELAY_PRESENCE_HEARTBEAT_INTERVAL_MS);
    await waitUntilTrue(() => mocks.logError.mock.calls.length > 0);

    expect(mocks.logError).toHaveBeenCalledWith(
      PRESENCE_REFRESH_FAILURE_MESSAGE,
      expect.objectContaining({ targetId: TARGET_ID })
    );

    await vi.advanceTimersByTimeAsync(RELAY_PRESENCE_HEARTBEAT_INTERVAL_MS);
    expect(onlineWrites()).toBe(3);
  });

  // ISS-10111 review (whitlockk): `clearInterval` runs in teardown, but it cannot
  // stop a refresh whose write is already in flight. Left unordered, that
  // write could settle after `markOffline` and re-mark a disconnected target
  // online, and every online-state reader would trust that until the stale
  // sweep caught it. Pins that the offline write is chained behind
  // the in-flight refresh and is therefore the last writer.
  it("does not let a refresh in flight at close outlive the offline write", async () => {
    let releaseRefresh: (() => void) | undefined;
    const refreshInFlight = new Promise<boolean>((resolve) => {
      releaseRefresh = () => resolve(true);
    });
    mocks.setOnlineState
      .mockResolvedValueOnce(true)
      .mockReturnValueOnce(refreshInFlight)
      .mockResolvedValue(true);

    const { cancel } = await openStream();
    await vi.advanceTimersByTimeAsync(RELAY_PRESENCE_HEARTBEAT_INTERVAL_MS);
    expect(onlineWrites()).toBe(2);

    await cancel();
    // The refresh has not settled, so the offline write must not have been
    // issued yet — issuing it here is exactly the ordering this case forbids.
    expect(offlineWrites()).toBe(0);

    releaseRefresh?.();
    await waitUntilTrue(() => offlineWrites() === 1);

    const lastCall = mocks.setOnlineState.mock.calls.at(-1) as unknown[];
    expect(lastCall[3]).toBe(false);
  });

  // ISS-10334: with no budget of its own the stream inherited `createSseStream`'s
  // 30-minute default, so the platform killed the function first and
  // `onCleanup` never ran — leaving the target `isOnline: true` until the stale
  // sweep caught it.
  it("ends the stream before the platform ceiling and marks the target offline", async () => {
    expect(STREAM_DEADLINE_MS).toBeLessThan(maxDuration * 1000);

    const stream = await openStream();
    await vi.advanceTimersByTimeAsync(STREAM_DEADLINE_MS - 1);
    expect(stream.ended()).toBe(false);
    expect(offlineWrites()).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    await waitUntilTrue(() => stream.ended() && offlineWrites() === 1);
  });

  // The platform clock starts at request entry; budgeting from any later point
  // would put the close at `setup + budget`, past the ceiling. The delay sits on
  // auth, the first await, so a `startedAt` captured after it fails here.
  it("charges a slow setup against the stream budget", async () => {
    const stream = await openStreamAfterSetup(SLOW_SETUP_MS);

    await vi.advanceTimersByTimeAsync(STREAM_DEADLINE_MS - SLOW_SETUP_MS - 1);
    expect(stream.ended()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await waitUntilTrue(() => stream.ended());
  });

  // #8114 review (whitlockk): teardown runs after the close, and `waitUntil` work
  // still ends at the function's timeout. The worst case at the close is a
  // refresh issued just before it, waiting a full pool acquisition, with the
  // offline write chained behind it waiting another. Setup is sized so the last
  // heartbeat lands 1ms before the close.
  it("lands the offline write before the platform ceiling when teardown waits on the pool", async () => {
    const setupMs =
      (STREAM_DEADLINE_MS - 1) % RELAY_PRESENCE_HEARTBEAT_INTERVAL_MS;
    let offlineLanded = false;
    mocks.setOnlineState.mockResolvedValueOnce(true).mockImplementation(
      (_targetId: string, _orgId: string, _userId: string, isOnline: boolean) =>
        new Promise((resolve) => {
          setTimeout(() => {
            offlineLanded = offlineLanded || !isOnline;
            resolve(true);
          }, DB_POOL_ACQUIRE_TIMEOUT_MS);
        })
    );

    const stream = await openStreamAfterSetup(setupMs);
    await vi.advanceTimersByTimeAsync(STREAM_DEADLINE_MS - setupMs);
    await waitUntilTrue(() => stream.ended());
    expect(offlineWrites()).toBe(0);

    await vi.advanceTimersByTimeAsync(
      maxDuration * 1000 - STREAM_DEADLINE_MS - 1
    );
    expect(offlineLanded).toBe(true);
  });

  // #8114 review (whitlockk): a floor on the budget would hold the stream open past
  // a setup that already spent it, pushing teardown toward the ceiling.
  it("closes at once when setup has spent the whole budget", async () => {
    const stream = await openStreamAfterSetup(STREAM_DEADLINE_MS + 1000);

    await vi.advanceTimersByTimeAsync(1);
    await waitUntilTrue(() => stream.ended() && offlineWrites() === 1);
  });

  // #8205 review (whitlockk): the handler returns as soon as the stream is built,
  // so a record emitted there measured setup, not the connection.
  it("records request_completed when the stream ends, not when the handler returns", async () => {
    const { cancel } = await openStream();
    expect(requestCompletedRecords()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(RELAY_PRESENCE_HEARTBEAT_INTERVAL_MS);
    expect(requestCompletedRecords()).toHaveLength(0);

    await cancel();
    expect(requestCompletedRecords()).toEqual([
      expect.objectContaining({
        path: "/compute-targets/:id/stream",
        status_code: 200,
        duration_ms: RELAY_PRESENCE_HEARTBEAT_INTERVAL_MS,
      }),
    ]);
  });

  it("swallows a failed offline write on teardown without leaking the rejection", async () => {
    mocks.setOnlineState
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("offline write failed"));
    const unsubscribeOps = vi.fn();
    mocks.subscribeOperations.mockReturnValue(unsubscribeOps);

    const { cancel } = await openStream();

    await cancel();
    await waitUntilTrue(() => mocks.logError.mock.calls.length > 0);

    expect(unsubscribeOps).toHaveBeenCalledTimes(1);
    expect(mocks.logError).toHaveBeenCalledWith(
      MARK_OFFLINE_FAILURE_MESSAGE,
      expect.objectContaining({ targetId: TARGET_ID })
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});

/** Open the stream behind an auth that resolves `setupMs` after request entry. */
async function openStreamAfterSetup(
  setupMs: number
): Promise<Awaited<ReturnType<typeof openStream>>> {
  mocks.resolveAnyAuthContext.mockImplementation(
    () =>
      new Promise((resolve) => {
        setTimeout(
          () =>
            resolve({
              ok: true,
              context: { organizationId: ORGANIZATION_ID, userId: USER_ID },
            }),
          setupMs
        );
      })
  );
  const opening = openStream();
  await vi.advanceTimersByTimeAsync(setupMs);
  return opening;
}

/** Online writes so far — the offline write on teardown passes `false`. */
function onlineWrites(): number {
  return mocks.setOnlineState.mock.calls.filter(
    (call: unknown[]) => call[3] === true
  ).length;
}

/** Offline writes so far — teardown's write is the only one passing `false`. */
function offlineWrites(): number {
  return mocks.setOnlineState.mock.calls.filter(
    (call: unknown[]) => call[3] === false
  ).length;
}

/** `request_completed` records so far; the stream path logs them at info. */
function requestCompletedRecords(): unknown[] {
  return mocks.logInfo.mock.calls
    .filter((call: unknown[]) => call[0] === REQUEST_COMPLETED_EVENT)
    .map((call: unknown[]) => call[1]);
}

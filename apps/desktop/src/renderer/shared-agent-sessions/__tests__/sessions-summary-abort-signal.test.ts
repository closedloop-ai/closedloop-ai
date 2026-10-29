import type {
  AgentSessionAnalytics,
  AgentSessionDetail,
  AgentSessionListResponse,
  AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";
import { createHttpAgentSessionsDataSource } from "@repo/app/agents/data-source/agent-sessions-data-source";
import { ApiError } from "@repo/app/shared/api/api-error";
import type { ApiRequestOptions } from "@repo/app/shared/api/api-timeout";
import { describe, expect, it, vi } from "vitest";
import {
  type CloudApiFetchRequest,
  type CloudApiFetchResult,
  DESKTOP_CLOUD_API_PLACEHOLDER_ORIGIN,
} from "../../../shared/cloud-api-fetch-contract";
import type { DesktopApi } from "../../types/desktop-api";
import { createDesktopCloudApiAdapter } from "../cloud-api-adapter";
import { createLocalAgentSessionsDataSource } from "../local-agent-sessions-data-source";

/**
 * ISS-7852 on the DESKTOP surface.
 *
 * `packages/app` proves the shared hooks hand the summary reads TanStack
 * Query's `AbortSignal` and that it reaches the `ApiTransportFetch` port. What
 * that cannot say is what happens on the far side of the port HERE, because
 * desktop fills it with something the web never does: an Electron IPC bridge.
 * Desktop has two of them and they answer the signal differently, so both are
 * pinned.
 *
 * LOCAL mode (`agentSessionsApi` over the design-system preload): an
 * `AbortSignal` is not structured-cloneable, so it cannot cross to the main
 * process and a running SQLite read cannot be cancelled. The renderer honors it
 * on its own side instead — an already-superseded range never reaches the
 * bridge, and one superseded mid-read rejects as a CANCELLATION rather than
 * delivering an answer nobody wants. The cancellation must survive
 * `runSource`'s sanitizer: laundering it into the generic 500 `ApiError` would
 * put a hard error card on screen for a query the user themself superseded.
 *
 * CLOUD mode (`cloudApiFetch`): the bridge cannot forward the signal either and
 * deliberately ignores it. "Ignores" has to mean SETTLES — an older installed
 * main process knows nothing about cancellation, and a bridged read that neither
 * resolved nor rejected after an abort would wedge the query forever. That is
 * the version-skew half of the ticket's second acceptance criterion.
 */

const LIST: AgentSessionListResponse = {
  items: [],
  total: 0,
  viewerScope: "self",
};
const USAGE = { totalSessions: 3 } as unknown as AgentSessionUsageSummary;
const ANALYTICS = { viewerScope: "self" } as unknown as AgentSessionAnalytics;
const DETAIL = { id: "session-1" } as unknown as AgentSessionDetail;
const ABORT_ERROR_NAME = "AbortError";

type AgentSessionsApi = DesktopApi["agentSessionsApi"];

function fakeDesktopApi(
  overrides: Partial<AgentSessionsApi> = {}
): Parameters<typeof createLocalAgentSessionsDataSource>[0] {
  return {
    agentSessionsApi: {
      list: vi.fn(async () => LIST),
      detail: vi.fn(async () => DETAIL),
      usage: vi.fn(async () => USAGE),
      analytics: vi.fn(async () => ANALYTICS),
      pageData: vi.fn(async () => ({ list: LIST, usage: USAGE })),
      eventsPage: vi.fn(async () => null),
      ...overrides,
    },
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    // Replaced synchronously by the executor below.
  };
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * A promise whose rejection the test drives, so the IPC failure can be made to
 * land strictly AFTER the abort rather than racing it.
 */
function rejectable() {
  let reject: (reason: unknown) => void = () => {
    // Replaced synchronously by the executor below.
  };
  const promise = new Promise<never>((_resolve, rejectFn) => {
    reject = rejectFn;
  });
  // An unhandled rejection would fail the run before the assertion; the read
  // under test attaches its own handler, this one just keeps Node quiet if the
  // production path ever stops awaiting it.
  promise.catch(() => {
    // Intentionally ignored.
  });
  return { promise, reject };
}

/** The rejection reason, captured so it can be asserted AFTER the call. */
async function rejectionOf(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("expected the read to reject, but it resolved");
}

describe("desktop LOCAL summary reads honor the query's AbortSignal (ISS-7852)", () => {
  it("never reaches the IPC bridge when the range was superseded before the read started", async () => {
    const api = fakeDesktopApi();
    const source = createLocalAgentSessionsDataSource(api);
    const controller = new AbortController();
    controller.abort();

    const usageError = await rejectionOf(
      source.usage({ startDate: "7d" }, { signal: controller.signal })
    );
    const pageDataError = await rejectionOf(
      source.pageData({ startDate: "7d" }, { signal: controller.signal })
    );
    // ISS-9741: `analytics` joins them. This is the `aggregateAnalytics` scan the
    // Repository-facet fallback re-issues on every live-bridge flush.
    const analyticsError = await rejectionOf(
      source.analytics({ startDate: "7d" }, { signal: controller.signal })
    );

    expect((usageError as Error).name).toBe(ABORT_ERROR_NAME);
    expect((pageDataError as Error).name).toBe(ABORT_ERROR_NAME);
    expect((analyticsError as Error).name).toBe(ABORT_ERROR_NAME);
    // The point of the pre-check: the heavy local scan is never even asked for.
    expect(api.agentSessionsApi.usage).not.toHaveBeenCalled();
    expect(api.agentSessionsApi.pageData).not.toHaveBeenCalled();
    expect(api.agentSessionsApi.analytics).not.toHaveBeenCalled();
  });

  it("rejects as a cancellation — not a sanitized 500 — when superseded mid-read", async () => {
    const gate = deferred<AgentSessionUsageSummary>();
    const api = fakeDesktopApi({ usage: vi.fn(() => gate.promise) });
    const source = createLocalAgentSessionsDataSource(api);
    const controller = new AbortController();

    const read = source.usage(
      { startDate: "7d" },
      { signal: controller.signal }
    );
    // The IPC read is genuinely in flight before the supersession, so this case
    // exercises the post-check rather than the pre-check above.
    expect(api.agentSessionsApi.usage).toHaveBeenCalledTimes(1);
    controller.abort();
    gate.resolve(USAGE);

    const error = await rejectionOf(read);
    expect((error as Error).name).toBe(ABORT_ERROR_NAME);
    // `runSource` turns anything it catches into a generic 500. A cancellation
    // laundered into one would render the hard error card for a query the user
    // superseded themself.
    expect(error).not.toBeInstanceOf(ApiError);
  });

  it("rejects the COMBINED read as a cancellation when superseded mid-read", async () => {
    const gate = deferred<{
      list: AgentSessionListResponse;
      usage: AgentSessionUsageSummary;
    }>();
    const api = fakeDesktopApi({ pageData: vi.fn(() => gate.promise) });
    const source = createLocalAgentSessionsDataSource(api);
    const controller = new AbortController();

    const read = source.pageData(
      { startDate: "7d" },
      { signal: controller.signal }
    );
    // In flight before the supersession, so this is the post-read check on
    // `pageData` — the pre-check case above cannot reach it.
    expect(api.agentSessionsApi.pageData).toHaveBeenCalledTimes(1);
    controller.abort();
    gate.resolve({ list: LIST, usage: USAGE });

    const error = await rejectionOf(read);
    expect((error as Error).name).toBe(ABORT_ERROR_NAME);
    expect(error).not.toBeInstanceOf(ApiError);
  });

  // ISS-9806 — the honest counterpart to `packages/app`'s "aborts at a
  // signal-honoring transport" suite, which covers this hook pair over a
  // transport that DOES tear a request down. Here nothing cancellable crosses
  // the bridge, so a scan already running is still paid for in full and only
  // its answer is discarded. Handing `agentSessionsApi` an options bag would
  // red this — which is the point: that is ISS-9802's change to make, and until
  // it lands no caller may claim these reads are cancelled.
  it("hands the local bridge no cancellation handle, so a superseded read is still paid for", async () => {
    const usageGate = deferred<AgentSessionUsageSummary>();
    const pageDataGate = deferred<{
      list: AgentSessionListResponse;
      usage: AgentSessionUsageSummary;
    }>();
    const usage = vi.fn(() => usageGate.promise);
    const pageData = vi.fn(() => pageDataGate.promise);
    const source = createLocalAgentSessionsDataSource(
      fakeDesktopApi({ usage, pageData })
    );
    const controller = new AbortController();

    const reads = [
      rejectionOf(
        source.usage({ startDate: "7d" }, { signal: controller.signal })
      ),
      rejectionOf(
        source.pageData({ startDate: "7d" }, { signal: controller.signal })
      ),
    ];
    // Both are genuinely in flight before the supersession, so this is the
    // mid-read case the pre-check above cannot reach.
    expect(usage).toHaveBeenCalledTimes(1);
    expect(pageData).toHaveBeenCalledTimes(1);
    controller.abort();
    usageGate.resolve(USAGE);
    pageDataGate.resolve({ list: LIST, usage: USAGE });

    for (const error of await Promise.all(reads)) {
      expect((error as Error).name).toBe(ABORT_ERROR_NAME);
    }
    // The filters and nothing else: no options bag reached the bridge, so the
    // abort had no channel to the running SQLite scan and could not stop it.
    expect(usage.mock.calls[0]).toEqual([{ startDate: "7d" }]);
    expect(pageData.mock.calls[0]).toEqual([{ startDate: "7d" }]);
  });

  // `runSource` sanitizes ANY rejection into the generic 500 before the
  // post-read check can run, so an IPC failure that lands AFTER the
  // supersession is the one case where the two signal checks alone are not
  // enough: the cancellation has to win inside the catch, or the user gets a
  // hard error card for a read they themself superseded.
  it("reports cancellation — not a sanitized 500 — when the usage IPC rejects after the abort", async () => {
    const failure = rejectable();
    const api = fakeDesktopApi({ usage: vi.fn(() => failure.promise) });
    const source = createLocalAgentSessionsDataSource(api);
    const controller = new AbortController();

    const read = source.usage(
      { startDate: "7d" },
      { signal: controller.signal }
    );
    controller.abort();
    failure.reject(new Error("sqlite read failed"));

    const error = await rejectionOf(read);
    expect((error as Error).name).toBe(ABORT_ERROR_NAME);
    expect(error).not.toBeInstanceOf(ApiError);
  });

  it("reports cancellation — not a sanitized 500 — when the pageData IPC rejects after the abort", async () => {
    const failure = rejectable();
    const api = fakeDesktopApi({ pageData: vi.fn(() => failure.promise) });
    const source = createLocalAgentSessionsDataSource(api);
    const controller = new AbortController();

    const read = source.pageData(
      { startDate: "7d" },
      { signal: controller.signal }
    );
    controller.abort();
    failure.reject(new Error("sqlite read failed"));

    const error = await rejectionOf(read);
    expect((error as Error).name).toBe(ABORT_ERROR_NAME);
    expect(error).not.toBeInstanceOf(ApiError);
  });

  it("rejects the ANALYTICS read as a cancellation when superseded mid-scan", async () => {
    const gate = deferred<AgentSessionAnalytics>();
    const api = fakeDesktopApi({ analytics: vi.fn(() => gate.promise) });
    const source = createLocalAgentSessionsDataSource(api);
    const controller = new AbortController();

    const read = source.analytics(
      { startDate: "7d" },
      { signal: controller.signal }
    );
    // Genuinely in flight before the supersession, so this exercises the
    // post-read check rather than the pre-check above.
    expect(api.agentSessionsApi.analytics).toHaveBeenCalledTimes(1);
    controller.abort();
    gate.resolve(ANALYTICS);

    const error = await rejectionOf(read);
    expect((error as Error).name).toBe(ABORT_ERROR_NAME);
    // A cancellation laundered into `runSource`'s generic 500 would put a hard
    // error card under the Repository facet for a flush the user never saw.
    expect(error).not.toBeInstanceOf(ApiError);
  });

  it("reports cancellation — not a sanitized 500 — when the analytics IPC rejects after the abort", async () => {
    const failure = rejectable();
    const api = fakeDesktopApi({ analytics: vi.fn(() => failure.promise) });
    const source = createLocalAgentSessionsDataSource(api);
    const controller = new AbortController();

    const read = source.analytics(
      { startDate: "7d" },
      { signal: controller.signal }
    );
    controller.abort();
    failure.reject(new Error("sqlite read failed"));

    const error = await rejectionOf(read);
    expect((error as Error).name).toBe(ABORT_ERROR_NAME);
    expect(error).not.toBeInstanceOf(ApiError);
  });

  it("still sanitizes a genuine analytics failure when nothing was superseded", async () => {
    const api = fakeDesktopApi({
      analytics: vi.fn(() => Promise.reject(new Error("sqlite read failed"))),
    });
    const source = createLocalAgentSessionsDataSource(api);
    const controller = new AbortController();

    const error = await rejectionOf(
      source.analytics({ startDate: "7d" }, { signal: controller.signal })
    );

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(500);
  });

  it("still sanitizes a genuine source failure when nothing was superseded", async () => {
    const api = fakeDesktopApi({
      usage: vi.fn(() => Promise.reject(new Error("sqlite read failed"))),
    });
    const source = createLocalAgentSessionsDataSource(api);
    const controller = new AbortController();

    const error = await rejectionOf(
      source.usage({ startDate: "7d" }, { signal: controller.signal })
    );

    // The cancellation guard must not swallow real breakage: an un-aborted
    // signal leaves the sanitized 500 exactly as it was.
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(500);
  });

  it("still resolves for a caller that passes no signal", async () => {
    const source = createLocalAgentSessionsDataSource(fakeDesktopApi());

    await expect(source.usage({ startDate: "7d" })).resolves.toBe(USAGE);
    await expect(source.pageData({ startDate: "7d" })).resolves.toMatchObject({
      usage: USAGE,
    });
    await expect(source.analytics({ startDate: "7d" })).resolves.toBe(
      ANALYTICS
    );
  });
});

describe("the desktop CLOUD bridge safely ignores an abort (ISS-7852)", () => {
  it("settles the bridged read after the caller's signal fires", async () => {
    const gate = deferred<CloudApiFetchResult>();
    const cloudApiFetch = vi.fn(
      (_request: CloudApiFetchRequest) => gate.promise
    );
    const adapter = createDesktopCloudApiAdapter({
      cloudApiFetch,
    } as unknown as DesktopApi);
    const doFetch = adapter.fetch;
    if (!doFetch) {
      throw new Error(
        "the desktop adapter must provide a fetch implementation"
      );
    }
    const controller = new AbortController();
    const init: ApiRequestOptions = {
      method: "GET",
      signal: controller.signal,
    };

    const inFlight = doFetch(
      `${DESKTOP_CLOUD_API_PLACEHOLDER_ORIGIN}/agent-sessions/usage?startDate=7d`,
      init
    );
    controller.abort();
    gate.resolve({
      kind: "response",
      status: 200,
      statusText: "OK",
      headers: [["content-type", "application/json"]],
      bodyText: JSON.stringify({ success: true, data: { totalSessions: 3 } }),
    });

    // The signal never crossed the bridge — an installed main process that
    // predates this change is handed exactly the request it always was — and
    // the promise still settles rather than being left pending forever.
    const response = await inFlight;
    expect(response.status).toBe(200);
    expect(cloudApiFetch).toHaveBeenCalledTimes(1);
    const request = cloudApiFetch.mock.calls[0]?.[0];
    expect(request).not.toHaveProperty("signal");
    expect(request?.path).toBe("/agent-sessions/usage?startDate=7d");
  });
});

/**
 * ISS-9741 (codex review) — the desktop half of "only claim a cancellation that
 * works".
 *
 * `packages/app` proves the shared hook consults `cancelsInFlightReads` and
 * withholds the signal when it is false. What it cannot prove is that DESKTOP
 * answers false, and desktop is the surface the whole concern is about: both of
 * its transports accept an `AbortSignal` and settle on abort, so nothing
 * downstream can tell by observation that the read is still running. If either
 * of these ever reported true, the shared hook would trade query-core's
 * in-flight dedupe for a cancellation that never happens — and an
 * unmount/remount would re-issue the 27.1s `aggregateAnalytics` scan instead of
 * waiting on the one already on the bounded-read lane.
 */
describe("desktop sources report that a cancellation cannot reach the work (ISS-9741)", () => {
  it("declares the LOCAL source unable to cancel an in-flight read", () => {
    const source = createLocalAgentSessionsDataSource(fakeDesktopApi());

    expect(source.cancelsInFlightReads).toBe(false);
  });

  it("declares the CLOUD adapter unable to honor an abort signal", () => {
    const adapter = createDesktopCloudApiAdapter({
      cloudApiFetch: vi.fn(),
    } as unknown as DesktopApi);

    expect(adapter.honorsAbortSignal).toBe(false);
  });

  // Desktop cloud mode builds the SHARED http data source over that adapter's
  // client, so the capability has to survive the composition — a source that
  // reported `true` here would be the web claim made on the IPC bridge.
  it("carries the adapter's answer through the http source desktop cloud mode builds", () => {
    const overCloudBridge = createHttpAgentSessionsDataSource({
      get: () => pendingForever(),
      honorsAbortSignal: false,
    });
    const overRealFetch = createHttpAgentSessionsDataSource({
      get: () => pendingForever(),
    });

    expect(overCloudBridge.cancelsInFlightReads).toBe(false);
    // The web shell's platform `fetch` is the default the absent flag means.
    expect(overRealFetch.cancelsInFlightReads).toBe(true);
  });
});

/** A read that never settles — no assertion here waits on one. */
function pendingForever<T>(): Promise<T> {
  return new Promise<T>(() => {
    // Deliberately never settles.
  });
}

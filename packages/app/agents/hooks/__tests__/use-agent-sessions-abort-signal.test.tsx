import type {
  AgentSessionsDataSource,
  AgentSessionsReadOptions,
} from "@repo/app/agents/data-source/agent-sessions-data-source";
import { createHttpAgentSessionsDataSource } from "@repo/app/agents/data-source/agent-sessions-data-source";
import { AgentSessionsDataSourceProvider } from "@repo/app/agents/data-source/provider";
import type { ApiAdapter } from "@repo/app/shared/api/api-adapter";
import { ApiAdapterProvider } from "@repo/app/shared/api/provider";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import { createTestQueryClient } from "@repo/app/shared/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { agentSessionKeys } from "../agent-session-keys";
import {
  useAgentSessionAnalytics,
  useAgentSessionsPageData,
  useAgentSessionUsage,
} from "../use-agent-sessions";

/**
 * ISS-7852 — the superseded Sessions summary read is CANCELLED, not merely
 * ignored.
 *
 * Read the distinction before touching this file, because getting it wrong is
 * the exact false green the ticket names. On `main` nothing rendered wrongly:
 * `agentSessionKeys.usage(scope, filters)` carries the filters, so a superseded
 * answer lands in its own cache entry and can never overwrite the active range —
 * ISS-7422's AC4 was a disjunction and its *ignored* arm was already satisfied.
 * An assertion that the newest range still wins is therefore satisfied by the
 * KEY alone and proves nothing about this change. What this suite asserts
 * instead is that the abort REACHES the `ApiTransportFetch` port: the transport
 * receives an init whose signal actually aborts.
 *
 * Nothing is mocked between the hook and that port: the real `useApiClient` and
 * the real HTTP data source sit in between, so deleting the `{ signal }` thread
 * at either end fails these cases. That is not incidental — query-core aborts a
 * query's signal only when the `queryFn` CONSUMED it, so a `queryFn` that
 * ignores the signal leaves the superseded request running and these assertions
 * red.
 *
 * ISS-9806 — that is where this suite's claim stops, and the stop matters. The
 * transport injected below honors the signal, which is what `apps/app` leaves in
 * place (the platform `fetch`). `apps/desktop` fills the same port with an IPC
 * bridge that drops `init.signal`, and its LOCAL source bypasses the port
 * entirely; neither can stop work already running. What those two do with an
 * abort is pinned by
 * `apps/desktop/src/renderer/shared-agent-sessions/__tests__/sessions-summary-abort-signal.test.ts`,
 * never here — reading a desktop guarantee out of these cases is the mistake.
 *
 * Both hooks are covered because the two surfaces read the summary through
 * different ones: `apps/app`'s Sessions page uses `useAgentSessionUsage`, while
 * `apps/desktop`'s `SessionsView` takes its summary out of the combined
 * `useAgentSessionsPageData`. A thread through only one of them would leave the
 * other hook consuming no signal at all — the very divergence ISS-7422 refused
 * to fold in.
 */

const SEVEN_DAY_START = "2026-08-20T00:00:00.000Z";
const THIRTY_DAY_START = "2026-07-28T00:00:00.000Z";
const USAGE_PATH = "/agent-sessions/usage";
const LIST_PATH = "/agent-sessions";
const ANALYTICS_PATH = "/agent-sessions/analytics";
const ANALYTICS_BODY = { byRepository: [] };

type RecordedRequest = {
  pathname: string;
  signal: AbortSignal | null | undefined;
};

/**
 * A transport that never answers, and rejects the way a real one does when its
 * signal fires. Rejecting rather than hanging is what keeps the aborted request
 * a settled cancellation instead of a promise nobody ever resolves.
 */
function createHangingTransport(recorded: RecordedRequest[]) {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal;
    recorded.push({ pathname: new URL(String(input)).pathname, signal });
    return new Promise<Response>((_resolve, reject) => {
      const onAbort = () => {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        reject(error);
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };
}

/** The REAL HTTP data source over the REAL api client — no test double between. */
function HttpSourceProvider({ children }: { children: ReactNode }) {
  const api = useApiClient();
  return (
    <AgentSessionsDataSourceProvider
      dataSource={createHttpAgentSessionsDataSource(api)}
    >
      {children}
    </AgentSessionsDataSourceProvider>
  );
}

/**
 * Answers the FIRST request and hangs on every later one, so a query can hold
 * data before a flush-driven refetch is superseded mid-flight.
 */
function createAnswerOnceTransport(recorded: RecordedRequest[]) {
  const hang = createHangingTransport(recorded);
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (recorded.length > 0) {
      return hang(input, init);
    }
    recorded.push({
      pathname: new URL(String(input)).pathname,
      signal: init?.signal,
    });
    return Promise.resolve(
      new Response(JSON.stringify({ success: true, data: ANALYTICS_BODY }), {
        status: 200,
      })
    );
  };
}

function createAbortSignalWrapper(
  recorded: RecordedRequest[],
  overrides: { client?: QueryClient; transport?: ApiAdapter["fetch"] } = {}
) {
  const client = overrides.client ?? createTestQueryClient();
  const adapter: ApiAdapter = {
    resolveApiOrigin: () => "http://sessions.test",
    fetch: overrides.transport ?? createHangingTransport(recorded),
  };
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <AuthAdapterProvider adapter={createStaticAuthAdapter()}>
          <ApiAdapterProvider adapter={adapter}>
            <HttpSourceProvider>{children}</HttpSourceProvider>
          </ApiAdapterProvider>
        </AuthAdapterProvider>
      </QueryClientProvider>
    );
  };
}

function requestFor(
  recorded: RecordedRequest[],
  pathname: string
): RecordedRequest | undefined {
  return recorded.find((request) => request.pathname === pathname);
}

function requestsFor(
  recorded: RecordedRequest[],
  pathname: string
): RecordedRequest[] {
  return recorded.filter((request) => request.pathname === pathname);
}

describe("the superseded Sessions summary read aborts at a signal-honoring transport (ISS-7852)", () => {
  it("aborts the standalone usage request when the range is superseded — the hook the web Sessions page reads through", async () => {
    const recorded: RecordedRequest[] = [];
    const { rerender } = renderHook(
      ({ startDate }: { startDate: string }) =>
        useAgentSessionUsage({ startDate }),
      {
        initialProps: { startDate: SEVEN_DAY_START },
        wrapper: createAbortSignalWrapper(recorded),
      }
    );

    await waitFor(() => expect(requestFor(recorded, USAGE_PATH)).toBeDefined());
    const superseded = requestFor(recorded, USAGE_PATH);
    // The signal has to be LIVE before the supersession, or "aborted" below
    // would be a condition that was already true when it was written.
    expect(superseded?.signal?.aborted).toBe(false);

    rerender({ startDate: THIRTY_DAY_START });

    await waitFor(() => expect(superseded?.signal?.aborted).toBe(true));
  });

  it("aborts the combined pageData request when the range is superseded — the hook the desktop Sessions view reads through", async () => {
    const recorded: RecordedRequest[] = [];
    const { rerender } = renderHook(
      ({ startDate }: { startDate: string }) =>
        useAgentSessionsPageData({ startDate }),
      {
        initialProps: { startDate: SEVEN_DAY_START },
        wrapper: createAbortSignalWrapper(recorded),
      }
    );

    await waitFor(() => expect(requestFor(recorded, LIST_PATH)).toBeDefined());
    await waitFor(() => expect(requestFor(recorded, USAGE_PATH)).toBeDefined());
    const supersededList = requestFor(recorded, LIST_PATH);
    const supersededUsage = requestFor(recorded, USAGE_PATH);
    // BOTH halves of the combined read: each is its own request and each is
    // paid for by a range nobody is looking at any more.
    expect(supersededList?.signal?.aborted).toBe(false);
    expect(supersededUsage?.signal?.aborted).toBe(false);

    rerender({ startDate: THIRTY_DAY_START });

    await waitFor(() => expect(supersededList?.signal?.aborted).toBe(true));
    expect(supersededUsage?.signal?.aborted).toBe(true);
  });
});

/**
 * ISS-9741 — the same treatment for the analytics read, the one summary read
 * ISS-7852 left unsignalled.
 *
 * It is the read that needed it most. ISS-9553 (PR #6815) reclassified
 * `analyticsRoot` from `excluded` to `always`, so the desktop Sessions
 * Repository-facet fallback now re-reads this aggregate on EVERY live-bridge
 * flush — one per `LIVE_BRIDGE_INVALIDATION_THROTTLE_MS` under a sustained
 * change stream — and the aggregate behind it measured 27.1s on a real
 * 4,285-session corpus. query-core cancels the superseded refetch once the query
 * holds data (`cancelRefetch` defaults true), but with no signal that cancel
 * only drops the PROMISE: the scan underneath runs to completion and its answer
 * is thrown away.
 */
describe("the superseded Sessions analytics read is aborted (ISS-9741)", () => {
  it("aborts the analytics request at the transport when the range is superseded", async () => {
    const recorded: RecordedRequest[] = [];
    const { rerender } = renderHook(
      ({ startDate }: { startDate: string }) =>
        useAgentSessionAnalytics({ startDate }),
      {
        initialProps: { startDate: SEVEN_DAY_START },
        wrapper: createAbortSignalWrapper(recorded),
      }
    );

    await waitFor(() =>
      expect(requestFor(recorded, ANALYTICS_PATH)).toBeDefined()
    );
    const superseded = requestFor(recorded, ANALYTICS_PATH);
    // Live before the supersession, or "aborted" below was already true when it
    // was written and could never fail.
    expect(superseded?.signal?.aborted).toBe(false);

    rerender({ startDate: THIRTY_DAY_START });

    await waitFor(() => expect(superseded?.signal?.aborted).toBe(true));
  });

  // The ticket's actual scenario, and the honesty half of it: a cancellation is
  // NOT a failed read. The flush supersedes a refetch of a query that already
  // holds data, so the facet must keep showing the answer it has — never an
  // error treatment for a read the reader themself superseded.
  it("aborts a flush-superseded analytics refetch without painting an error over the held data", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useAgentSessionAnalytics({ startDate: SEVEN_DAY_START }),
      {
        wrapper: createAbortSignalWrapper(recorded, {
          client,
          transport: createAnswerOnceTransport(recorded),
        }),
      }
    );

    await waitFor(() => expect(result.current.data).toEqual(ANALYTICS_BODY));

    // One live-bridge flush: `agentSessionCacheConvergence` converges
    // `analyticsRoot` on every change event, so this is the refetch it issues.
    // Fired, never awaited: the transport hangs, so its promise is what the
    // NEXT flush cancels.
    client.refetchQueries({ queryKey: agentSessionKeys.analyticsRoot() });
    await waitFor(() =>
      expect(requestsFor(recorded, ANALYTICS_PATH)).toHaveLength(2)
    );
    const superseded = requestsFor(recorded, ANALYTICS_PATH)[1];
    expect(superseded?.signal?.aborted).toBe(false);

    // The next flush, while that one is still scanning.
    client.refetchQueries({ queryKey: agentSessionKeys.analyticsRoot() });

    await waitFor(() => expect(superseded?.signal?.aborted).toBe(true));
    expect(result.current.isError).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual(ANALYTICS_BODY);
  });
});

/**
 * ISS-9741 (codex review) — WHERE the analytics read claims cancellation.
 *
 * Reading `signal` is not a passive observation. query-core watches the
 * `queryFn` context for the access and changes what it does with an in-flight
 * read on the last unmount: a `queryFn` that touched the signal gets
 * `cancel({ revert: true })`, one that did not gets `cancelRetry()` and its
 * fetch is left to finish and populate the cache. The second is what lets a
 * remount deduplicate against a read already running.
 *
 * That makes the trade conditional on something outside query-core's knowledge:
 * whether aborting actually stops the work. Against the web `fetch` it does, and
 * giving up the dedupe is the whole point of the ticket. Against the desktop
 * sources it does not — an `AbortSignal` crosses neither IPC bridge — so the
 * same trade would buy nothing and cost a second whole-corpus
 * `aggregateAnalytics` (27.1s, bounded-read lane) on every unmount/remount.
 *
 * Both branches are exercised here, and each is the other's control: the
 * `toHaveLength(1)` below is only worth anything because the identical harness
 * one test down reaches 2.
 */

const PROBE_SCOPE = "probe";

/** A read that never settles, so a query stays in flight across an unmount. */
function pending<T>(): Promise<T> {
  return new Promise<T>(() => {
    // Deliberately never settles.
  });
}

function createProbeSource(
  cancelsInFlightReads: boolean,
  analyticsCalls: (AgentSessionsReadOptions | undefined)[]
): AgentSessionsDataSource {
  return {
    scope: PROBE_SCOPE,
    cancelsInFlightReads,
    list: () => pending(),
    detail: () => pending(),
    usage: () => pending(),
    pageData: () => pending(),
    analytics: (_filters, options) => {
      analyticsCalls.push(options);
      return pending();
    },
  };
}

function createProbeWrapper(
  client: QueryClient,
  source: AgentSessionsDataSource
) {
  const adapter: ApiAdapter = {
    resolveApiOrigin: () => "http://sessions.test",
    fetch: () => pending(),
  };
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <AuthAdapterProvider adapter={createStaticAuthAdapter()}>
          <ApiAdapterProvider adapter={adapter}>
            <AgentSessionsDataSourceProvider dataSource={source}>
              {children}
            </AgentSessionsDataSourceProvider>
          </ApiAdapterProvider>
        </AuthAdapterProvider>
      </QueryClientProvider>
    );
  };
}

/** A client that keeps an unobserved query around long enough to remount onto. */
function createRetainingClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 60_000 } },
  });
}

function renderAnalyticsProbe(
  client: QueryClient,
  source: AgentSessionsDataSource
) {
  return renderHook(
    () => useAgentSessionAnalytics({ startDate: SEVEN_DAY_START }),
    { wrapper: createProbeWrapper(client, source) }
  );
}

describe("the analytics read claims cancellation only where it works (ISS-9741)", () => {
  it("hands no signal at all to a source that cannot cancel", async () => {
    const calls: (AgentSessionsReadOptions | undefined)[] = [];
    const source = createProbeSource(false, calls);

    renderAnalyticsProbe(createRetainingClient(), source);
    await waitFor(() => expect(calls).toHaveLength(1));

    // The options argument is absent entirely — that absence is what keeps
    // query-core from marking the query cancellable.
    expect(calls[0]).toBeUndefined();
  });

  // The consequence the previous case exists to protect, asserted on its own so
  // it cannot be shadowed by the argument-shape assertion above.
  it("keeps query-core's in-flight dedupe across an unmount when the source cannot cancel", async () => {
    const calls: (AgentSessionsReadOptions | undefined)[] = [];
    const client = createRetainingClient();
    const source = createProbeSource(false, calls);

    const first = renderAnalyticsProbe(client, source);
    await waitFor(() => expect(calls).toHaveLength(1));

    first.unmount();
    const second = renderAnalyticsProbe(client, source);
    await waitFor(() => expect(second.result.current.isFetching).toBe(true));

    // The scan started before the unmount is still the one being awaited.
    expect(calls).toHaveLength(1);
  });

  it("hands the signal to a source that can cancel, and pays the re-read that buys", async () => {
    const calls: (AgentSessionsReadOptions | undefined)[] = [];
    const client = createRetainingClient();
    const source = createProbeSource(true, calls);

    const first = renderAnalyticsProbe(client, source);
    await waitFor(() => expect(calls).toHaveLength(1));
    const signal = calls[0]?.signal;
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);

    first.unmount();
    // Consuming the signal is what earns the teardown — on this source the abort
    // reaches a transport that acts on it.
    await waitFor(() => expect(signal?.aborted).toBe(true));

    renderAnalyticsProbe(client, source);
    await waitFor(() => expect(calls).toHaveLength(2));
  });
});

import type {
  AgentSessionsChange,
  AgentSessionsDataSource,
} from "@repo/app/agents/data-source/agent-sessions-data-source";
import { AgentSessionsDataSourceProvider } from "@repo/app/agents/data-source/provider";
import { insightsKeys } from "@repo/app/insights/hooks/use-insights";
import type { ApiAdapter } from "@repo/app/shared/api/api-adapter";
import { ApiAdapterProvider } from "@repo/app/shared/api/provider";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { LIVE_BRIDGE_INSIGHTS_INVALIDATION_THROTTLE_MS } from "@repo/app/shared/hooks/use-live-query-bridge";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestProgress } from "../hooks/use-ingest-progress";
import { InsightsLiveBridge } from "../shared-agent-sessions/insights-live-bridge";

let invalidateSpy: ReturnType<typeof vi.spyOn>;

// ISS-11611: the bridge holds its backlog while the boot import is in progress,
// so the suite drives the same runtime-status projection production reads. The
// bridge consumes it through the real `useSessionsImportProgress` latch — only
// the main-process poll underneath is replaced.
const ingest: { current: IngestProgress | null } = { current: null };

vi.mock("../hooks/use-ingest-progress", () => ({
  useIngestProgress: () => ingest.current,
}));

function importing(): IngestProgress {
  return {
    byHarness: [],
    complete: false,
    preparing: false,
    processed: 3,
    total: 210,
  };
}

// ISS-11611 (whitlockk review): the intermediate snapshot the main process emits
// between the staggered per-harness passes and while a source is being retried —
// the aggregate counts have met, and the import has NOT settled. The gate must
// read this as still importing.
function betweenHarnessPasses(): IngestProgress {
  return {
    byHarness: [],
    complete: false,
    preparing: false,
    processed: 210,
    total: 210,
  };
}

function imported(): IngestProgress {
  return {
    byHarness: [],
    complete: true,
    preparing: false,
    processed: 210,
    total: 210,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  ingest.current = imported();
  invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const inertApiAdapter: ApiAdapter = {
  resolveApiOrigin: () => "http://desktop.local",
  fetch: () => Promise.reject(new Error("unused")),
};

function fakeSource(withSubscribe: boolean): {
  source: AgentSessionsDataSource;
  emit: (change?: AgentSessionsChange) => void;
} {
  let cb: ((change: AgentSessionsChange) => void) | null = null;
  const source: AgentSessionsDataSource = {
    scope: "local",
    list: () => Promise.resolve({ items: [], total: 0, viewerScope: "self" }),
    detail: () => Promise.reject(new Error("unused")),
    usage: () => Promise.reject(new Error("unused")),
    analytics: () => Promise.reject(new Error("unused")),
    pageData: () => Promise.reject(new Error("unused")),
    ...(withSubscribe
      ? {
          subscribe: (onChange: (change: AgentSessionsChange) => void) => {
            cb = onChange;
            return () => {
              cb = null;
            };
          },
        }
      : {}),
  };
  return { source, emit: (change: AgentSessionsChange = {}) => cb?.(change) };
}

// The client is a parameter, not a fresh instance per call: a rerender that
// swapped it would remount the bridge and discard the very backlog the
// settle-flush case is asserting.
function bridgeTree(source: AgentSessionsDataSource, client: QueryClient) {
  return (
    <QueryClientProvider client={client}>
      <AuthAdapterProvider adapter={createStaticAuthAdapter()}>
        <FeatureFlagAdapterProvider adapter={createStaticFeatureFlagAdapter()}>
          <ApiAdapterProvider adapter={inertApiAdapter}>
            <AgentSessionsDataSourceProvider dataSource={source}>
              <InsightsLiveBridge />
            </AgentSessionsDataSourceProvider>
          </ApiAdapterProvider>
        </FeatureFlagAdapterProvider>
      </AuthAdapterProvider>
    </QueryClientProvider>
  );
}

/**
 * Mount the bridge, and hand back a re-render that keeps the SAME tree and
 * query client — the only way a changed `useIngestProgress` value reaches the
 * bridge without remounting it (which would discard the held backlog).
 */
function renderBridge(source: AgentSessionsDataSource): {
  rerender: () => void;
} {
  const client = new QueryClient();
  const view = render(bridgeTree(source, client));
  return { rerender: () => view.rerender(bridgeTree(source, client)) };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function insightsInvalidations(): number {
  return invalidateSpy.mock.calls.filter((call: unknown[]) => {
    const filters = call[0] as { queryKey?: unknown } | undefined;
    return (
      Array.isArray(filters?.queryKey) &&
      JSON.stringify(filters.queryKey) === JSON.stringify(insightsKeys.all)
    );
  }).length;
}

function invalidatedInsightsAll(): boolean {
  return insightsInvalidations() > 0;
}

describe("InsightsLiveBridge", () => {
  it("invalidates insightsKeys.all after a throttled desktop:db:changed event", async () => {
    const fake = fakeSource(true);
    renderBridge(fake.source);

    fake.emit({ sessionId: "session-1" });
    await advance(LIVE_BRIDGE_INSIGHTS_INVALIDATION_THROTTLE_MS);

    expect(invalidatedInsightsAll()).toBe(true);
  });

  it("treats a scoped change as broad (still invalidates the whole insights namespace)", async () => {
    const fake = fakeSource(true);
    renderBridge(fake.source);

    // A `{ sessionId }` change still moves aggregates, so it invalidates the
    // root key rather than a per-session subset.
    fake.emit({ sessionId: "only-one" });
    await advance(LIVE_BRIDGE_INSIGHTS_INVALIDATION_THROTTLE_MS);

    expect(invalidatedInsightsAll()).toBe(true);
  });

  it("is a no-op for a source without subscribe (web HTTP source)", async () => {
    const fake = fakeSource(false);
    renderBridge(fake.source);

    fake.emit({});
    await advance(LIVE_BRIDGE_INSIGHTS_INVALIDATION_THROTTLE_MS * 2);

    expect(invalidatedInsightsAll()).toBe(false);
  });

  it("holds every flush while the boot import is in progress (ISS-11611)", async () => {
    ingest.current = importing();
    const fake = fakeSource(true);
    renderBridge(fake.source);

    // A continuous write stream for ten throttle windows: the backfill writer's
    // shape, and what used to drive a whole-table rollup every 5s.
    for (let i = 0; i < 10; i += 1) {
      fake.emit({ sessionId: `session-${i}` });
      await advance(LIVE_BRIDGE_INSIGHTS_INVALIDATION_THROTTLE_MS);
    }

    expect(insightsInvalidations()).toBe(0);
  });

  it("keeps holding on processed === total with complete false (ISS-11611)", async () => {
    ingest.current = importing();
    const fake = fakeSource(true);
    const view = renderBridge(fake.source);

    fake.emit({ sessionId: "during-import" });
    await advance(LIVE_BRIDGE_INSIGHTS_INVALIDATION_THROTTLE_MS);
    expect(insightsInvalidations()).toBe(0);

    // The counts meet between two harness passes; the import has not settled.
    ingest.current = betweenHarnessPasses();
    act(() => {
      view.rerender();
    });
    fake.emit({ sessionId: "next-pass" });
    await advance(LIVE_BRIDGE_INSIGHTS_INVALIDATION_THROTTLE_MS * 2);

    expect(insightsInvalidations()).toBe(0);
  });

  it("flushes the held backlog exactly once when the import settles (ISS-11611)", async () => {
    ingest.current = importing();
    const fake = fakeSource(true);
    const view = renderBridge(fake.source);

    fake.emit({ sessionId: "during-import-1" });
    fake.emit({ sessionId: "during-import-2" });
    await advance(LIVE_BRIDGE_INSIGHTS_INVALIDATION_THROTTLE_MS);
    expect(insightsInvalidations()).toBe(0);

    // The settled snapshot the next runtime-status poll would deliver.
    ingest.current = imported();
    act(() => {
      view.rerender();
    });
    await advance(LIVE_BRIDGE_INSIGHTS_INVALIDATION_THROTTLE_MS);

    expect(insightsInvalidations()).toBe(1);
  });

  it("refreshes at most once per insights throttle window after settle (ISS-11611)", async () => {
    const fake = fakeSource(true);
    renderBridge(fake.source);

    // Twelve changes spread across one window — the shape a live agent session
    // writing to the local DB produces.
    const step = LIVE_BRIDGE_INSIGHTS_INVALIDATION_THROTTLE_MS / 12;
    for (let i = 0; i < 12; i += 1) {
      fake.emit({ sessionId: `session-${i}` });
      await advance(step);
    }

    // The leading flush plus at most the one trailing flush the window
    // collapses the rest into.
    expect(insightsInvalidations()).toBeLessThanOrEqual(2);
  });
});

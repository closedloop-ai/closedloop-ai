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
import { LIVE_BRIDGE_INVALIDATION_THROTTLE_MS } from "@repo/app/shared/hooks/use-live-query-bridge";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InsightsLiveBridge } from "../shared-agent-sessions/insights-live-bridge";

let invalidateSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
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

function renderBridge(source: AgentSessionsDataSource) {
  render(
    <QueryClientProvider client={new QueryClient()}>
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

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function invalidatedInsightsAll(): boolean {
  return invalidateSpy.mock.calls.some((call: unknown[]) => {
    const filters = call[0] as { queryKey?: unknown } | undefined;
    return (
      Array.isArray(filters?.queryKey) &&
      JSON.stringify(filters.queryKey) === JSON.stringify(insightsKeys.all)
    );
  });
}

describe("InsightsLiveBridge", () => {
  it("invalidates insightsKeys.all after a throttled desktop:db:changed event", async () => {
    const fake = fakeSource(true);
    renderBridge(fake.source);

    fake.emit({ sessionId: "session-1" });
    await advance(LIVE_BRIDGE_INVALIDATION_THROTTLE_MS);

    expect(invalidatedInsightsAll()).toBe(true);
  });

  it("treats a scoped change as broad (still invalidates the whole insights namespace)", async () => {
    const fake = fakeSource(true);
    renderBridge(fake.source);

    // A `{ sessionId }` change still moves aggregates, so it invalidates the
    // root key rather than a per-session subset.
    fake.emit({ sessionId: "only-one" });
    await advance(LIVE_BRIDGE_INVALIDATION_THROTTLE_MS);

    expect(invalidatedInsightsAll()).toBe(true);
  });

  it("is a no-op for a source without subscribe (web HTTP source)", async () => {
    const fake = fakeSource(false);
    renderBridge(fake.source);

    fake.emit({});
    await advance(LIVE_BRIDGE_INVALIDATION_THROTTLE_MS * 2);

    expect(invalidatedInsightsAll()).toBe(false);
  });
});

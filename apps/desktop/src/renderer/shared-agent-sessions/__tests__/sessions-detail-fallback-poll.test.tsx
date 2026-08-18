import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import type {
  AgentSessionsChange,
  AgentSessionsDataSource,
} from "@repo/app/agents/data-source/agent-sessions-data-source";
import { AgentSessionsLiveBridge } from "@repo/app/agents/data-source/agent-sessions-live-bridge";
import { AgentSessionsDataSourceProvider } from "@repo/app/agents/data-source/provider";
import { useAgentSessionDetail } from "@repo/app/agents/hooks/use-agent-sessions";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyDesktopSessionsListPollDefaults,
  DESKTOP_SESSIONS_DETAIL_REFETCH_INTERVAL_MS,
} from "../sessions-list-poll-defaults";

/**
 * FEA-3481 (G4 / AC-8) — a desktop detail view open on a permanently-hidden
 * renderer must reflect a new sync within one poll interval.
 *
 * The shared live bridge that refreshes an open detail is visibility-gated: it
 * defers its flush while `document.hidden` is true and only replays the backlog
 * on a `visibilitychange` event. An offscreen/CI Electron window reports
 * `document.hidden` indefinitely and never fires `visibilitychange`, so a
 * post-import detail change is deferred FOREVER — the detail stays stale until a
 * manual refresh. These tests prove the detail fallback poll (mirroring the list
 * poll's intent) heals that gap, and that it runs in the background exactly when
 * the window is hidden.
 */

const SESSION_ID = "alpha";

let hiddenValue = false;
let originalHiddenDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  hiddenValue = false;
  originalHiddenDescriptor = Object.getOwnPropertyDescriptor(
    document,
    "hidden"
  );
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hiddenValue,
  });
});

afterEach(() => {
  vi.useRealTimers();
  if (originalHiddenDescriptor) {
    Object.defineProperty(document, "hidden", originalHiddenDescriptor);
  } else {
    // biome-ignore lint/performance/noDelete: restore jsdom's prototype getter
    delete (document as { hidden?: boolean }).hidden;
  }
});

/**
 * A live desktop-local-style source: `detail(id)` reads a mutable fixture (so a
 * poll-driven refetch observes the new sync), and `subscribe` feeds the live
 * bridge. Counts detail reads so the test asserts the refetch actually happened.
 */
function liveDetailSource() {
  let cb: ((change: AgentSessionsChange) => void) | null = null;
  let detailCalls = 0;
  let name = "before sync";
  const source: AgentSessionsDataSource = {
    scope: "local",
    list: () => Promise.resolve({ items: [], total: 0, viewerScope: "self" }),
    detail: (id: string) => {
      detailCalls += 1;
      return Promise.resolve({ id, name } as AgentSessionDetail);
    },
    usage: () => Promise.reject(new Error("unused")),
    analytics: () => Promise.reject(new Error("unused")),
    pageData: () => Promise.reject(new Error("unused")),
    subscribe: (onChange: (change: AgentSessionsChange) => void) => {
      cb = onChange;
      return () => {
        cb = null;
      };
    },
  };
  return {
    source,
    emit: (change: AgentSessionsChange = {}) => cb?.(change),
    detailCalls: () => detailCalls,
    setName: (next: string) => {
      name = next;
    },
  };
}

function DetailProbe({
  onName,
}: Readonly<{ onName: (name?: string | null) => void }>) {
  const { data } = useAgentSessionDetail(SESSION_ID);
  onName(data?.name);
  return null;
}

/** Advance fake timers inside `act` so query refetches settle cleanly. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/**
 * Settle a freshly-mounted/refetched query under fake timers without
 * testing-library's `waitFor` (which schedules on real timers and would hang).
 * A few small advances flush the data-source promise + React commit.
 */
async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await advance(1);
  }
}

/**
 * Build a QueryClient with the desktop poll defaults, mirroring local mode: pure
 * push model (staleTime ∞), retry off so a failed read doesn't muddy the
 * poll-count assertions.
 */
function pollingClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  applyDesktopSessionsListPollDefaults(client);
  return client;
}

/**
 * Wrap the tree in `AppCoreStoryProviders` (auth/api/navigation ports the shared
 * data-source + live bridge require) but override its QueryClient with our
 * poll-configured one via a nested `QueryClientProvider` — the nearest client
 * wins, so the poll defaults ride while auth stays satisfied.
 */
function PollHarness({
  client,
  source,
  children,
}: Readonly<{
  client: QueryClient;
  source: AgentSessionsDataSource;
  children: ReactNode;
}>) {
  return (
    <AppCoreStoryProviders>
      <QueryClientProvider client={client}>
        <AgentSessionsDataSourceProvider dataSource={source}>
          <AgentSessionsLiveBridge />
          {children}
        </AgentSessionsDataSourceProvider>
      </QueryClientProvider>
    </AppCoreStoryProviders>
  );
}

function renderDetail(
  source: AgentSessionsDataSource,
  onName: (name?: string | null) => void
) {
  return render(
    <PollHarness client={pollingClient()} source={source}>
      <DetailProbe onName={onName} />
    </PollHarness>
  );
}

describe("desktop detail fallback poll (FEA-3481 G4 / AC-8)", () => {
  it("reflects a new sync on a hidden renderer within one poll interval, without the bridge firing", async () => {
    const fake = liveDetailSource();
    let latestName: string | null | undefined;
    const onName = (name?: string | null) => {
      latestName = name;
    };

    // Open the detail view while the renderer is permanently hidden.
    hiddenValue = true;
    renderDetail(fake.source, onName);

    // Initial read resolves the pre-sync detail.
    await settle();
    expect(fake.detailCalls()).toBe(1);
    expect(latestName).toBe("before sync");

    // A new sync lands in the local DB and emits a scoped change. The live
    // bridge is visibility-gated, so while hidden it NEVER flushes (no
    // `visibilitychange` ever fires on this permanently-hidden renderer) — the
    // detail would be stale forever without the fallback poll.
    fake.setName("after sync");
    act(() => {
      fake.emit({ sessionId: SESSION_ID });
    });
    const afterEmit = fake.detailCalls();

    // Within one detail poll interval the fallback poll refetches the open
    // detail and the view reflects the new sync — even though the window stayed
    // hidden the whole time.
    await advance(DESKTOP_SESSIONS_DETAIL_REFETCH_INTERVAL_MS);
    await settle();
    expect(fake.detailCalls()).toBeGreaterThan(afterEmit);
    expect(latestName).toBe("after sync");
  });

  it("does not poll a detail with no active observer (cost stays O(open details))", async () => {
    const fake = liveDetailSource();

    // Mount the bridge + source but NO detail probe: the detail query has no
    // observer, so the poll default must not drive any detail reads.
    render(
      <PollHarness client={pollingClient()} source={fake.source}>
        {null}
      </PollHarness>
    );

    await advance(DESKTOP_SESSIONS_DETAIL_REFETCH_INTERVAL_MS * 3);
    expect(fake.detailCalls()).toBe(0);
  });
});

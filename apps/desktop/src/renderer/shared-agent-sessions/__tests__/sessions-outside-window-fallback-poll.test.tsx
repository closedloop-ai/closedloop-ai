import type { AgentSessionListResponse } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import type {
  AgentSessionsChange,
  AgentSessionsDataSource,
} from "@repo/app/agents/data-source/agent-sessions-data-source";
import { AgentSessionsLiveBridge } from "@repo/app/agents/data-source/agent-sessions-live-bridge";
import { AgentSessionsDataSourceProvider } from "@repo/app/agents/data-source/provider";
import { useSessionsOutsideWindow } from "@repo/app/agents/hooks/use-sessions-outside-window";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyDesktopSessionsListPollDefaults,
  DESKTOP_SESSIONS_HIDDEN_REFETCH_INTERVAL_MS,
} from "../sessions-list-poll-defaults";

/**
 * ISS-11913 — the outside-window probe on a permanently-hidden renderer. The
 * local client runs `staleTime: Infinity` and the live bridge defers its flush
 * while `document.hidden`, so a probe that answered "none" before the importer
 * landed older sessions heals only through the fallback poll.
 */

const WINDOW_ONLY = {
  customWindowActive: false,
  dateRange: DEFAULT_DATE_RANGE,
  isListSettledEmpty: true,
  otherFiltersActive: false,
};

let originalHiddenDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  originalHiddenDescriptor = Object.getOwnPropertyDescriptor(
    document,
    "hidden"
  );
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => true,
  });
});

afterEach(() => {
  vi.useRealTimers();
  if (originalHiddenDescriptor) {
    Object.defineProperty(document, "hidden", originalHiddenDescriptor);
  } else {
    Reflect.deleteProperty(document, "hidden");
  }
});

describe("outside-window probe on a hidden desktop renderer (ISS-11913)", () => {
  it("answers true within one hidden poll interval when older sessions are imported after it settled", async () => {
    const fake = importingSource();
    const { result } = renderHook(() => useSessionsOutsideWindow(WINDOW_ONLY), {
      wrapper: pollHarness(fake.source),
    });
    await settle();
    expect(result.current.hasSessionsOutsideWindow).toBe(false);
    const readsBeforeImport = fake.source.list.mock.calls.length;

    // The importer lands sessions older than the window. The bridge is
    // visibility-gated, so its invalidation never flushes on this renderer.
    fake.importOlderSessions(36);
    await settle();
    expect(fake.source.list).toHaveBeenCalledTimes(readsBeforeImport);
    expect(result.current.hasSessionsOutsideWindow).toBe(false);

    await advance(DESKTOP_SESSIONS_HIDDEN_REFETCH_INTERVAL_MS);
    await settle();
    expect(result.current.hasSessionsOutsideWindow).toBe(true);
  });
});

/** A local-style source whose population the test grows, feeding the bridge. */
function importingSource() {
  let total = 0;
  let onChange: ((change: AgentSessionsChange) => void) | undefined;
  const list = vi.fn(
    (): Promise<AgentSessionListResponse> =>
      Promise.resolve({
        items: [],
        total,
        viewerScope: AgentSessionViewerScope.Self,
      })
  );
  const source = {
    scope: "local",
    list,
    detail: () => Promise.reject(new Error("unused")),
    usage: () => Promise.reject(new Error("unused")),
    analytics: () => Promise.reject(new Error("unused")),
    pageData: () => Promise.reject(new Error("unused")),
    subscribe: (listener: (change: AgentSessionsChange) => void) => {
      onChange = listener;
      return () => {
        onChange = undefined;
      };
    },
  } satisfies AgentSessionsDataSource;
  return {
    source,
    importOlderSessions: (count: number) => {
      total += count;
      act(() => {
        onChange?.({});
      });
    },
  };
}

/** The desktop local client: push model (staleTime ∞) plus the poll defaults. */
function pollHarness(source: AgentSessionsDataSource) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  applyDesktopSessionsListPollDefaults(client);
  return function PollHarness({ children }: Readonly<{ children: ReactNode }>) {
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
  };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Flush the source promise and React commit without real-timer `waitFor`. */
async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await advance(1);
  }
}

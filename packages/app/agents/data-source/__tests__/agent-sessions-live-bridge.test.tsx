import { QueryClient } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import {
  agentSessionKeys,
  useAgentSessions,
} from "../../hooks/use-agent-sessions";
import type {
  AgentSessionQueryFilters,
  AgentSessionsChange,
  AgentSessionsDataSource,
} from "../agent-sessions-data-source";
import {
  AgentSessionsLiveBridge,
  INVALIDATION_THROTTLE_MS,
} from "../agent-sessions-live-bridge";
import { AgentSessionsDataSourceProvider } from "../provider";

let hiddenValue = false;
let originalHiddenDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  hiddenValue = false;
  // Capture the original own-descriptor (jsdom defines `hidden` on the
  // prototype, so this is normally undefined) to restore it verbatim afterward.
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

function liveFakeSource(withSubscribe: boolean) {
  let cb: ((change: AgentSessionsChange) => void) | null = null;
  let calls = 0;
  const source: AgentSessionsDataSource = {
    scope: "local",
    list: () => {
      calls += 1;
      return Promise.resolve({ items: [], total: calls, viewerScope: "self" });
    },
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
  return {
    source,
    emit: (change: AgentSessionsChange = {}) => cb?.(change),
    listCalls: () => calls,
  };
}

function ListProbe({
  filters = {},
}: Readonly<{ filters?: AgentSessionQueryFilters }>) {
  useAgentSessions(filters);
  return null;
}

/** Advance fake timers inside `act` so query refetches settle cleanly. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function renderBridge(
  source: AgentSessionsDataSource,
  listFilters: AgentSessionQueryFilters = {}
) {
  return render(
    <AppCoreStoryProviders>
      <AgentSessionsDataSourceProvider dataSource={source}>
        <AgentSessionsLiveBridge />
        <ListProbe filters={listFilters} />
      </AgentSessionsDataSourceProvider>
    </AppCoreStoryProviders>
  );
}

describe("AgentSessionsLiveBridge", () => {
  it("invalidates the active list query after a throttled DB change", async () => {
    const fake = liveFakeSource(true);
    renderBridge(fake.source);

    await advance(INVALIDATION_THROTTLE_MS);
    expect(fake.listCalls()).toBe(1);

    fake.emit({ sessionId: "session-1" });
    await advance(INVALIDATION_THROTTLE_MS);
    expect(fake.listCalls()).toBe(2);
  });

  it("suppresses a second change within the throttle window until the boundary", async () => {
    const fake = liveFakeSource(true);
    renderBridge(fake.source);

    await advance(INVALIDATION_THROTTLE_MS);
    expect(fake.listCalls()).toBe(1);

    // First change flushes promptly and stamps `lastInvalidatedAt`. Advance only
    // a tick (not a full window) so the next change lands *inside* the throttle
    // window rather than a full window later.
    fake.emit({ sessionId: "a" });
    await advance(1);
    expect(fake.listCalls()).toBe(2);

    // A second change inside the window must wait out the remaining window rather
    // than refetch immediately — this exercises the positive-remainder wait path
    // that the full-window advances elsewhere never reach.
    fake.emit({ sessionId: "b" });
    await advance(INVALIDATION_THROTTLE_MS / 2);
    expect(fake.listCalls()).toBe(2); // still suppressed mid-window

    await advance(INVALIDATION_THROTTLE_MS);
    expect(fake.listCalls()).toBe(3); // flushed once the window elapsed
  });

  it("collapses a burst of changes into a single refetch", async () => {
    const fake = liveFakeSource(true);
    renderBridge(fake.source);

    await advance(INVALIDATION_THROTTLE_MS);
    expect(fake.listCalls()).toBe(1);

    fake.emit({});
    fake.emit({ sessionId: "a" });
    fake.emit({ sessionId: "b" });
    await advance(INVALIDATION_THROTTLE_MS);

    // One trailing invalidation for the whole burst, not one per event.
    expect(fake.listCalls()).toBe(2);
  });

  it("defers invalidation while hidden and flushes on re-show", async () => {
    hiddenValue = true;
    const fake = liveFakeSource(true);
    renderBridge(fake.source);

    await advance(INVALIDATION_THROTTLE_MS);
    expect(fake.listCalls()).toBe(1);

    fake.emit({});
    await advance(INVALIDATION_THROTTLE_MS);
    expect(fake.listCalls()).toBe(1); // no offscreen refetch

    hiddenValue = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await advance(INVALIDATION_THROTTLE_MS);
    expect(fake.listCalls()).toBe(2); // backlog flushed
  });

  it("is a no-op for a source without subscribe", async () => {
    const fake = liveFakeSource(false);
    renderBridge(fake.source);

    await advance(INVALIDATION_THROTTLE_MS * 2);
    expect(fake.listCalls()).toBe(1);
  });

  it("keeps refreshing after a failed refetch (recovers on the next change)", async () => {
    let calls = 0;
    let emitChange: (change: AgentSessionsChange) => void = () => undefined;
    const source: AgentSessionsDataSource = {
      scope: "local",
      // The first live refetch (call #2) fails transiently; later calls succeed.
      list: () => {
        calls += 1;
        if (calls === 2) {
          return Promise.reject(new Error("transient source failure"));
        }
        return Promise.resolve({
          items: [],
          total: calls,
          viewerScope: "self",
        });
      },
      detail: () => Promise.reject(new Error("unused")),
      usage: () => Promise.reject(new Error("unused")),
      analytics: () => Promise.reject(new Error("unused")),
      subscribe: (onChange) => {
        emitChange = onChange;
        return () => {
          emitChange = () => undefined;
        };
      },
    };
    renderBridge(source);

    await advance(INVALIDATION_THROTTLE_MS);
    expect(calls).toBe(1); // initial load

    emitChange({}); // refetch #2 → fails
    await advance(INVALIDATION_THROTTLE_MS);
    expect(calls).toBe(2); // single attempt, no retry storm (retry: false)

    emitChange({}); // next change → refetch #3 → succeeds
    await advance(INVALIDATION_THROTTLE_MS);
    expect(calls).toBe(3); // recovered on its own, no error loop
  });

  it("retains selected-user filters through live refresh and recovery", async () => {
    const capturedFilters: AgentSessionQueryFilters[] = [];
    let calls = 0;
    let emitChange: (change: AgentSessionsChange) => void = () => undefined;
    const source: AgentSessionsDataSource = {
      scope: "local",
      list: (filters) => {
        calls += 1;
        capturedFilters.push(filters);
        if (calls === 2) {
          return Promise.reject(new Error("transient source failure"));
        }
        return Promise.resolve({
          items: [],
          total: calls,
          viewerScope: "self",
        });
      },
      detail: () => Promise.reject(new Error("unused")),
      usage: () => Promise.reject(new Error("unused")),
      analytics: () => Promise.reject(new Error("unused")),
      subscribe: (onChange) => {
        emitChange = onChange;
        return () => {
          emitChange = () => undefined;
        };
      },
    };
    renderBridge(source, { userId: "user-1" });

    await advance(INVALIDATION_THROTTLE_MS);
    emitChange({ sessionId: "matching-user-session" });
    await advance(INVALIDATION_THROTTLE_MS);
    emitChange({ sessionId: "other-user-session" });
    await advance(INVALIDATION_THROTTLE_MS);

    expect(capturedFilters).toEqual([
      { userId: "user-1" },
      { userId: "user-1" },
      { userId: "user-1" },
    ]);
  });
});

describe("AgentSessionsLiveBridge invalidation scoping", () => {
  let invalidateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
  });

  afterEach(() => {
    invalidateSpy.mockRestore();
  });

  function invalidatedKeys(): string[] {
    const keys: string[] = [];
    for (const call of invalidateSpy.mock.calls) {
      const filters = (call as unknown[])[0] as
        | { queryKey?: unknown }
        | undefined;
      if (Array.isArray(filters?.queryKey)) {
        keys.push(JSON.stringify(filters.queryKey));
      }
    }
    return keys;
  }

  it("scopes a sessionId change to list + usage + that one detail, never analytics", async () => {
    const fake = liveFakeSource(true);
    renderBridge(fake.source);
    await advance(INVALIDATION_THROTTLE_MS);
    invalidateSpy.mockClear();

    fake.emit({ sessionId: "s1" });
    await advance(INVALIDATION_THROTTLE_MS);

    const keys = invalidatedKeys();
    expect(keys).toContain(JSON.stringify(agentSessionKeys.lists()));
    expect(keys).toContain(JSON.stringify(agentSessionKeys.usages()));
    // Detail keys are scope-qualified; the live fake source's scope is "local".
    expect(keys).toContain(
      JSON.stringify(agentSessionKeys.detail("local", "s1"))
    );
    // A scoped event never invalidates analytics or the whole detail namespace.
    expect(keys).not.toContain(
      JSON.stringify(agentSessionKeys.analyticsRoot())
    );
    expect(keys).not.toContain(JSON.stringify(agentSessionKeys.details()));
  });

  it("expands a {} change to list + usage + all details, never analytics", async () => {
    const fake = liveFakeSource(true);
    renderBridge(fake.source);
    await advance(INVALIDATION_THROTTLE_MS);
    invalidateSpy.mockClear();

    fake.emit({});
    await advance(INVALIDATION_THROTTLE_MS);

    const keys = invalidatedKeys();
    expect(keys).toContain(JSON.stringify(agentSessionKeys.lists()));
    expect(keys).toContain(JSON.stringify(agentSessionKeys.usages()));
    expect(keys).toContain(JSON.stringify(agentSessionKeys.details()));
    expect(keys).not.toContain(
      JSON.stringify(agentSessionKeys.analyticsRoot())
    );
  });
});

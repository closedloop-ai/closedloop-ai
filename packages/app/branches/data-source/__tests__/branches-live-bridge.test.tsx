import { QueryClient } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { makeBranchAnalytics } from "../../components/branch-analytics-fixtures";
import {
  type BranchesQueryIdentity,
  branchesKeys,
  useBranchCohortAnalytics,
  useBranchesPageData,
} from "../../hooks/use-branches";
import type {
  BranchesChange,
  BranchesDataSource,
} from "../branches-data-source";
import {
  BranchesLiveBridge,
  INVALIDATION_THROTTLE_MS,
} from "../branches-live-bridge";
import { BranchesDataSourceProvider } from "../provider";

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

const ANALYTICS_FIXTURE = makeBranchAnalytics();

function liveFakeSource(withSubscribe: boolean) {
  let cb: ((change: BranchesChange) => void) | null = null;
  let calls = 0;
  let cohortCalls = 0;
  const source: BranchesDataSource = {
    scope: "local",
    list: () => Promise.reject(new Error("unused")),
    detail: () => Promise.reject(new Error("unused")),
    comments: () => Promise.reject(new Error("unused")),
    trace: () => Promise.reject(new Error("unused")),
    usage: () => Promise.reject(new Error("unused")),
    analytics: () => Promise.reject(new Error("unused")),
    cohortAnalytics: () => {
      cohortCalls += 1;
      return Promise.resolve(null);
    },
    pageData: () => {
      calls += 1;
      return Promise.resolve({
        list: { items: [], total: calls, viewerScope: "self" as const },
        analytics: ANALYTICS_FIXTURE,
      });
    },
    ...(withSubscribe
      ? {
          subscribe: (onChange: (change: BranchesChange) => void) => {
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
    emit: (change: BranchesChange = {}) => cb?.(change),
    cohortCalls: () => cohortCalls,
    listCalls: () => calls,
  };
}

function ListProbe() {
  useBranchesPageData({});
  useBranchCohortAnalytics({ branchIds: ["repo%2Fowner::main"] });
  return null;
}

/** Advance fake timers inside `act` so query refetches settle cleanly. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function renderBridge(
  source: BranchesDataSource,
  queryIdentity?: BranchesQueryIdentity
) {
  return render(
    <AppCoreStoryProviders>
      <BranchesDataSourceProvider
        dataSource={source}
        queryIdentity={queryIdentity}
        queryPolicy={{ staleTime: Number.POSITIVE_INFINITY }}
      >
        <BranchesLiveBridge />
        <ListProbe />
      </BranchesDataSourceProvider>
    </AppCoreStoryProviders>
  );
}

describe("BranchesLiveBridge", () => {
  it("invalidates the active list query after a throttled DB change", async () => {
    const fake = liveFakeSource(true);
    renderBridge(fake.source);

    await advance(INVALIDATION_THROTTLE_MS);
    expect(fake.listCalls()).toBe(1);
    expect(fake.cohortCalls()).toBe(1);

    fake.emit({ branchId: "repo%2Fowner::main" });
    await advance(INVALIDATION_THROTTLE_MS);
    expect(fake.listCalls()).toBe(2);
    expect(fake.cohortCalls()).toBe(2);
  });

  it("collapses a burst of changes into a single refetch", async () => {
    const fake = liveFakeSource(true);
    renderBridge(fake.source);

    await advance(INVALIDATION_THROTTLE_MS);
    expect(fake.listCalls()).toBe(1);

    fake.emit({});
    fake.emit({ branchId: "a" });
    fake.emit({ branchId: "b" });
    await advance(INVALIDATION_THROTTLE_MS);

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

  it("waits out the REMAINING throttle when re-shown within the window", async () => {
    const fake = liveFakeSource(true);
    renderBridge(fake.source);
    await advance(INVALIDATION_THROTTLE_MS);
    expect(fake.listCalls()).toBe(1);

    // First flush anchors the throttle window (lastInvalidatedAt := now). A tiny
    // advance fires the (0ms) first flush without consuming the window.
    fake.emit({});
    await advance(50);
    expect(fake.listCalls()).toBe(2);

    // Partway into the window, hide -> emit (deferred) -> re-show.
    await advance(INVALIDATION_THROTTLE_MS / 2);
    hiddenValue = true;
    document.dispatchEvent(new Event("visibilitychange"));
    fake.emit({});
    hiddenValue = false;
    document.dispatchEvent(new Event("visibilitychange"));

    // The re-show schedules with only the REMAINING window — NOT an immediate
    // flush (the bug a `lastInvalidatedAt = 0` test can't catch). Just before the
    // original boundary, nothing has refetched.
    await advance(INVALIDATION_THROTTLE_MS / 2 - 200);
    expect(fake.listCalls()).toBe(2);

    // Past the boundary, the deferred change flushes exactly once.
    await advance(400);
    expect(fake.listCalls()).toBe(3);
  });

  it("is a no-op for a source without subscribe", async () => {
    const fake = liveFakeSource(false);
    renderBridge(fake.source);

    await advance(INVALIDATION_THROTTLE_MS * 2);
    expect(fake.listCalls()).toBe(1);
  });
});

describe("BranchesLiveBridge invalidation scoping", () => {
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

  it("scopes a branchId change to corpus reads + that one detail + trace + comments", async () => {
    const fake = liveFakeSource(true);
    renderBridge(fake.source);
    await advance(INVALIDATION_THROTTLE_MS);
    invalidateSpy.mockClear();

    fake.emit({ branchId: "b1" });
    await advance(INVALIDATION_THROTTLE_MS);

    const keys = invalidatedKeys();
    expect(keys).toContain(JSON.stringify(branchesKeys.usages()));
    expect(keys).toContain(JSON.stringify(branchesKeys.analyticsRoot()));
    expect(keys).toContain(JSON.stringify(branchesKeys.cohortAnalyticsRoot()));
    expect(keys).toContain(JSON.stringify(branchesKeys.pageDataRoot()));
    expect(keys).toContain(JSON.stringify(branchesKeys.detail("local", "b1")));
    // PLN-1148 Phase 2: the lazy trace is scoped to its own branch, not broad.
    expect(keys).toContain(JSON.stringify(branchesKeys.trace("local", "b1")));
    expect(keys).toContain(
      JSON.stringify(branchesKeys.comments("local", "b1"))
    );
    expect(keys).not.toContain(JSON.stringify(branchesKeys.details()));
    expect(keys).not.toContain(JSON.stringify(branchesKeys.traces()));
    expect(keys).not.toContain(JSON.stringify(branchesKeys.commentsRoot()));
  });

  it("applies the active cache identity to scoped branch invalidations", async () => {
    const queryIdentity = { cacheScope: "desktop-local" };
    const fake = liveFakeSource(true);
    renderBridge(fake.source, queryIdentity);
    await advance(INVALIDATION_THROTTLE_MS);
    invalidateSpy.mockClear();

    fake.emit({ branchId: "b1" });
    await advance(INVALIDATION_THROTTLE_MS);

    const keys = invalidatedKeys();
    expect(keys).toContain(
      JSON.stringify(branchesKeys.detail("local", "b1", queryIdentity))
    );
    expect(keys).toContain(
      JSON.stringify(branchesKeys.trace("local", "b1", queryIdentity))
    );
    expect(keys).toContain(
      JSON.stringify(branchesKeys.comments("local", "b1", queryIdentity))
    );
    expect(keys).not.toContain(
      JSON.stringify(branchesKeys.detail("local", "b1"))
    );
  });

  it("expands a {} change to every corpus and branch-scoped read", async () => {
    const fake = liveFakeSource(true);
    renderBridge(fake.source);
    await advance(INVALIDATION_THROTTLE_MS);
    invalidateSpy.mockClear();

    fake.emit({});
    await advance(INVALIDATION_THROTTLE_MS);

    const keys = invalidatedKeys();
    expect(keys).toContain(JSON.stringify(branchesKeys.usages()));
    expect(keys).toContain(JSON.stringify(branchesKeys.analyticsRoot()));
    expect(keys).toContain(JSON.stringify(branchesKeys.cohortAnalyticsRoot()));
    expect(keys).toContain(JSON.stringify(branchesKeys.pageDataRoot()));
    expect(keys).toContain(JSON.stringify(branchesKeys.details()));
    // PLN-1148 Phase 2: a broad change refreshes every open trace too.
    expect(keys).toContain(JSON.stringify(branchesKeys.traces()));
    expect(keys).toContain(JSON.stringify(branchesKeys.commentsRoot()));
  });
});

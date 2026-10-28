import type {
  AgentComponent,
  AgentComponentDetail,
  AgentComponentsChange,
} from "@repo/api/src/types/agent-component";
import { QueryClient } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import {
  makeComponent,
  makeDetail,
} from "../../components/workspace/agent-component-fixtures";
import { useAgentComponentDetail } from "../../hooks/use-agent-component-detail";
import {
  agentComponentKeys,
  useAgentComponents,
} from "../../hooks/use-agent-components";
import type { AgentComponentsDataSource } from "../agent-components-data-source";
import {
  AgentComponentsLiveBridge,
  COMPONENTS_INVALIDATION_THROTTLE_MS,
} from "../agent-components-live-bridge";
import { AgentComponentsDataSourceProvider } from "../provider";

/**
 * ISS-6882 regression suite for the Agents-workspace live bridge.
 *
 * The harness deliberately mirrors production's cache posture: the shared
 * `AppCoreStoryProviders` QueryClient runs `staleTime: Infinity` (as the desktop
 * local client does), so a cached query can ONLY move through an explicit
 * invalidation. Every case below primes the cache first and then asserts the
 * RENDERED population changed — not that a callback fired.
 */

const SOURCE_SCOPE = "agent-components:local";

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

function liveFakeSource(withSubscribe: boolean) {
  let cb: ((change: AgentComponentsChange) => void) | null = null;
  let names = ["Alpha Agent"];
  let detailName = "Alpha Detail";
  let listCalls = 0;
  const source: AgentComponentsDataSource = {
    scope: SOURCE_SCOPE,
    honorsDateWindow: false,
    list: () => {
      listCalls += 1;
      return Promise.resolve({
        items: names.map((name) => componentRow(name)),
        total: names.length,
        hasMore: false,
      });
    },
    detail: () => Promise.resolve(componentDetail(detailName)),
    ...(withSubscribe
      ? {
          subscribe: (onChange: (change: AgentComponentsChange) => void) => {
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
    emit: (change: AgentComponentsChange = {}) => cb?.(change),
    listCalls: () => listCalls,
    setRows: (next: readonly string[]) => {
      names = [...next];
    },
    setDetailName: (next: string) => {
      detailName = next;
    },
  };
}

function ListProbe() {
  const { data } = useAgentComponents({ limit: 500 });
  return (
    <div data-testid="rows">
      {(data?.items ?? []).map((r) => r.name).join()}
    </div>
  );
}

function DetailProbe() {
  const { data } = useAgentComponentDetail("agent::alpha");
  return <div data-testid="detail">{data?.name ?? ""}</div>;
}

/** Advance fake timers inside `act` so query refetches settle cleanly. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function renderBridge(source: AgentComponentsDataSource) {
  return render(
    <AppCoreStoryProviders>
      <AgentComponentsDataSourceProvider dataSource={source}>
        <AgentComponentsLiveBridge />
        <ListProbe />
        <DetailProbe />
      </AgentComponentsDataSourceProvider>
    </AppCoreStoryProviders>
  );
}

function renderedRows(): string {
  return screen.getByTestId("rows").textContent ?? "";
}

function renderedDetail(): string {
  return screen.getByTestId("detail").textContent ?? "";
}

describe("AgentComponentsLiveBridge", () => {
  it("replaces the rendered component population after a DB change", async () => {
    const fake = liveFakeSource(true);
    renderBridge(fake.source);

    // Prime the cache. Under staleTime: Infinity this row is now pinned — the
    // only thing that can replace it is an invalidation from the bridge.
    await advance(COMPONENTS_INVALIDATION_THROTTLE_MS);
    expect(renderedRows()).toBe("Alpha Agent");

    // An import lands in the local DB.
    fake.setRows(["Alpha Agent", "Beta Skill"]);
    fake.emit({});
    await advance(COMPONENTS_INVALIDATION_THROTTLE_MS);

    expect(renderedRows()).toBe("Alpha Agent,Beta Skill");
  });

  it("refreshes an open component detail after a broad DB change", async () => {
    const fake = liveFakeSource(true);
    renderBridge(fake.source);

    await advance(COMPONENTS_INVALIDATION_THROTTLE_MS);
    expect(renderedDetail()).toBe("Alpha Detail");

    // An uninstall/rescan rewrites the row behind the open detail.
    fake.setDetailName("Alpha Detail (rescanned)");
    fake.emit({});
    await advance(COMPONENTS_INVALIDATION_THROTTLE_MS);

    expect(renderedDetail()).toBe("Alpha Detail (rescanned)");
  });

  it("drops the last row from the rendered population on an uninstall", async () => {
    const fake = liveFakeSource(true);
    renderBridge(fake.source);

    await advance(COMPONENTS_INVALIDATION_THROTTLE_MS);
    expect(renderedRows()).toBe("Alpha Agent");

    // The empty state is derived from the same list read, so it can only be
    // reached live through the same invalidation channel.
    fake.setRows([]);
    fake.emit({});
    await advance(COMPONENTS_INVALIDATION_THROTTLE_MS);

    expect(renderedRows()).toBe("");
  });

  it("collapses a burst of changes into a single refetch", async () => {
    const fake = liveFakeSource(true);
    renderBridge(fake.source);

    await advance(COMPONENTS_INVALIDATION_THROTTLE_MS);
    expect(fake.listCalls()).toBe(1);

    fake.emit({});
    fake.emit({ componentId: "agent::alpha" });
    fake.emit({ componentId: "skill::beta" });
    await advance(COMPONENTS_INVALIDATION_THROTTLE_MS);

    expect(fake.listCalls()).toBe(2);
  });

  it("defers invalidation while hidden and flushes on re-show", async () => {
    hiddenValue = true;
    const fake = liveFakeSource(true);
    renderBridge(fake.source);

    await advance(COMPONENTS_INVALIDATION_THROTTLE_MS);
    expect(renderedRows()).toBe("Alpha Agent");

    fake.setRows(["Alpha Agent", "Beta Skill"]);
    fake.emit({});
    await advance(COMPONENTS_INVALIDATION_THROTTLE_MS);
    expect(renderedRows()).toBe("Alpha Agent"); // no offscreen refetch

    hiddenValue = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await advance(COMPONENTS_INVALIDATION_THROTTLE_MS);
    expect(renderedRows()).toBe("Alpha Agent,Beta Skill"); // backlog flushed
  });

  it("is a no-op for a source without subscribe (the HTTP/cloud source)", async () => {
    const fake = liveFakeSource(false);
    renderBridge(fake.source);

    await advance(COMPONENTS_INVALIDATION_THROTTLE_MS);
    expect(fake.listCalls()).toBe(1);

    fake.setRows(["Alpha Agent", "Beta Skill"]);
    await advance(COMPONENTS_INVALIDATION_THROTTLE_MS * 2);

    expect(fake.listCalls()).toBe(1);
    expect(renderedRows()).toBe("Alpha Agent");
  });

  it("recovers on the next change after a failed live refetch", async () => {
    let calls = 0;
    let emitChange: (change: AgentComponentsChange) => void = () => undefined;
    const source: AgentComponentsDataSource = {
      scope: SOURCE_SCOPE,
      honorsDateWindow: false,
      list: () => {
        calls += 1;
        if (calls === 2) {
          return Promise.reject(new Error("transient source failure"));
        }
        return Promise.resolve({
          items: [componentRow(`Alpha Agent ${calls}`)],
          total: 1,
          hasMore: false,
        });
      },
      detail: () => Promise.resolve(componentDetail("Alpha Detail")),
      subscribe: (onChange) => {
        emitChange = onChange;
        return () => {
          emitChange = () => undefined;
        };
      },
    };
    render(
      <AppCoreStoryProviders>
        <AgentComponentsDataSourceProvider dataSource={source}>
          <AgentComponentsLiveBridge />
          <ListProbe />
        </AgentComponentsDataSourceProvider>
      </AppCoreStoryProviders>
    );

    await advance(COMPONENTS_INVALIDATION_THROTTLE_MS);
    expect(renderedRows()).toBe("Alpha Agent 1");

    emitChange({}); // refetch #2 → fails
    await advance(COMPONENTS_INVALIDATION_THROTTLE_MS);
    expect(calls).toBe(2);
    // Stale-on-error: the last-good population stays rendered, no blank wipe.
    expect(renderedRows()).toBe("Alpha Agent 1");

    emitChange({}); // refetch #3 → succeeds
    await advance(COMPONENTS_INVALIDATION_THROTTLE_MS);
    expect(renderedRows()).toBe("Alpha Agent 3");
  });
});

describe("AgentComponentsLiveBridge invalidation scoping", () => {
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

  it("expands a {} change to the whole component family (list + all details)", async () => {
    const fake = liveFakeSource(true);
    renderBridge(fake.source);
    await advance(COMPONENTS_INVALIDATION_THROTTLE_MS);
    invalidateSpy.mockClear();

    fake.emit({});
    await advance(COMPONENTS_INVALIDATION_THROTTLE_MS);

    const keys = invalidatedKeys();
    // `lists()` is the prefix over the table page, the unwindowed facet-option
    // universe, and the preceding-window baseline the summary deltas read.
    expect(keys).toContain(JSON.stringify(agentComponentKeys.lists()));
    expect(keys).toContain(JSON.stringify(agentComponentKeys.details()));
  });

  it("scopes a componentId change to the list plus that one detail", async () => {
    const fake = liveFakeSource(true);
    renderBridge(fake.source);
    await advance(COMPONENTS_INVALIDATION_THROTTLE_MS);
    invalidateSpy.mockClear();

    fake.emit({ componentId: "agent::alpha" });
    await advance(COMPONENTS_INVALIDATION_THROTTLE_MS);

    const keys = invalidatedKeys();
    expect(keys).toContain(JSON.stringify(agentComponentKeys.lists()));
    expect(keys).toContain(
      JSON.stringify(agentComponentKeys.detail(SOURCE_SCOPE, "agent::alpha"))
    );
    // A scoped change must not sweep every open detail.
    expect(keys).not.toContain(JSON.stringify(agentComponentKeys.details()));
  });
});

function componentRow(name: string): AgentComponent {
  return makeComponent({ id: "uuid-alpha", name, slug: "agent::alpha" });
}

function componentDetail(name: string): AgentComponentDetail {
  return makeDetail({ id: "uuid-alpha", name, slug: "agent::alpha" });
}

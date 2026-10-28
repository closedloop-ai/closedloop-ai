import type {
  AgentSessionAnalytics,
  AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import {
  createAgentSessionAnalyticsFixture,
  createAgentSessionUsageSummaryFixture,
} from "../../components/sessions/session-list-fixtures";
import {
  useAgentSessionAnalytics,
  useAgentSessions,
  useAgentSessionUsage,
} from "../../hooks/use-agent-sessions";
import type {
  AgentSessionsChange,
  AgentSessionsDataSource,
} from "../agent-sessions-data-source";
import {
  AgentSessionsLiveBridge,
  INVALIDATION_THROTTLE_MS,
} from "../agent-sessions-live-bridge";
import { AgentSessionsDataSourceProvider } from "../provider";

/**
 * ISS-9553 — the sessions list must converge on RENDERED CONTENT after a sync.
 *
 * The sibling suite asserts which keys the bridge hands `invalidateQueries`.
 * That proves a request was issued, not that a reader stops seeing pre-sync
 * rows — and "reader still looking at stale rows in a settled view" is the whole
 * defect class. This drives the production hook and asserts on what it renders.
 */

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

const STALE_SESSION_ID = "pre-sync-session";
const FRESH_SESSION_ID = "post-sync-session";

type ObservedQuery = {
  status: string;
  sessionIds: readonly string[];
};

/**
 * Answers with the stale row first and the fresh row afterwards, so convergence
 * is observable as a change in content. `failAfterFirst` makes only the REFETCH
 * fail, which is the failure that actually rides the convergence path.
 */
function listFakeSource(options: { failAfterFirst?: boolean } = {}) {
  let cb: ((change: AgentSessionsChange) => void) | null = null;
  let calls = 0;
  const source: AgentSessionsDataSource = {
    scope: "local",
    list: () => {
      calls += 1;
      if (options.failAfterFirst && calls > 1) {
        return Promise.reject(new Error("sessions list refetch failed"));
      }
      return Promise.resolve({
        items: [
          { id: calls === 1 ? STALE_SESSION_ID : FRESH_SESSION_ID },
        ] as never,
        total: 1,
        viewerScope: "self" as const,
      });
    },
    detail: () => Promise.reject(new Error("unused")),
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
    listCalls: () => calls,
  };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function renderListBridge(source: AgentSessionsDataSource) {
  const observed: ObservedQuery = { status: "idle", sessionIds: [] };

  function ListProbe() {
    const query = useAgentSessions({}, { retry: false });
    observed.status = query.status;
    observed.sessionIds = (query.data?.items ?? []).map((item) => item.id);
    return null;
  }

  render(
    <AppCoreStoryProviders>
      <AgentSessionsDataSourceProvider dataSource={source}>
        <AgentSessionsLiveBridge />
        <ListProbe />
      </AgentSessionsDataSourceProvider>
    </AppCoreStoryProviders>
  );

  return observed;
}

describe("AgentSessionsLiveBridge list convergence", () => {
  it("replaces stale rows with post-sync rows after a scoped change", async () => {
    const fake = listFakeSource();
    const observed = renderListBridge(fake.source);

    await advance(INVALIDATION_THROTTLE_MS);
    // Positive baseline: the reader really is holding the stale row, so the
    // assertion below cannot pass on a cache that simply never populated.
    expect(observed.sessionIds).toEqual([STALE_SESSION_ID]);
    expect(observed.status).toBe("success");

    fake.emit({ sessionId: STALE_SESSION_ID });
    await advance(INVALIDATION_THROTTLE_MS);

    expect(observed.sessionIds).toEqual([FRESH_SESSION_ID]);
    expect(observed.status).toBe("success");
  });

  it("replaces stale rows after a broad change with no session id", async () => {
    const fake = listFakeSource();
    const observed = renderListBridge(fake.source);

    await advance(INVALIDATION_THROTTLE_MS);
    expect(observed.sessionIds).toEqual([STALE_SESSION_ID]);

    fake.emit({});
    await advance(INVALIDATION_THROTTLE_MS);

    expect(observed.sessionIds).toEqual([FRESH_SESSION_ID]);
  });

  it("does not replace rows without a change event", async () => {
    // Counterfactual control for the two cases above: with no event the row must
    // NOT change, so neither can pass on an incidental refetch.
    const fake = listFakeSource();
    const observed = renderListBridge(fake.source);

    await advance(INVALIDATION_THROTTLE_MS * 4);

    expect(fake.listCalls()).toBe(1);
    expect(observed.sessionIds).toEqual([STALE_SESSION_ID]);
  });

  it("surfaces a failed post-sync refetch as an error, never as a settled empty list", async () => {
    // The false settled state ON the convergence path: the sync-driven refetch
    // is what fails, and the view must not answer that with a settled, empty
    // table that reads as "this org genuinely has no sessions".
    const fake = listFakeSource({ failAfterFirst: true });
    const observed = renderListBridge(fake.source);

    await advance(INVALIDATION_THROTTLE_MS);
    expect(observed.sessionIds).toEqual([STALE_SESSION_ID]);

    fake.emit({});
    await advance(INVALIDATION_THROTTLE_MS);

    expect(fake.listCalls()).toBeGreaterThan(1);
    expect(observed.status).toBe("error");
    expect(observed.status).not.toBe("success");
    // Last-known rows are retained rather than blanked, so the reader is never
    // shown an empty table that a failed read manufactured.
    expect(observed.sessionIds).toEqual([STALE_SESSION_ID]);
  });
});

/**
 * davetho review — the Repository FACET, not just the table.
 *
 * The facet's options come from the usage summary's `byRepository`, and fall
 * back to the analytics aggregate whenever that summary reports none (ISS-5273;
 * `needsAnalyticsRepositoryFallback` in the desktop render model gates both the
 * read and the consumer on one predicate). `usages` converging only retires that
 * fallback when the refreshed summary GAINS repositories. While it persistently
 * reports none — the case these cover — the fallback stays the only source of
 * options, and desktop holds the query at `staleTime: Infinity`, so an excluded
 * `analyticsRoot` left the facet on pre-sync options until remount.
 */
describe("AgentSessionsLiveBridge Repository-facet convergence", () => {
  it("refreshes the fallback while the usage summary keeps reporting no repositories", async () => {
    const fake = facetFakeSource({ usageRepositories: [] });
    const observed = renderFacetBridge(fake.source);

    await advance(INVALIDATION_THROTTLE_MS);
    // Positive baseline: the facet really is holding the pre-sync option.
    expect(observed.repositories).toEqual([STALE_REPOSITORY]);

    fake.emit({});
    await advance(INVALIDATION_THROTTLE_MS);

    // The summary still reports no repositories after the sync, so nothing but
    // the analytics read can move these options.
    expect(fake.usageRepositoriesServed()).toEqual([]);
    expect(observed.repositories).toEqual([FRESH_REPOSITORY]);
  });

  it("issues no fallback read when the summary owns its repositories", async () => {
    // The other half of the disposition, and the reason converging an aggregate
    // measured at 27.1s is affordable: SessionsView disables this read when the
    // summary carries repositories, and `invalidateQueries` refetches only
    // ACTIVE queries — query-core reads `enabled` in `Query.isActive`. So the
    // flush marks the entry stale and issues nothing on this path.
    const fake = facetFakeSource({ usageRepositories: [SUMMARY_REPOSITORY] });
    const observed = renderFacetBridge(fake.source);

    await advance(INVALIDATION_THROTTLE_MS);
    expect(observed.repositories).toEqual([SUMMARY_REPOSITORY]);

    fake.emit({});
    await advance(INVALIDATION_THROTTLE_MS);

    expect(fake.analyticsCalls()).toBe(0);
    expect(observed.repositories).toEqual([SUMMARY_REPOSITORY]);
  });

  it("does not refresh the fallback without a change event", async () => {
    // Control for the first case: no event, no new options, so that assertion
    // cannot pass on an incidental refetch.
    const fake = facetFakeSource({ usageRepositories: [] });
    const observed = renderFacetBridge(fake.source);

    await advance(INVALIDATION_THROTTLE_MS * 4);

    expect(fake.analyticsCalls()).toBe(1);
    expect(observed.repositories).toEqual([STALE_REPOSITORY]);
  });
});

const STALE_REPOSITORY = "acme/pre-sync";
const FRESH_REPOSITORY = "acme/post-sync";
const SUMMARY_REPOSITORY = "acme/from-summary";

type ObservedFacet = { repositories: readonly string[] };

/** The canonical analytics fixture, re-keyed to one named repository. */
function analyticsWithRepository(
  repositoryFullName: string
): AgentSessionAnalytics {
  const base = createAgentSessionAnalyticsFixture(AgentSessionViewerScope.Self);
  return {
    ...base,
    byRepository: base.byRepository.map((row) => ({
      ...row,
      repositoryFullName,
    })),
  };
}

/** The canonical usage fixture, carrying exactly the named repositories. */
function usageWithRepositories(
  repositoryFullNames: readonly string[]
): AgentSessionUsageSummary {
  const template = createAgentSessionAnalyticsFixture(
    AgentSessionViewerScope.Self
  ).byRepository;
  return createAgentSessionUsageSummaryFixture(AgentSessionViewerScope.Self, {
    byRepository: repositoryFullNames.flatMap((repositoryFullName) =>
      template.map((row) => ({ ...row, repositoryFullName }))
    ),
  });
}

/**
 * A source whose usage summary is FIXED across the sync — the persistent-empty
 * case — while analytics answers with a different repository each read, so a
 * converged facet is observable as a change in its options.
 */
function facetFakeSource(options: { usageRepositories: readonly string[] }) {
  let cb: ((change: AgentSessionsChange) => void) | null = null;
  let analyticsCalls = 0;
  const usage = usageWithRepositories(options.usageRepositories);
  const source: AgentSessionsDataSource = {
    scope: "local",
    list: () => Promise.reject(new Error("unused")),
    detail: () => Promise.reject(new Error("unused")),
    usage: () => Promise.resolve(usage),
    analytics: () => {
      analyticsCalls += 1;
      return Promise.resolve(
        analyticsWithRepository(
          analyticsCalls === 1 ? STALE_REPOSITORY : FRESH_REPOSITORY
        )
      );
    },
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
    analyticsCalls: () => analyticsCalls,
    usageRepositoriesServed: () =>
      usage.byRepository.map((row) => row.repositoryFullName),
  };
}

function renderFacetBridge(source: AgentSessionsDataSource) {
  const observed: ObservedFacet = { repositories: [] };

  /**
   * Mirrors the desktop SessionsView Repository facet: the summary owns the
   * options, and the analytics aggregate fills in only while the summary
   * reports none. The gate is restated here rather than imported because
   * `needsAnalyticsRepositoryFallback` lives in `apps/desktop`; it is the
   * consumer being modeled, not a second production copy.
   */
  function FacetProbe() {
    const usageQuery = useAgentSessionUsage({}, { retry: false });
    const summaryRepositories = usageQuery.data?.byRepository ?? [];
    const needsFallback =
      usageQuery.data !== undefined && summaryRepositories.length === 0;
    const analyticsQuery = useAgentSessionAnalytics(
      {},
      { enabled: needsFallback, retry: false }
    );
    const rows = needsFallback
      ? (analyticsQuery.data?.byRepository ?? [])
      : summaryRepositories;
    observed.repositories = rows.map((row) => row.repositoryFullName);
    return null;
  }

  render(
    <AppCoreStoryProviders>
      <AgentSessionsDataSourceProvider dataSource={source}>
        <AgentSessionsLiveBridge />
        <FacetProbe />
      </AgentSessionsDataSourceProvider>
    </AppCoreStoryProviders>
  );

  return observed;
}

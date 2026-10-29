import type { AgentSessionAnalytics } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { createAgentSessionAnalyticsFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import type { AgentSessionsDataSource } from "@repo/app/agents/data-source/agent-sessions-data-source";
import { AgentSessionsDataSourceProvider } from "@repo/app/agents/data-source/provider";
import {
  useAgentSessionAnalytics,
  useAgentSessions,
} from "@repo/app/agents/hooks/use-agent-sessions";
import { LIVE_BRIDGE_INVALIDATION_THROTTLE_MS } from "@repo/app/shared/hooks/use-live-query-bridge";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetRuntimeStatusPollForTests } from "../../hooks/use-runtime-status-poll";
import { CloudSessionsSyncBridge } from "../cloud-sessions-sync-bridge";

/**
 * The cloud Sessions list refreshes off THIS machine's upsync lane — the app
 * that drives the sync — and only while that lane is moving. These tests drive
 * the real shared runtime-status poll the bridge subscribes to and count reads
 * on the data source, so they fail if the bridge stops refreshing on movement
 * OR starts issuing reads against a quiet lane.
 */

const RUNTIME_POLL_MS = 1000;
const PRE_SYNC_REPOSITORY = "acme/pre-sync";
const POST_SYNC_REPOSITORY = "acme/post-sync";

/** What the analytics-backed Repository facet is currently rendering. */
type ObservedRepositories = { repositories: readonly string[] };

type SyncSample = {
  identified: boolean;
  pendingBackfillSessions: number;
  pendingIncrementalSessions: number;
  backfilling: boolean;
  caughtUp: boolean;
  deadLetteredSessions: number;
  /** Absent on a main process that predates ISS-7099's ack-counted deliveries. */
  deliveredSessions?: number | null;
};

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

let sample: SyncSample = syncing(0);
let getRuntimeStatus = vi.fn();
let hiddenValue = false;
let originalHiddenDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  sample = syncing(0);
  getRuntimeStatus = vi.fn(() => Promise.resolve({ cloudSync: sample }));
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { getRuntimeStatus },
    writable: true,
  });
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
  cleanup();
  __resetRuntimeStatusPollForTests();
  vi.useRealTimers();
  if (originalHiddenDescriptor) {
    Object.defineProperty(document, "hidden", originalHiddenDescriptor);
  } else {
    // biome-ignore lint/performance/noDelete: restore jsdom's prototype getter
    delete (document as { hidden?: boolean }).hidden;
  }
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

describe("CloudSessionsSyncBridge", () => {
  it("refreshes the cloud list when the upsync lane lands rows", async () => {
    const fake = cloudSource();
    sample = syncing(5);
    render(harness(fake.source));
    await settle();

    // Mount fetch only: the first measured sample is a baseline, not movement.
    await advance(RUNTIME_POLL_MS);
    expect(fake.listCalls()).toBe(1);

    // Two sessions land in the cloud — the rows the open list is missing.
    sample = syncing(3);
    await advance(RUNTIME_POLL_MS);
    await settle();

    expect(fake.listCalls()).toBe(2);
  });

  it("refreshes when the lane keeps delivering at a steady queue depth", async () => {
    const fake = cloudSource();
    sample = { ...syncing(5), deliveredSessions: 10 };
    render(harness(fake.source));
    await settle();
    await advance(RUNTIME_POLL_MS);
    expect(fake.listCalls()).toBe(1);

    // ISS-9184: an import refills the queue as fast as the lane drains it, so
    // two sessions land in the cloud and the owed count reads exactly the same.
    // Owed depth is a LEVEL; only the ack-counted delivery says rows arrived,
    // and this is the shape the bug shipped in — 61% of the delivering batches
    // on the run that found it arrived under an unchanged owed tuple.
    sample = { ...syncing(5), deliveredSessions: 12 };
    await advance(RUNTIME_POLL_MS);
    await settle();

    expect(fake.listCalls()).toBe(2);
  });

  it("refreshes across a compute-target switch and on the rehydrated identity", async () => {
    const fake = cloudSource();
    sample = { ...syncing(5), deliveredSessions: 500 };
    render(harness(fake.source));
    await settle();
    await advance(RUNTIME_POLL_MS);
    expect(fake.listCalls()).toBe(1);

    // Mid-switch: the lane cannot attribute its counts to the new target yet, so
    // delivered reads null and the signal falls back to owed depth alone.
    sample = { ...syncing(5), deliveredSessions: null };
    await advance(RUNTIME_POLL_MS);
    await advance(LIVE_BRIDGE_INVALIDATION_THROTTLE_MS);
    await settle();
    expect(fake.listCalls()).toBe(2);

    // Hydrated on the new identity: the tally reset, so delivered restarts at 0.
    // A new identity's rows are exactly what the open list is missing, so the
    // placeholder giving way to a number is a refresh worth spending.
    sample = { ...syncing(5), deliveredSessions: 0 };
    await advance(RUNTIME_POLL_MS);
    await advance(LIVE_BRIDGE_INVALIDATION_THROTTLE_MS);
    await settle();
    expect(fake.listCalls()).toBe(3);
  });

  it("refreshes once more when the lane reports it caught up", async () => {
    const fake = cloudSource();
    sample = syncing(1);
    render(harness(fake.source));
    await settle();
    await advance(RUNTIME_POLL_MS);

    sample = { ...syncing(0), backfilling: false, caughtUp: true };
    await advance(RUNTIME_POLL_MS);
    await settle();

    expect(fake.listCalls()).toBe(2);
  });

  it("issues no reads at all while the lane is quiet", async () => {
    const fake = cloudSource();
    // ISS-9184: carries a MEASURED delivered count, which is the shape a
    // caught-up production lane reports. A delivered segment that churned on a
    // lane delivering nothing would turn this bridge into the poller the
    // movement design exists to avoid, and only a measured sample can catch it.
    sample = {
      ...syncing(0),
      backfilling: false,
      caughtUp: true,
      deliveredSessions: 40,
    };
    render(harness(fake.source));
    await settle();

    // Ten identical samples: an idle desktop must not turn into a poller.
    for (let tick = 0; tick < 10; tick += 1) {
      await advance(RUNTIME_POLL_MS);
    }

    expect(fake.listCalls()).toBe(1);
  });

  it("coalesces a fast-draining backfill into one refresh per throttle window", async () => {
    const fake = cloudSource();
    sample = syncing(50);
    render(harness(fake.source));
    await settle();
    await advance(RUNTIME_POLL_MS);

    // The count moves on every one-second sample for a whole throttle window.
    for (let owed = 49; owed >= 45; owed -= 1) {
      sample = syncing(owed);
      await advance(RUNTIME_POLL_MS);
    }
    await advance(LIVE_BRIDGE_INVALIDATION_THROTTLE_MS);
    await settle();

    // Mount read, the first movement's prompt refresh, and ONE coalesced
    // refresh for the burst behind it — not one per sample.
    expect(fake.listCalls()).toBe(3);
  });

  it("holds the refresh while the window is hidden and flushes it on re-show", async () => {
    const fake = cloudSource();
    sample = syncing(5);
    hiddenValue = true;
    render(harness(fake.source));
    await settle();
    await advance(RUNTIME_POLL_MS);

    // Rows land while the user is looking at something else. Refetching the
    // cloud API behind a hidden window is the load this must not add.
    sample = syncing(3);
    await advance(RUNTIME_POLL_MS + LIVE_BRIDGE_INVALIDATION_THROTTLE_MS);
    await settle();
    expect(fake.listCalls()).toBe(1);

    // Back on screen: the deferred movement flushes rather than being dropped.
    hiddenValue = false;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(LIVE_BRIDGE_INVALIDATION_THROTTLE_MS);
    });
    await settle();

    expect(fake.listCalls()).toBe(2);
  });

  it("does not subscribe to the runtime-status poll with no Sessions read open", async () => {
    sample = syncing(5);
    // The bridge alone, as it sits at the app-core root on every other screen:
    // nothing is observing a Sessions read, so nothing should be polled.
    render(harness(cloudSource().source, { withList: false }));
    await settle();
    for (let tick = 0; tick < 5; tick += 1) {
      await advance(RUNTIME_POLL_MS);
    }

    expect(getRuntimeStatus).not.toHaveBeenCalled();
  });

  it("converges every family the contract classifies, not a list of its own", async () => {
    // whitlockk review: this bridge used to restate `lists`/`usages`/`pageDataRoot`
    // inline, so a family newly classified `always` converged under the desktop
    // push bridge and stayed stale here — cloud-mode Desktop Sessions being the
    // one surface this bridge exists to keep fresh. Analytics is exactly that
    // family (davetho review, same PR): it feeds the sessions list's
    // Repository facet, and the old inline list did not name it.
    const fake = cloudSource();
    const observed: ObservedRepositories = { repositories: [] };
    sample = syncing(5);
    render(harness(fake.source, { analytics: observed }));
    await settle();
    await advance(RUNTIME_POLL_MS);
    // Positive baseline: the facet really is holding pre-sync options, so the
    // assertion below cannot pass against a facet that never populated.
    expect(observed.repositories).toEqual([PRE_SYNC_REPOSITORY]);

    sample = syncing(3);
    await advance(RUNTIME_POLL_MS);
    await settle();

    expect(observed.repositories).toEqual([POST_SYNC_REPOSITORY]);
  });

  it("leaves the facet alone when the lane does not move", async () => {
    // Control for the case above: without movement the options must NOT change,
    // so that assertion cannot pass on an incidental refetch.
    const fake = cloudSource();
    const observed: ObservedRepositories = { repositories: [] };
    sample = {
      ...syncing(0),
      backfilling: false,
      caughtUp: true,
      deliveredSessions: 40,
    };
    render(harness(fake.source, { analytics: observed }));
    await settle();
    for (let tick = 0; tick < 10; tick += 1) {
      await advance(RUNTIME_POLL_MS);
    }
    await settle();

    expect(fake.analyticsCalls()).toBe(1);
    expect(observed.repositories).toEqual([PRE_SYNC_REPOSITORY]);
  });

  it("subscribes the lane poll for a Sessions read the old gate did not name", async () => {
    // The observed-read gate is the second hand-written list this bridge owned.
    // A converging family the gate omits is worse than it looks: with only that
    // read on screen the poll stays unsubscribed, so the flush that would have
    // refreshed it never fires at all. Gate and flush now read one declaration.
    sample = syncing(5);
    render(
      harness(cloudSource().source, {
        withList: false,
        analytics: { repositories: [] },
      })
    );
    await settle();
    await advance(RUNTIME_POLL_MS);

    expect(getRuntimeStatus).toHaveBeenCalled();
  });

  it("treats an unmeasured lane as no movement", async () => {
    const fake = cloudSource();
    sample = { ...syncing(4), identified: false };
    render(harness(fake.source));
    await settle();
    await advance(RUNTIME_POLL_MS);

    // The counts move, but an unidentified device has measured nothing — a
    // sample that means "unknown" must not be read as landed rows.
    sample = { ...syncing(2), identified: false };
    await advance(RUNTIME_POLL_MS);
    await settle();

    expect(fake.listCalls()).toBe(1);
  });
});

/** A lane that is actively uploading, with `owed` sessions still queued. */
function syncing(owed: number): SyncSample {
  return {
    identified: true,
    pendingBackfillSessions: owed,
    pendingIncrementalSessions: 0,
    backfilling: owed > 0,
    caughtUp: false,
    deadLetteredSessions: 0,
  };
}

/** The HTTP-backed source cloud mode reads through: no `subscribe`, no push. */
function cloudSource() {
  let listCalls = 0;
  let analyticsCalls = 0;
  const source: AgentSessionsDataSource = {
    scope: "http",
    list: () => {
      listCalls += 1;
      return Promise.resolve({
        items: [],
        total: 0,
        viewerScope: AgentSessionViewerScope.Self,
      });
    },
    detail: () => Promise.reject(new Error("unused")),
    usage: () => Promise.reject(new Error("unused")),
    // Answers with a different repository each read, so convergence is
    // observable as a change in rendered facet options rather than only as a
    // call count.
    analytics: () => {
      analyticsCalls += 1;
      return Promise.resolve(
        analyticsWithRepository(
          analyticsCalls === 1 ? PRE_SYNC_REPOSITORY : POST_SYNC_REPOSITORY
        )
      );
    },
    pageData: () => Promise.reject(new Error("unused")),
  };
  return {
    source,
    listCalls: () => listCalls,
    analyticsCalls: () => analyticsCalls,
  };
}

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

function ListProbe() {
  useAgentSessions({ limit: 25 });
  return null;
}

/**
 * Stands in for the desktop SessionsView's Repository-facet fallback read: the
 * analytics aggregate, whose `byRepository` populates the sessions list's
 * Repository facet while the usage summary reports none (ISS-5273).
 */
function AnalyticsProbe({ observed }: { observed: ObservedRepositories }) {
  const query = useAgentSessionAnalytics({});
  observed.repositories = (query.data?.byRepository ?? []).map(
    (row) => row.repositoryFullName
  );
  return null;
}

function harness(
  source: AgentSessionsDataSource,
  options?: {
    withList?: boolean;
    analytics?: ObservedRepositories;
  }
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <AppCoreStoryProviders>
      <QueryClientProvider client={client}>
        <AgentSessionsDataSourceProvider dataSource={source}>
          <CloudSessionsSyncBridge />
          {options?.withList === false ? null : <ListProbe />}
          {options?.analytics ? (
            <AnalyticsProbe observed={options.analytics} />
          ) : null}
        </AgentSessionsDataSourceProvider>
      </QueryClientProvider>
    </AppCoreStoryProviders>
  );
}

/** Advance fake timers inside `act` so refetches and state updates settle. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Flush the data-source promise plus the React commit behind it. */
async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await advance(1);
  }
}

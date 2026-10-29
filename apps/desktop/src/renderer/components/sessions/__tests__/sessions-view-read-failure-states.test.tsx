import type { AgentSessionsPageData } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { ReadSource } from "@repo/api/src/types/read-source";
import {
  createAgentSessionAnalyticsFixture,
  createAgentSessionUsageSummaryFixture,
} from "@repo/app/agents/components/sessions/session-list-fixtures";
import {
  SESSIONS_FILTERED_EMPTY_TITLE,
  SessionsEmptyState,
} from "@repo/app/agents/components/sessions/sessions-empty-state";
import type { AgentSessionsDataSource } from "@repo/app/agents/data-source/agent-sessions-data-source";
import { AgentSessionsDataSourceProvider } from "@repo/app/agents/data-source/provider";
import { agentSessionKeys } from "@repo/app/agents/hooks/agent-session-keys";
import { useAgentSessionsPageData } from "@repo/app/agents/hooks/use-agent-sessions";
import { SESSIONS_SEARCH_PARAM } from "@repo/app/agents/lib/session-url-scope-params";
import {
  MAX_TRANSIENT_QUERY_RETRIES,
  makeQueryClient,
} from "@repo/app/shared/query/query-client";
import {
  defaultScheduler,
  notifyManager,
  type QueryClient,
  QueryClientProvider,
  type UseQueryResult,
} from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../../shared/local-session-source-status";
import { SHARED_AGENT_SESSIONS_TRANSIENT_ERROR_CODE } from "../../../../shared/shared-agent-sessions-contract";
import { TransientSourceError } from "../../../shared/transient-source-error";
import { createDesktopCloudPrimaryAgentSessionsDataSource } from "../../../shared-agent-sessions/desktop-agent-sessions-data-source";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import { toDesktopLocalFallbackList } from "../../../shared-agent-sessions/desktop-session-source-precedence";
import { SessionsView } from "../SessionsView";
import { deriveSessionsAvailability } from "../sessions-summary-cards-state";

/**
 * ISS-7528: the desktop half of ISS-7519 (web PR #5596). The Sessions list's
 * read-failure states, driven through the REAL TanStack observer rather than a
 * hand-set `isError` boolean.
 *
 * `isError` cannot tell the two failures apart: query-core's error reducer never
 * clears `data`, so a background refetch that failed over a read which already
 * SUCCEEDED reports `isError === true` while the succeeded result is still on
 * screen. The combined page read also runs with `keepPreviousData`, so desktop
 * holds that result exactly as web did. A fixture that hand-sets `isError: true`
 * therefore proves nothing about which of the two the view renders — only a real
 * success-then-failure sequence through `useAgentSessionsPageData` does.
 *
 * CLOUD mode throughout: it collapses `displayState` to "ready" so the page
 * read's own flags drive the table (the same reason the sibling
 * `sessions-view-empty-states` suite uses it), and it is the mode in which the
 * connected-agent probe runs — which is what makes the rendered copy directly
 * comparable to the web page's.
 */

// Copy pinned as hand-written literals, deliberately not imported from the
// component that emits it: importing would let a copy change silently rewrite
// this suite's expectation about WHICH state rendered.
const OUTAGE_TITLE = "Couldn't load sessions";
const ONBOARDING_TITLE = "No sessions synced yet";
const SYNCING_TITLE = "Getting your sessions ready";
// Local mode IS the connected agent, so `useDesktopHasConnectedAgent` forces the
// signal true and the genuinely-empty state renders the neutral copy, never the
// connect-a-target CTA.
const NEUTRAL_EMPTY_TITLE = "No sessions yet";
const RECOVERY_ACTION_NAME = "Clear filters and reload";

const hooks = vi.hoisted(() => ({
  useLocalAgentSessionUsage: vi.fn(),
  useIngestProgress: vi.fn(),
  useSessionsViewState: vi.fn(),
  useSharedDateRange: vi.fn(),
  useSearchParamsValue: vi.fn(),
}));

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));

const capturedSummary: {
  props: { isError: boolean; isLoading: boolean } | null;
} = { props: null };

// Cloud is the default because it collapses `displayState` to "ready" and runs
// the connected-agent probe, which is what makes the rendered copy directly
// comparable to the web page's. The db-host transient cases below switch to
// LOCAL: `TransientSourceError` is produced by exactly one place
// (`local-agent-sessions-data-source`), so a cloud-mode transient failure is not
// a state the shipped app can reach and pinning it there would describe nothing.
const appCoreMode = vi.hoisted(() => ({
  value: "" as (typeof DesktopAppCoreMode)[keyof typeof DesktopAppCoreMode],
}));

let desktopApiDescriptor: PropertyDescriptor | undefined;

// `@repo/app/agents/hooks/use-agent-sessions` is deliberately NOT mocked — it is
// the observer under test. Everything below is scaffolding the view needs to
// mount, never the read itself.

// The summary strip pulls a wide provider stack, so capture the two signals
// SessionsView folds into it rather than rendering it — the table body
// underneath is what renders for real here. `isError` is the OTHER consumer of
// the raw `isError` fed to `classifyListReadErrorState`, so this suite can pin
// that site's behaviour on the same settled observer.
vi.mock("@repo/app/agents/components/sessions/sessions-summary-cards", () => ({
  SessionsSummaryCards: (props: { isError: boolean; isLoading: boolean }) => {
    capturedSummary.props = {
      isError: props.isError,
      isLoading: props.isLoading,
    };
    return <div data-testid="sessions-summary-cards" />;
  },
}));

vi.mock("../use-local-agent-session-usage", () => ({
  useLocalAgentSessionUsage: hooks.useLocalAgentSessionUsage,
}));

vi.mock("../../../hooks/use-ingest-progress", () => ({
  useIngestProgress: hooks.useIngestProgress,
}));

vi.mock("../../../hooks/use-file-access-blocks", () => ({
  useFileAccessBlocks: () => [],
}));

// The onboarding-vs-neutral split reads a SEPARATE org-wide query. It is not the
// read under test, so it is pinned to "never connected" — the reported harm's
// precondition, and the frame whose copy the web page renders too.
vi.mock("@repo/app/agents/hooks/use-has-connected-agent", () => ({
  useHasConnectedAgent: () => ({ data: false }),
}));

vi.mock("@repo/app/agents/hooks/use-sessions-view-state", () => ({
  useSessionsViewState: hooks.useSessionsViewState,
}));

// `useAgentSessionsDataSource` builds the fallback HTTP client unconditionally
// (Rules of Hooks), so an api-client stub is required even though every read
// here is served by the injected source. `get` resolves `[]` rather than
// `undefined` — ISS-12455's custom-fields read is a genuine caller of this
// mock in cloud mode, and an array-consuming query reading `undefined` back is
// query-core's own "Query data cannot be undefined" warning, not a state this
// suite is about.
vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({
    get: vi.fn().mockResolvedValue([]),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  }),
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => false,
  useFeatureFlagEnabledOptional: () => false,
  // FEA-4201: the readiness-carrying read. `isReady` is settled-ness, not
  // enabled-ness, and the real desktop port settles ASYNCHRONOUSLY — the
  // signed-in account's PostHog assignment arrives over the IPC bridge. This
  // mock pins it settled so the suites exercise the resolved state; `enabled`
  // mirrors this suite's own set.
  useFeatureFlagGate: () => ({
    enabled: false,
    isReady: true,
  }),
  // ISS-9692: `useTablePageSizeOptions` reads the ladder gate through the
  // provider-optional port, so this exhaustive module mock owes it an entry
  // too. Same answer as the required gate above.
  useFeatureFlagGateOptional: () => ({
    enabled: false,
    isReady: true,
  }),
}));

vi.mock("@repo/app/shared/hooks/use-shared-date-range", () => ({
  useSharedDateRange: hooks.useSharedDateRange,
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => navigation,
}));

vi.mock("@repo/navigation/link", () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => "/sessions",
}));

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: hooks.useSearchParamsValue,
}));

vi.mock("../agent-coaching-tips", () => ({
  AgentCoachingTips: () => <div data-testid="agent-coaching-tips" />,
}));

vi.mock("../../../shared-agent-sessions/desktop-app-core-provider", () => ({
  useDesktopAppCoreMode: () => appCoreMode.value,
  useDesktopLocalReadReason: () => undefined,
}));

vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    state: { status: DesktopAuthStatus.Authenticated },
    beginSignIn: vi.fn().mockResolvedValue({ ok: true }),
    cancelSignIn: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
  }),
}));

const EMPTY_USAGE = createAgentSessionUsageSummaryFixture(
  AgentSessionViewerScope.Organization,
  { totalSessions: 0 }
);

const EMPTY_ANALYTICS = createAgentSessionAnalyticsFixture(
  AgentSessionViewerScope.Organization,
  { byRepository: [] }
);

const EMPTY_PAGE_DATA: AgentSessionsPageData = {
  list: {
    items: [],
    readSource: ReadSource.Cloud,
    total: 0,
    viewerScope: AgentSessionViewerScope.Organization,
  },
  usage: EMPTY_USAGE,
};

const PARTIAL_EMPTY_PAGE_DATA: AgentSessionsPageData = {
  list: toDesktopLocalFallbackList(EMPTY_PAGE_DATA.list),
  usage: EMPTY_USAGE,
};

/**
 * `hold` is a read that is dispatched but never settles until the test releases
 * it — the only way to observe an IN-FLIGHT re-read deterministically, with no
 * clock and no fixed wait.
 */
type ReadBehavior = "succeed" | "fail" | "failTransiently" | "hold" | "partial";

let readBehavior: ReadBehavior;
let pageDataCallCount: number;
let queryClient: QueryClient;
let releaseHeldRead: (() => void) | null;

function createControllableDataSource(): AgentSessionsDataSource {
  const source: AgentSessionsDataSource = {
    scope: "iss-7528-test",
    pageData: () => {
      pageDataCallCount += 1;
      if (readBehavior === "hold") {
        return new Promise<AgentSessionsPageData>((resolve) => {
          releaseHeldRead = () => resolve(EMPTY_PAGE_DATA);
        });
      }
      if (readBehavior === "failTransiently") {
        return Promise.reject(
          new TransientSourceError(
            "db-host exited (code: 1)",
            SHARED_AGENT_SESSIONS_TRANSIENT_ERROR_CODE
          )
        );
      }
      if (readBehavior === "fail") {
        return Promise.reject(new Error("sessions page read failed"));
      }
      if (readBehavior === "partial") {
        return Promise.resolve(PARTIAL_EMPTY_PAGE_DATA);
      }
      return Promise.resolve(EMPTY_PAGE_DATA);
    },
    usage: () => Promise.resolve(EMPTY_USAGE),
    list: () => Promise.reject(new Error("list is not read by this view")),
    detail: () => Promise.reject(new Error("detail is not read by this view")),
    analytics: () => Promise.resolve(EMPTY_ANALYTICS),
  };
  if (readBehavior !== "partial") {
    return source;
  }
  return createDesktopCloudPrimaryAgentSessionsDataSource({
    cloudSource: {
      ...source,
      pageData: () => {
        pageDataCallCount += 1;
        return Promise.reject(new Error("cloud unavailable"));
      },
    },
    identity: { organizationId: "org-1", userId: "user-1" },
    localSource: {
      ...source,
      list: () => Promise.resolve(EMPTY_PAGE_DATA.list),
    },
  });
}

/**
 * The client the shipped desktop renderer builds: the shared `makeQueryClient`
 * factory with the LOCAL-mode options from `desktop-app-core-provider`, so the
 * RETRY POLICY these tests run under is production's `shouldRetryQuery`
 * predicate. (Both desktop clients come from that factory and neither overrides
 * `retry`, so the cloud-mode tests here run the same policy.)
 *
 * whitlockk thread cid 3835076818: the earlier revision built a bare client with
 * `retry: false`, which let a rejected `TransientSourceError` reach `isError`
 * after ONE attempt with `fetchFailureCount: 1`. The shipped client cannot
 * produce that state — a `TransientSourceError` is a bare `Error`, so
 * `isResponseBackedError` is false and it stays in the retryer until the
 * `MAX_TRANSIENT_QUERY_RETRIES` cap. By the time it settles,
 * `areTransientRetriesExhausted` has already closed the transient branch, so the
 * syncing frame that test asserted was a test-only state.
 *
 * Only the BACKOFF is compressed (`retryDelay: 0`): the refetch promise resolves
 * when the last attempt settles, so the chain stays deterministic with no clock.
 * Which errors retry, and how many times, are production's.
 */
function createDesktopSessionsQueryClient(): QueryClient {
  const client = makeQueryClient({
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    networkMode: "always",
  });
  const defaults = client.getDefaultOptions();
  client.setDefaultOptions({
    ...defaults,
    queries: { ...defaults.queries, retryDelay: 0 },
  });
  return client;
}

function renderSessionsView() {
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentSessionsDataSourceProvider
        dataSource={createControllableDataSource()}
      >
        <SessionsView />
      </AgentSessionsDataSourceProvider>
    </QueryClientProvider>
  );
}

/** The settled page-data query, or `undefined` if none reached `error`. */
function settledErroredPageRead() {
  return queryClient
    .getQueryCache()
    .findAll({ queryKey: agentSessionKeys.pageDataRoot() })
    .find((query) => query.state.status === "error");
}

async function refetchPageData() {
  await act(async () => {
    await queryClient.refetchQueries({
      queryKey: agentSessionKeys.pageDataRoot(),
    });
  });
}

function installDesktopApi() {
  desktopApiDescriptor = Object.getOwnPropertyDescriptor(window, "desktopApi");
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getAgentMonitorUrl: vi.fn().mockResolvedValue({
        localSessionSourceStatus: LOCAL_SESSION_SOURCE_STATUSES.ready,
      }),
      onDbChanged: vi.fn(() => undefined),
      recordDeadEndTelemetry: vi.fn().mockResolvedValue({ ok: true }),
    },
  });
}

function restoreDesktopApi() {
  if (desktopApiDescriptor) {
    Object.defineProperty(window, "desktopApi", desktopApiDescriptor);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
  desktopApiDescriptor = undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  readBehavior = "succeed";
  pageDataCallCount = 0;
  releaseHeldRead = null;
  installDesktopApi();
  hooks.useSharedDateRange.mockReturnValue({
    dateRange: "7d",
    setDateRange: vi.fn(),
  });
  hooks.useSearchParamsValue.mockReturnValue(new URLSearchParams());
  hooks.useSessionsViewState.mockReturnValue({
    // ISS-6382: the ISS-4655 restore gate holds this view's read closed until the
    // persisted view has settled, and the body renders a spinner for that window.
    // This suite's subject is the SETTLED read's failure states, so it seeds a
    // ready view — the same state the other desktop sessions suites seed.
    isViewReady: true,
    sortKey: null,
    sortDir: "desc",
    visibleColumns: new Set<string>(["name"]),
    columnOrder: undefined,
    setColumnOrder: vi.fn(),
    setSort: vi.fn(),
    toggleColumn: vi.fn(),
    resetView: vi.fn(),
  });
  hooks.useLocalAgentSessionUsage.mockReturnValue({
    data: undefined,
    isError: false,
  });
  hooks.useIngestProgress.mockReturnValue(null);
  capturedSummary.props = null;
  appCoreMode.value = DesktopAppCoreMode.Cloud;
  queryClient = createDesktopSessionsQueryClient();
  // query-core schedules observer notifications onto a `setTimeout(…, 0)`
  // macrotask, which an `act` microtask drain does NOT reach — the DOM would
  // still hold the pre-error frame and every assertion below would read a stale
  // render (it would pass against the unfixed view). Notify synchronously
  // instead, so `act` sees the error the moment the query settles. No timers, no
  // waiting on the clock.
  notifyManager.setScheduler((callback) => callback());
});

afterEach(() => {
  cleanup();
  notifyManager.setScheduler(defaultScheduler);
  // Settle any read still being held so no retryer promise is left pending.
  releaseHeldRead?.();
  releaseHeldRead = null;
  queryClient.clear();
  restoreDesktopApi();
});

describe("desktop Sessions list read-failure states (ISS-7528)", () => {
  it("mounts no source badge for the legacy Sessions list", async () => {
    renderSessionsView();

    expect(await screen.findByText(ONBOARDING_TITLE)).not.toBeNull();
    expect(screen.queryByTestId("read-source-badge")).toBeNull();
  });

  it("renders the unavailable treatment for an unfiltered zero-row partial read", async () => {
    readBehavior = "partial";

    renderSessionsView();

    expect(await screen.findByText(OUTAGE_TITLE)).not.toBeNull();
    expect(screen.queryByText(ONBOARDING_TITLE)).toBeNull();
    expect(screen.queryByText(NEUTRAL_EMPTY_TITLE)).toBeNull();
    expect(screen.queryByText(SESSIONS_FILTERED_EMPTY_TITLE)).toBeNull();
    expect(screen.queryByTestId("read-source-badge")).toBeNull();
  });

  it("renders the unavailable treatment for a filtered zero-row partial read", async () => {
    readBehavior = "partial";
    hooks.useSearchParamsValue.mockReturnValue(
      new URLSearchParams([[SESSIONS_SEARCH_PARAM, "no-match"]])
    );

    renderSessionsView();

    expect(await screen.findByText(OUTAGE_TITLE)).not.toBeNull();
    expect(screen.queryByText(ONBOARDING_TITLE)).toBeNull();
    expect(screen.queryByText(NEUTRAL_EMPTY_TITLE)).toBeNull();
    expect(screen.queryByText(SESSIONS_FILTERED_EMPTY_TITLE)).toBeNull();
  });

  it("keeps the onboarding empty when a refetch fails over a read that already succeeded", async () => {
    renderSessionsView();

    expect(await screen.findByText(ONBOARDING_TITLE)).not.toBeNull();

    // The API blip: a real refetch through the real observer, which fails.
    readBehavior = "fail";
    const callsBeforeRefetch = pageDataCallCount;
    await refetchPageData();

    // Positive proof the failure actually landed on the observer: the page was
    // re-read, and query-core settled it to `error` while RETAINING the result
    // it already held — precisely why `isError` cannot classify it.
    expect(pageDataCallCount).toBeGreaterThan(callsBeforeRefetch);
    const settled = settledErroredPageRead();
    expect(settled).toBeDefined();
    expect(settled?.state.data).toBeDefined();

    // The org is fine and the read succeeded, so the view must not claim an outage.
    expect(screen.getByText(ONBOARDING_TITLE)).not.toBeNull();
    expect(screen.queryByText(OUTAGE_TITLE)).toBeNull();
    expect(screen.queryByText(SYNCING_TITLE)).toBeNull();
  });

  it("claims the outage when the very first read fails and no data was ever held", async () => {
    readBehavior = "fail";

    renderSessionsView();

    // The distinct sibling state: nothing ever landed, so the failed read is the
    // only thing we know — and the view must say so rather than render a false
    // onboarding all-clear.
    expect(await screen.findByText(OUTAGE_TITLE)).not.toBeNull();
    const errored = settledErroredPageRead();
    // Guard before the optional chain: without it a MISSING query would satisfy
    // `?.state.data` being undefined and the assertion would pass vacuously.
    expect(errored).toBeDefined();
    expect(errored?.state.data).toBeUndefined();
    expect(screen.queryByText(ONBOARDING_TITLE)).toBeNull();
  });

  // ISS-4483's quiet reconnecting surface, in the window PRODUCTION actually
  // reaches it (whitlockk thread cid 3835076818). Under the shipped retry policy a
  // rejected `TransientSourceError` never SETTLES into the reconnecting state:
  // `shouldRetryQuery` keeps it in the retryer to the cap, so the first frame in
  // which `isError` is true is already exhausted and belongs to the
  // wedged-transient fall-through below.
  //
  // What the user sees reconnecting is the RE-READ of that settled transient
  // error: query-core's `fetch` dispatch resets `fetchFailureCount` to 0 and
  // keeps `status: "error"` while data is held, so `areTransientRetriesExhausted`
  // (isError && fetchStatus idle && failureCount >= cap) re-opens the transient
  // branch for exactly the in-flight window — the frame after a Retry, or after
  // any refetch trigger, on a db-host that is still restarting.
  it("holds the quiet reconnecting empty while a settled TRANSIENT failure is being re-read", async () => {
    // LOCAL mode: `TransientSourceError` is raised only by the local data source,
    // so this is the one mode in which a db-host transient failure is reachable.
    appCoreMode.value = DesktopAppCoreMode.Local;
    renderSessionsView();

    expect(await screen.findByText(NEUTRAL_EMPTY_TITLE)).not.toBeNull();

    readBehavior = "failTransiently";
    await refetchPageData();

    // The precondition, proved rather than assumed: the retry chain ran to the
    // production cap and settled, so the frame on screen is the WEDGED transient
    // (the error card), not the reconnecting one. Without this the syncing
    // assertion below could pass on a surface that never changed.
    const settled = settledErroredPageRead();
    expect(settled).toBeDefined();
    expect(settled?.state.data).toBeDefined();
    expect(settled?.state.fetchStatus).toBe("idle");
    expect(settled?.state.fetchFailureCount).toBeGreaterThanOrEqual(
      MAX_TRANSIENT_QUERY_RETRIES
    );
    expect(screen.getByText(OUTAGE_TITLE)).not.toBeNull();

    // The re-read, dispatched and deliberately not settled. A transient failure
    // that is being retried is neither a breakage nor an all-clear: it keeps its
    // own third surface, which the ISS-7528 fix must not collapse into the
    // genuinely-empty copy and which must not keep claiming an outage about a
    // read currently in flight.
    readBehavior = "hold";
    const reRead = queryClient.refetchQueries({
      queryKey: agentSessionKeys.pageDataRoot(),
    });
    await act(async () => {
      await Promise.resolve();
    });

    const reReading = queryClient
      .getQueryCache()
      .findAll({ queryKey: agentSessionKeys.pageDataRoot() })
      .at(0);
    expect(reReading?.state.fetchStatus).toBe("fetching");
    expect(reReading?.state.status).toBe("error");

    await waitFor(() => expect(screen.getByText(SYNCING_TITLE)).not.toBeNull());
    expect(screen.queryByText(OUTAGE_TITLE)).toBeNull();
    expect(screen.queryByText(NEUTRAL_EMPTY_TITLE)).toBeNull();

    // Let the held read finish so the assertions above are not the last word on a
    // read that never returns: it resolves, and the surface leaves the holding
    // state on its own.
    await act(async () => {
      releaseHeldRead?.();
      await reRead;
    });
    await waitFor(() =>
      expect(screen.getByText(NEUTRAL_EMPTY_TITLE)).not.toBeNull()
    );
  });

  // ISS-4483 review cid 3679535437 gave the wedged transient an EXIT: once its
  // bounded retries are exhausted it falls through to the hard error card, which
  // always carries an action, "so the user has a move to make instead of an
  // infinite skeleton". That exit must survive ISS-7528 — a wedged db-host is a
  // real, ongoing breakage, and the empty result we happen to hold does not
  // disprove it the way a succeeded-then-blipped read does. This is why
  // `deriveSessionsAvailability` keeps the EXHAUSTION-AGNOSTIC transient term:
  // `isListErrorTransient` closes at exhaustion, so it alone would drop this
  // frame into the genuinely-empty state and strip its only affordance.
  //
  // It is also the counterfactual for ISS-7528 site 2 of 3: `SessionsView` feeds
  // `areTransientRetriesExhausted` the RAW `isError` on purpose. Fed
  // `isLoadingError`, a transient failure over held data could never be
  // classified exhausted and this surface would hold the reconnecting message
  // forever over a read that has stopped retrying.
  it("falls through to the error card WITH a recovery action once a TRANSIENT refetch exhausts its retries", async () => {
    appCoreMode.value = DesktopAppCoreMode.Local;
    renderSessionsView();

    expect(await screen.findByText(NEUTRAL_EMPTY_TITLE)).not.toBeNull();

    readBehavior = "failTransiently";
    await refetchPageData();

    // Positive proof the retry chain ran to its cap and settled: the assertions
    // below are meaningless if the read is still mid-retry.
    const settled = settledErroredPageRead();
    expect(settled).toBeDefined();
    expect(settled?.state.fetchStatus).toBe("idle");
    expect(settled?.state.fetchFailureCount).toBeGreaterThanOrEqual(
      MAX_TRANSIENT_QUERY_RETRIES
    );

    // The reconnecting message is gone, and what replaces it is the honest error
    // card — never a confident "you have none" over a read that is still failing.
    expect(screen.queryByText(SYNCING_TITLE)).toBeNull();
    expect(screen.getByText(OUTAGE_TITLE)).not.toBeNull();
    expect(screen.queryByText(NEUTRAL_EMPTY_TITLE)).toBeNull();
    // The affordance is the point of the fall-through, so assert the control
    // itself and not merely which copy rendered.
    expect(
      screen.getByRole("link", { name: RECOVERY_ACTION_NAME })
    ).not.toBeNull();
  });

  // The LOCAL-mode twin of the first test. Local is a second adapter with its own
  // display-state machine (`collapseStartingWhenDataHeld`) and its own forced
  // connected-agent signal, so the fix is pinned on both rather than assumed to
  // carry across from Cloud.
  it("keeps the neutral empty in LOCAL mode when a refetch fails over a succeeded read", async () => {
    appCoreMode.value = DesktopAppCoreMode.Local;
    renderSessionsView();

    expect(await screen.findByText(NEUTRAL_EMPTY_TITLE)).not.toBeNull();

    readBehavior = "fail";
    await refetchPageData();

    const settled = settledErroredPageRead();
    expect(settled).toBeDefined();
    expect(settled?.state.data).toBeDefined();

    expect(screen.getByText(NEUTRAL_EMPTY_TITLE)).not.toBeNull();
    expect(screen.queryByText(OUTAGE_TITLE)).toBeNull();
    expect(screen.queryByText(SYNCING_TITLE)).toBeNull();
  });

  // `SessionsView.tsx` feeds `classifyListReadErrorState` the RAW `isError`
  // (ISS-7528 site 3 of 3), deliberately: its `isListErrorTransient` output must
  // classify ANY settled error — the transient-refetch case above depends on it
  // — and its `metricReadErrored` output already makes the held-data
  // distinction downstream, in `resolveSummaryCardsErrored`'s `&&
  // !hasSummaryUsage`. This pins that second half, which is the only place a
  // refetch failure over held usage could still have dashed the cards.
  it("keeps the summary cards out of their error state when a refetch fails over held usage", async () => {
    renderSessionsView();

    expect(await screen.findByText(ONBOARDING_TITLE)).not.toBeNull();
    expect(capturedSummary.props?.isError).toBe(false);

    readBehavior = "fail";
    await refetchPageData();

    const settled = settledErroredPageRead();
    expect(settled).toBeDefined();
    expect(settled?.state.data).toBeDefined();

    // The usage half of the combined read is still in hand, so the cards render
    // it rather than dashing to a destructive "—" about numbers we hold.
    expect(capturedSummary.props?.isError).toBe(false);
    expect(capturedSummary.props?.isLoading).toBe(false);
  });
});

/**
 * The cross-surface half of the ticket, with its boundary stated out loud —
 * the same shape `session-detail-branch-link-parity.test.tsx` uses for the same
 * constraint.
 *
 * The two surfaces share ONE renderer (`SessionsEmptyState`) and differ only in
 * the `isUnavailable` signal each host derives. `apps/desktop` cannot import
 * `apps/app`, so only the DESKTOP side here runs a real shipped derivation
 * (`deriveSessionsAvailability`) against a real settled observer. Web's rule is
 * a hand-written literal, which makes this block ONE-DIRECTIONAL:
 *
 *   - it fails if DESKTOP regresses, and
 *   - it is NOT coverage for the web side. The real web builder is pinned by
 *     that page's own suite,
 *     `apps/app/app/(authenticated)/[orgSlug]/sessions/__tests__/page-read-failure-states.test.tsx`,
 *     which lands with ISS-7519 (PR #5596). Nothing in this repo binds the
 *     literal below to `apps/app`, so a web-side change away from
 *     `isLoadingError` would leave this green.
 *
 * Sequencing, because it is load-bearing and not visible from the diff: #5596 is
 * OPEN at the time of writing. On `main` today BOTH surfaces feed the raw
 * `isError`, so they are wrong together; whichever of the two PRs lands first
 * makes its surface right while the other stays wrong. What this block pins is
 * that desktop matches the behaviour web is landing, not that the two agree on
 * `main` right now.
 */
describe("web/desktop parity for a refetch failure over held data (ISS-7528)", () => {
  it("renders the SAME empty state on both surfaces for one settled observer", async () => {
    const observed: { result: UseQueryResult<AgentSessionsPageData> | null } = {
      result: null,
    };

    function PageDataProbe() {
      observed.result = useAgentSessionsPageData({});
      return null;
    }

    render(
      <QueryClientProvider client={queryClient}>
        <AgentSessionsDataSourceProvider
          dataSource={createControllableDataSource()}
        >
          <PageDataProbe />
        </AgentSessionsDataSourceProvider>
      </QueryClientProvider>
    );

    await waitFor(() => expect(observed.result?.isSuccess).toBe(true));

    readBehavior = "fail";
    await refetchPageData();

    const read = observed.result;
    // The state under test really is "errored while still holding data" — the
    // one state the two surfaces used to disagree about.
    expect(read?.isError).toBe(true);
    expect(read?.data).toBeDefined();

    const webIsUnavailable = read?.isLoadingError ?? false;
    const desktopIsUnavailable = deriveSessionsAvailability({
      displayState: "ready",
      isListError: read?.isError ?? false,
      isListLoadingError: read?.isLoadingError ?? false,
      isListErrorTransient: false,
      isListLoading: read?.isLoading ?? false,
    }).isUnavailable;

    const web = render(
      <SessionsEmptyState
        hasConnectedAgent={false}
        signals={{ hasActiveFilters: false, isUnavailable: webIsUnavailable }}
      />
    );
    const webTitle = web.container.textContent;
    web.unmount();

    const desktop = render(
      <SessionsEmptyState
        hasConnectedAgent={false}
        signals={{
          hasActiveFilters: false,
          isUnavailable: desktopIsUnavailable,
        }}
      />
    );
    const desktopTitle = desktop.container.textContent;

    // One settled observer, both derivations, compared to EACH OTHER rather than
    // each to its own constant — comparing separately is what lets a divergence
    // pass. (`isSyncing` is omitted on both renders because it is false in this
    // state; the shipped desktop host always passes it, which the first describe
    // block above covers by mounting the real view.)
    expect(desktopTitle).toBe(webTitle);
    // …and a positive pin on WHICH screen that is, so two surfaces agreeing on
    // the outage claim could not satisfy the equality above.
    expect(desktopTitle).toContain(ONBOARDING_TITLE);
  });
});

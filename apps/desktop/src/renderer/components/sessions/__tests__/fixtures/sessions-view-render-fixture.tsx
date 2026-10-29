import {
  type AgentSessionListResponse,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session";
import {
  Surface,
  type SurfaceAnalyticsCapture,
} from "@repo/api/src/types/surface-analytics";
import type { AgentSessionsDataSource } from "@repo/app/agents/data-source/agent-sessions-data-source";
import { AgentSessionsDataSourceProvider } from "@repo/app/agents/data-source/provider";
import { SurfaceAnalyticsProvider } from "@repo/app/shared/observability/surface-analytics-context";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { type Mock, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../../shared/contracts";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../../../shared/local-session-source-status";
import { createDesktopCloudPrimaryAgentSessionsDataSource } from "../../../../shared-agent-sessions/desktop-agent-sessions-data-source";
import {
  DesktopAppCoreMode,
  DesktopLocalReadReason,
} from "../../../../shared-agent-sessions/desktop-app-core-mode";
import { SessionsView } from "../../SessionsView";

/**
 * ISS-4837: the ONE shared render-test fixture for the desktop `SessionsView`
 * suites (`sessions-view-data-wins-render`, `sessions-view-status-self-heal`).
 *
 * Both suites need the same ~250 lines of scaffolding — the hoisted hook mocks,
 * the `vi.mock` blocks for every adapter `SessionsView` pulls in, the
 * `window.desktopApi` descriptor save/restore, and a render-then-flush helper —
 * and were carrying byte-near-identical copies of it. Any adapter or dependency
 * change had to be mirrored in both, and could silently drift. This module owns
 * that setup; each suite keeps only its own per-test overrides.
 *
 * Why the `vi.mock` calls live HERE and `SessionsView` is rendered through
 * {@link renderSessionsView} instead of imported by the suites: `vi.mock` is
 * hoisted to the top of the module that declares it, so the mocks are registered
 * before this module's own `SessionsView` import is evaluated. Routing every
 * render through this module therefore guarantees the mocks are in place no
 * matter how a suite's import list happens to be ordered by the formatter — a
 * suite that imported `SessionsView` directly could evaluate it unmocked.
 *
 * LOCAL mode by default: source-status suites keep that baseline while cloud
 * projection suites override the existing mode hook for their scenario.
 */

/**
 * The data hooks `SessionsView` consumes, mocked. Annotated explicitly (rather
 * than inferred) because `vi.hoisted`'s inferred `Mock` type resolves through a
 * pnpm-internal `@vitest/spy` path that `tsc` refuses to name (TS2742).
 */
export type SessionsViewHookMocks = {
  useAgentSessionAnalytics: Mock;
  useAgentSessionsPageData: Mock;
  useCancelAgentSessionsPageData: Mock;
  useAgentSessionUsage: Mock;
  useDesktopAppCoreMode: Mock;
  useFeatureFlagEnabled: Mock;
  useFeatureFlagEnabledOptional: Mock;
  useLocalAgentSessionUsage: Mock;
  useIngestProgress: Mock;
  useSessionsViewState: Mock;
  useSharedDateRange: Mock;
  useSearchParamsValue: Mock;
};

/** The navigation port, mocked. Annotated for the same TS2742 reason. */
export type SessionsViewNavigationMock = { replace: Mock };

const sessionsViewHooks: SessionsViewHookMocks = vi.hoisted(() => ({
  useAgentSessionAnalytics: vi.fn(),
  useAgentSessionsPageData: vi.fn(),
  useCancelAgentSessionsPageData: vi.fn(),
  useAgentSessionUsage: vi.fn(),
  useDesktopAppCoreMode: vi.fn(),
  useFeatureFlagEnabled: vi.fn(),
  useFeatureFlagEnabledOptional: vi.fn(),
  useLocalAgentSessionUsage: vi.fn(),
  useIngestProgress: vi.fn(),
  useSessionsViewState: vi.fn(),
  useSharedDateRange: vi.fn(),
  useSearchParamsValue: vi.fn(),
}));

const sessionsViewNavigation: SessionsViewNavigationMock = vi.hoisted(() => ({
  replace: vi.fn(),
}));

/**
 * The mocked data hooks, so each suite can set its own per-test return values
 * ({@link applyDefaultSessionsViewHooks} seeds the neutral baseline).
 *
 * Handed out through an accessor rather than exported directly: vitest refuses
 * to `export` a `vi.hoisted` binding ("Cannot export hoisted variable") unless
 * the importing file lists this module first — an invariant the formatter's
 * import sorting could quietly break. A function declaration is hoisted on its
 * own and reads the binding at call time, so suites are free to order imports
 * however they like.
 */
export function sessionsViewHookMocks(): SessionsViewHookMocks {
  return sessionsViewHooks;
}

/** The mocked navigation port, for a suite that asserts redirects. */
export function sessionsViewNavigationMock(): SessionsViewNavigationMock {
  return sessionsViewNavigation;
}

vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessionAnalytics: sessionsViewHooks.useAgentSessionAnalytics,
  useAgentSessionsPageData: sessionsViewHooks.useAgentSessionsPageData,
  useAgentSessionUsage: sessionsViewHooks.useAgentSessionUsage,
  useCancelAgentSessionsPageData:
    sessionsViewHooks.useCancelAgentSessionsPageData,
}));

vi.mock("../../use-local-agent-session-usage", () => ({
  useLocalAgentSessionUsage: sessionsViewHooks.useLocalAgentSessionUsage,
}));

vi.mock("../../../../hooks/use-ingest-progress", () => ({
  useIngestProgress: sessionsViewHooks.useIngestProgress,
}));

vi.mock("../../../../hooks/use-file-access-blocks", () => ({
  useFileAccessBlocks: () => [],
}));

vi.mock("@repo/app/agents/hooks/use-has-connected-agent", () => ({
  useHasConnectedAgent: () => ({ data: undefined }),
}));

vi.mock("@repo/app/agents/hooks/use-sessions-view-state", () => ({
  useSessionsViewState: sessionsViewHooks.useSessionsViewState,
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: sessionsViewHooks.useFeatureFlagEnabled,
  // ISS-4890/4906/4901 + ISS-4887 (carried in from #4265, which added this to
  // the per-suite inline mocks this fixture replaced): the shared sessions
  // table and summary strip read their gates OPTIONALLY, and a module mock is
  // exhaustive — omitting this export makes the whole subtree throw on the
  // missing import rather than fall back. PER-KEY since ISS-10188: the Sessions
  // grid reads three `GridTableV2` keys through this port, so one boolean for
  // every key made them answer for each other. The default still resolves every
  // key OFF, which is the flag default and the behavior these suites assert.
  // `=== true` so an unseeded mock reads OFF rather than `undefined`: twelve of
  // the suites sharing this fixture never call `applyDefaultSessionsViewHooks`.
  useFeatureFlagEnabledOptional: (key: string) =>
    sessionsViewHooks.useFeatureFlagEnabledOptional(key) === true,
  // FEA-4201: the readiness-carrying read. `isReady` is settled-ness, not
  // enabled-ness, and the real desktop port settles ASYNCHRONOUSLY — the
  // signed-in account's PostHog assignment arrives over the IPC bridge. This
  // mock pins it settled so the suites exercise the resolved state; `enabled`
  // mirrors this suite's own set.
  useFeatureFlagGate: (key: string) => ({
    enabled: sessionsViewHooks.useFeatureFlagEnabled(key),
    isReady: true,
  }),
  // ISS-9692: `useTablePageSizeOptions` reads the ladder gate through the
  // provider-optional port, so this exhaustive module mock owes it an entry
  // too. Same answer as the required gate above.
  useFeatureFlagGateOptional: (key: string) => ({
    enabled: sessionsViewHooks.useFeatureFlagEnabled(key),
    isReady: true,
  }),
}));

vi.mock("@repo/app/shared/hooks/use-shared-date-range", () => ({
  useSharedDateRange: sessionsViewHooks.useSharedDateRange,
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => sessionsViewNavigation,
}));

vi.mock("@repo/navigation/link", () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => "/sessions",
}));

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: sessionsViewHooks.useSearchParamsValue,
}));

vi.mock("../../agent-coaching-tips", () => ({
  AgentCoachingTips: () => <div data-testid="agent-coaching-tips" />,
}));

vi.mock("../../../../shared-agent-sessions/desktop-app-core-provider", () => ({
  useDesktopAppCoreMode: () =>
    sessionsViewHooks.useDesktopAppCoreMode() ?? DesktopAppCoreMode.Local,
  // ISS-5477: SessionsView derives the read-source badge detail from the
  // same provider, so this factory has to answer for it too.
  useDesktopLocalReadReason: () => DesktopLocalReadReason.SignedOut,
}));

vi.mock("../../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    state: { status: DesktopAuthStatus.Authenticated },
    beginSignIn: vi.fn().mockResolvedValue({ ok: true }),
    cancelSignIn: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
  }),
}));

/** The pre-install `window.desktopApi` descriptor, restored on teardown. */
let desktopApiDescriptor: PropertyDescriptor | undefined;

/** The empty, settled page-data read both suites start from. */
const SETTLED_EMPTY_PAGE_DATA = {
  data: { list: listWith([]), usage: undefined },
  isLoading: false,
  isError: false,
  isFetching: false,
  isPlaceholderData: false,
} as const;

/**
 * Seeds the neutral hook baseline every SessionsView render test needs (date
 * range, view state, usage, analytics, ingest progress, an empty settled
 * page-data read). Call from `beforeEach` AFTER `vi.clearAllMocks()`; override
 * only the hooks a given test is actually about.
 */
export function applyDefaultSessionsViewHooks(): void {
  sessionsViewHooks.useDesktopAppCoreMode.mockReturnValue(
    DesktopAppCoreMode.Local
  );
  sessionsViewHooks.useFeatureFlagEnabled.mockReturnValue(false);
  sessionsViewHooks.useFeatureFlagEnabledOptional.mockReturnValue(false);
  sessionsViewHooks.useSharedDateRange.mockReturnValue({
    dateRange: "7d",
    setDateRange: vi.fn(),
  });
  sessionsViewHooks.useSearchParamsValue.mockReturnValue(new URLSearchParams());
  sessionsViewHooks.useSessionsViewState.mockReturnValue({
    isViewReady: true,
    sortKey: null,
    sortDir: "desc",
    visibleColumns: new Set<string>(["name"]),
    setSort: vi.fn(),
    toggleColumn: vi.fn(),
  });
  sessionsViewHooks.useAgentSessionsPageData.mockReturnValue({
    ...SETTLED_EMPTY_PAGE_DATA,
    refetch: vi.fn(),
  });
  // ISS-7249: the hook returns the cancel callback Retry fires before its
  // refetch, so the baseline hands back a no-op one rather than `undefined`.
  sessionsViewHooks.useCancelAgentSessionsPageData.mockReturnValue(vi.fn());
  sessionsViewHooks.useAgentSessionUsage.mockReturnValue(
    SETTLED_EMPTY_PAGE_DATA
  );
  sessionsViewHooks.useAgentSessionAnalytics.mockReturnValue({
    data: undefined,
  });
  sessionsViewHooks.useLocalAgentSessionUsage.mockReturnValue({
    data: undefined,
    isError: false,
  });
  sessionsViewHooks.useIngestProgress.mockReturnValue(null);
}

/**
 * Installs a `window.desktopApi` stub, remembering the pre-existing descriptor
 * so {@link restoreDesktopApi} can put the global back exactly as it found it
 * (a sibling suite's teardown may have removed it entirely).
 */
export function installDesktopApiStub(value: unknown): void {
  desktopApiDescriptor = Object.getOwnPropertyDescriptor(window, "desktopApi");
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value,
  });
}

/** Restores the `window.desktopApi` descriptor captured at install time. */
export function restoreDesktopApi(): void {
  if (desktopApiDescriptor) {
    Object.defineProperty(window, "desktopApi", desktopApiDescriptor);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
  desktopApiDescriptor = undefined;
}

/**
 * A local-source probe that NEVER resolves — the ISS-4772 wedge. The status
 * therefore stays latched on its initial "starting" with nothing to re-check it.
 */
export function stuckLocalSourceProbe(): Mock {
  return vi.fn(() => new Promise<never>(() => undefined));
}

/**
 * A local-source probe that is stuck on its FIRST call and resolves "ready" on
 * every call after — the shape a self-heal test needs: latched on mount, healed
 * by whatever fires the next probe.
 */
export function probeStuckThenReady(): Mock {
  let call = 0;
  return vi.fn(() => {
    call += 1;
    if (call === 1) {
      return new Promise<never>(() => undefined);
    }
    return Promise.resolve({
      localSessionSourceStatus: LOCAL_SESSION_SOURCE_STATUSES.ready,
    });
  });
}

/** A page-data `list` payload with the given rows, read from the local source. */
export function listWith(items: { id: string }[]) {
  return {
    items,
    total: items.length,
    readSource: "local",
    viewerScope: AgentSessionViewerScope.Self,
  };
}

/**
 * Renders `SessionsView` and flushes the initial probe microtask, so a test
 * asserts against the first settled frame rather than the pre-effect one.
 */
/**
 * The provider stack `SessionsView` requires but these suites used to omit
 * (ISS-7869).
 *
 * The strip's GitHub connect wiring reaches for two things the desktop app root
 * has always supplied and these mount sites did not: the auth/API adapter stack
 * (`useGitHubConnectActionTarget` calls `useGitHubIntegrationStatus`, whose
 * `useApiClient()` runs at hook level — an `enabled: false` query still
 * requires the provider), and the ambient `QueryClient` it invalidates once a
 * connect lands.
 *
 * A fresh client per render keeps suites from sharing cache state, nested
 * INSIDE the story providers' own client so it is the one the read hooks
 * resolve; retries are off so a failing read surfaces immediately instead of
 * being retried past the assertion.
 */
export function SessionsViewTestProviders({
  children,
  dataSource,
  surfaceAnalyticsCapture = noopSurfaceAnalyticsCapture,
}: {
  children: ReactNode;
  /**
   * ISS-11913: the reads `SessionsView` issues through the data source rather
   * than through the mocked hooks above (the unwindowed outside-window probe).
   * Omitted, they fall through to the harness's HTTP fixture transport.
   */
  dataSource?: AgentSessionsDataSource;
  surfaceAnalyticsCapture?: SurfaceAnalyticsCapture;
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const content = (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return (
    <AppCoreStoryProviders>
      <SurfaceAnalyticsProvider
        capture={surfaceAnalyticsCapture}
        surface={Surface.Desktop}
      >
        {dataSource ? (
          <AgentSessionsDataSourceProvider dataSource={dataSource}>
            {content}
          </AgentSessionsDataSourceProvider>
        ) : (
          content
        )}
      </SurfaceAnalyticsProvider>
    </AppCoreStoryProviders>
  );
}

export async function renderSessionsView(
  props: ComponentProps<typeof SessionsView> = {},
  options: {
    dataSource?: AgentSessionsDataSource;
    surfaceAnalyticsCapture?: SurfaceAnalyticsCapture;
    wrapWith?: (children: ReactNode) => ReactNode;
  } = {}
): Promise<ReturnType<typeof render>> {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SessionsViewTestProviders
      dataSource={options.dataSource}
      surfaceAnalyticsCapture={options.surfaceAnalyticsCapture}
    >
      {options.wrapWith ? options.wrapWith(children) : children}
    </SessionsViewTestProviders>
  );
  const view = render(<SessionsView {...props} />, { wrapper });
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

/** Builds the real branded composite source for production-path presentation tests. */
export function createCompositeSessionsViewTestDataSource(): AgentSessionsDataSource {
  const emptyList = emptySessionList();
  return createDesktopCloudPrimaryAgentSessionsDataSource({
    cloudSource: createSessionsViewTestDataSource("cloud", emptyList),
    identity: { organizationId: "org-1", userId: "user-1" },
    localSource: createSessionsViewTestDataSource("local", emptyList),
  });
}

/** Builds the legacy flag-off HTTP-shaped source used before the composite. */
export function createLegacySessionsViewTestDataSource(): AgentSessionsDataSource {
  return createSessionsViewTestDataSource("http", emptySessionList());
}

/** Re-renders the same Desktop Sessions mount after a mocked read changes. */
export async function rerenderSessionsView(
  view: ReturnType<typeof render>,
  props: ComponentProps<typeof SessionsView> = {}
): Promise<void> {
  view.rerender(<SessionsView {...props} />);
  await act(async () => {
    await Promise.resolve();
  });
}

/** Flushes pending microtasks after `body()` inside a single `act()` window. */
export async function actAndFlush(body: () => void): Promise<void> {
  await act(async () => {
    body();
    await Promise.resolve();
  });
}

function noopSurfaceAnalyticsCapture(): void {}

function createSessionsViewTestDataSource(
  scope: string,
  emptyList: AgentSessionListResponse
): AgentSessionsDataSource {
  return {
    scope,
    list: vi.fn(async () => emptyList),
    detail: vi.fn(() => Promise.reject(new Error(`${scope} detail`))),
    usage: vi.fn(() => Promise.reject(new Error(`${scope} usage`))),
    analytics: vi.fn(() => Promise.reject(new Error(`${scope} analytics`))),
    pageData: vi.fn(async () => ({ list: emptyList })),
    updatePriority: vi.fn(async () => undefined),
  };
}

function emptySessionList(): AgentSessionListResponse {
  return {
    items: [],
    total: 0,
    viewerScope: AgentSessionViewerScope.Self,
  };
}

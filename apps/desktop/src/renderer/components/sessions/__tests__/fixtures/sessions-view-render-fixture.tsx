import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { type Mock, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../../shared/contracts";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../../../shared/local-session-source-status";
import { signedOutCutover } from "../../../../shared-agent-sessions/__tests__/fixtures/cloud-read-cutover-fixtures";
import { DesktopAppCoreMode } from "../../../../shared-agent-sessions/desktop-app-core-mode";
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
 * LOCAL mode throughout: that is the surface both suites test, where the display
 * state is driven by the local source status rather than collapsed to "ready".
 */

/**
 * The data hooks `SessionsView` consumes, mocked. Annotated explicitly (rather
 * than inferred) because `vi.hoisted`'s inferred `Mock` type resolves through a
 * pnpm-internal `@vitest/spy` path that `tsc` refuses to name (TS2742).
 */
export type SessionsViewHookMocks = {
  useAgentSessionAnalytics: Mock;
  useAgentSessionsPageData: Mock;
  useAgentSessionUsage: Mock;
  useFeatureFlagEnabled: Mock;
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
  useAgentSessionUsage: vi.fn(),
  useFeatureFlagEnabled: vi.fn(),
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

// Echo the two signals the real list content routes on (`isLoading`, item count)
// so a suite asserts which surface SessionsView selected without depending on
// the shared component's internal copy.
vi.mock("@repo/app/agents/components/sessions/agent-sessions-list", () => ({
  AgentSessionsListContent: (props: {
    isLoading?: boolean;
    items?: unknown[];
  }) => (
    <div
      data-is-loading={props.isLoading ? "true" : "false"}
      data-item-count={props.items?.length ?? 0}
      data-testid="sessions-table-body"
    />
  ),
}));

vi.mock("@repo/app/agents/components/sessions/sessions-toolbar", () => ({
  SessionsToolbar: () => <div data-testid="sessions-toolbar" />,
}));

vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessionAnalytics: sessionsViewHooks.useAgentSessionAnalytics,
  useAgentSessionsPageData: sessionsViewHooks.useAgentSessionsPageData,
  useAgentSessionUsage: sessionsViewHooks.useAgentSessionUsage,
}));

vi.mock("../../use-local-agent-session-usage", () => ({
  useLocalAgentSessionUsage: sessionsViewHooks.useLocalAgentSessionUsage,
}));

vi.mock("../../../../hooks/use-ingest-progress", () => ({
  useIngestProgress: sessionsViewHooks.useIngestProgress,
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
  // missing import rather than fall back. Both resolve OFF, which is the flag
  // default and the behavior these suites assert.
  useFeatureFlagEnabledOptional: () => false,
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
  useDesktopAppCoreMode: () => DesktopAppCoreMode.Local,
  // ISS-5477: SessionsView derives the read-source badge detail from the
  // same provider, so this factory has to answer for it too.
  useDesktopCloudReadCutover: () => signedOutCutover(),
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
  data: undefined,
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
  sessionsViewHooks.useFeatureFlagEnabled.mockReturnValue(false);
  sessionsViewHooks.useSharedDateRange.mockReturnValue({
    dateRange: "7d",
    setDateRange: vi.fn(),
  });
  sessionsViewHooks.useSearchParamsValue.mockReturnValue(new URLSearchParams());
  sessionsViewHooks.useSessionsViewState.mockReturnValue({
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
  };
}

/**
 * Renders `SessionsView` and flushes the initial probe microtask, so a test
 * asserts against the first settled frame rather than the pre-effect one.
 */
export async function renderSessionsView(): Promise<void> {
  render(<SessionsView />);
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

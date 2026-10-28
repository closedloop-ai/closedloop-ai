import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { AgentSessionListCapability } from "@repo/api/src/types/agent-session-list-contract";
import { ReadSource } from "@repo/api/src/types/read-source";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import { toDesktopLocalFallbackList } from "../../../shared-agent-sessions/desktop-session-source-precedence";
import { SessionsView } from "../SessionsView";
import {
  createCompositeSessionsViewTestDataSource,
  createLegacySessionsViewTestDataSource,
  SessionsViewTestProviders,
} from "./fixtures/sessions-view-render-fixture";

/**
 * FEA-4209 / FEA-4210 (whitlockk review): the desktop Sessions view has to WIRE the
 * linked-entity seams, not merely leave them wireable.
 *
 * `SyncedSessionsTable` gates the `Owning project` / `Linked issues` columns on
 * a host opt-in as well as the shared `grid-table-v2` flag, and the original
 * reasoning for that gate stopped at "the desktop local producer emits neither
 * field". But the desktop has two source modes and the CLOUD one reads the same
 * HTTP list the web app does, so its rows carry both fields — which meant a
 * cloud-mode desktop with the Labs toggle on got no columns and no View-menu
 * entries on data it already had in hand.
 *
 * This asserts against the props SessionsView actually hands the seam, in BOTH
 * modes, because the defect was a missing prop rather than a wrong value: an
 * assertion that only ran in cloud mode would have been just as green before the
 * fix if it checked the local half, and vice-versa.
 *
 * ISS-8909 rehomed the observation point. The v1 stack took `showLinkedEntityColumns`
 * and `includeLinkedEntityColumns` as two props on two children; the v2 surface
 * takes neither. `SessionsV2View` feeds SessionsView's two values into
 * `useSessionLinkedEntitySeams`, whose `renderIssues` / `renderProjects` are
 * `undefined` unless the columns are opted in, and `SessionsListSurfaceV2` folds
 * exactly those into `seamRenderers` — the single input `useSessionsListColumns`
 * uses to build BOTH the rendered columns and the View-menu's `toggleableColumns`.
 * So the seam's inputs and the renderers reaching the surface are the same two
 * claims this suite always made, read where they now live.
 */

const hooks = vi.hoisted(() => ({
  useAgentSessionAnalytics: vi.fn(),
  useAgentSessionsPageData: vi.fn(),
  useAgentSessionUsage: vi.fn(),
  useLocalAgentSessionUsage: vi.fn(),
  useIngestProgress: vi.fn(),
  useSessionsViewState: vi.fn(),
  useSharedDateRange: vi.fn(),
  useSearchParamsValue: vi.fn(),
}));

/** The seam inputs and the surface props each was last rendered with. */
const captured = vi.hoisted(() => ({
  seams: null as Record<string, unknown> | null,
  surface: null as Record<string, unknown> | null,
}));

/** Flipped per test; read through a getter so the module mock stays hoisted. */
const coreMode = vi.hoisted(() => ({ current: "cloud" as "cloud" | "local" }));

let desktopApiDescriptor: PropertyDescriptor | undefined;

// Spied, not replaced: the real hook still runs, so `renderIssues` /
// `renderProjects` are the genuine article and the assertion below is about
// wiring rather than about this mock's return value.
vi.mock(
  "@repo/app/agents/components/sessions/use-session-linked-entity-seams",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@repo/app/agents/components/sessions/use-session-linked-entity-seams")
      >();
    return {
      ...original,
      useSessionLinkedEntitySeams: (
        args: Parameters<typeof original.useSessionLinkedEntitySeams>[0]
      ) => {
        captured.seams = args as unknown as Record<string, unknown>;
        return original.useSessionLinkedEntitySeams(args);
      },
    };
  }
);

vi.mock(
  "@repo/app/agents/components/sessions/sessions-list-surface-v2",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@repo/app/agents/components/sessions/sessions-list-surface-v2")
      >();
    return {
      ...original,
      SessionsListSurfaceV2: (props: Record<string, unknown>) => {
        captured.surface = props;
        return <div data-testid={original.SESSIONS_HISTORY_LIST_TEST_ID} />;
      },
    };
  }
);

vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessionAnalytics: hooks.useAgentSessionAnalytics,
  useAgentSessionsPageData: hooks.useAgentSessionsPageData,
  useAgentSessionUsage: hooks.useAgentSessionUsage,
  // ISS-7249: Retry cancels the exact list read before refetching it.
  useCancelAgentSessionsPageData: () => () => undefined,
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

vi.mock("@repo/app/agents/hooks/use-has-connected-agent", () => ({
  useHasConnectedAgent: () => ({ data: undefined }),
}));

vi.mock("@repo/app/agents/hooks/use-sessions-view-state", () => ({
  useSessionsViewState: hooks.useSessionsViewState,
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
  useNavigation: () => ({ replace: vi.fn() }),
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
  useDesktopAppCoreMode: () =>
    coreMode.current === "cloud"
      ? DesktopAppCoreMode.Cloud
      : DesktopAppCoreMode.Local,
  useDesktopLocalReadReason: () => undefined,
}));

vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    state: { status: DesktopAuthStatus.Authenticated, userId: "user-1" },
    beginSignIn: vi.fn().mockResolvedValue({ ok: true }),
    cancelSignIn: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
  }),
}));

// The two IPC reads the issue-href builder depends on. Stubbed rather than
// exercised here — `use-desktop-linked-entity-columns.test.tsx` owns the href
// rule itself; this file is about whether the seams are wired at all.
vi.mock("../../../shared-agent-sessions/use-desktop-identity", () => ({
  useDesktopIdentity: () => ({
    identity: { organizationSlug: "acme" },
    isResolved: true,
  }),
}));

vi.mock("../../../shared-agent-sessions/use-web-app-origin", () => ({
  useWebAppOrigin: () => ({
    origin: "https://app.closedloop.ai",
    isResolved: true,
  }),
}));

describe("SessionsView — linked-entity column seams (FEA-4209 / FEA-4210)", () => {
  beforeEach(() => {
    desktopApiDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "desktopApi"
    );
    vi.clearAllMocks();
    captured.seams = null;
    captured.surface = null;
    hooks.useSharedDateRange.mockReturnValue({
      dateRange: "7d",
      setDateRange: vi.fn(),
    });
    hooks.useSearchParamsValue.mockReturnValue(new URLSearchParams());
    hooks.useSessionsViewState.mockReturnValue({
      isViewReady: true,
      sortKey: null,
      sortDir: "desc",
      visibleColumns: new Set<string>(["name"]),
      setSort: vi.fn(),
      toggleColumn: vi.fn(),
    });
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: {
        list: {
          items: [
            createAgentSessionListItemFixture({
              id: "session-1",
              linkedArtifacts: [],
              project: null,
            }),
          ],
          total: 1,
          readSource: ReadSource.Cloud,
        },
        usage: {
          totalSessions: 1,
          totalInputTokens: 10,
          totalOutputTokens: 5,
          earliestSessionAt: "2026-07-01T00:00:00.000Z",
          latestSessionAt: "2026-07-02T00:00:00.000Z",
          byRepository: [],
        },
      },
      isFetching: false,
      isPlaceholderData: false,
      isLoading: false,
      isError: false,
    });
    hooks.useAgentSessionUsage.mockReturnValue({
      data: {
        totalSessions: 1,
        totalInputTokens: 10,
        totalOutputTokens: 5,
        earliestSessionAt: "2026-07-01T00:00:00.000Z",
        latestSessionAt: "2026-07-02T00:00:00.000Z",
        byRepository: [],
      },
      isFetching: false,
      isPlaceholderData: false,
      isError: false,
    });
    hooks.useAgentSessionAnalytics.mockReturnValue({
      data: { byRepository: [] },
    });
    hooks.useLocalAgentSessionUsage.mockReturnValue({
      data: {
        totalSessions: 1,
        totalInputTokens: 10,
        totalOutputTokens: 5,
        byRepository: [],
      },
      isError: false,
    });
    hooks.useIngestProgress.mockReturnValue(null);
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        // Local mode needs a READY local monitor to get past the read gate and
        // render the list at all, which is what makes the local-half assertion
        // below a real negative rather than an unrendered one.
        getAgentMonitorUrl: vi.fn().mockResolvedValue("http://127.0.0.1:7777"),
        onDbChanged: vi.fn(() => undefined),
      },
    });
  });

  afterEach(() => {
    cleanup();
    if (desktopApiDescriptor) {
      Object.defineProperty(window, "desktopApi", desktopApiDescriptor);
    } else {
      Reflect.deleteProperty(window, "desktopApi");
    }
    desktopApiDescriptor = undefined;
  });

  it("opts the CLOUD-mode list and View menu into the linked-entity columns", async () => {
    coreMode.current = "cloud";
    render(<SessionsView />, {
      wrapper: SessionsViewTestProviders,
    });

    await waitFor(() => expect(captured.seams).not.toBeNull());
    // The columns themselves…
    expect(captured.seams?.showLinkedEntityColumns).toBe(true);
    // …and the route builder they need, or every issue chip would be inert on a
    // surface that can resolve a destination perfectly well.
    expect(typeof captured.seams?.getIssueHref).toBe("function");
    // …and the renderers that actually reach the surface, which is what gives
    // the columns AND their View-menu entries (`seamRenderers` is the one input
    // `useSessionsListColumns` builds both from).
    await waitFor(() => expect(captured.surface).not.toBeNull());
    expect(typeof captured.surface?.renderIssues).toBe("function");
    expect(typeof captured.surface?.renderProjects).toBe("function");
  });

  it("keeps source defaults on an empty fresh-composite cloud page", async () => {
    coreMode.current = "cloud";
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: { list: { items: [], readSource: ReadSource.Cloud, total: 0 } },
      isFetching: false,
      isPlaceholderData: false,
      isLoading: false,
      isError: false,
    });
    const dataSource = createCompositeSessionsViewTestDataSource();

    render(<SessionsView />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <SessionsViewTestProviders dataSource={dataSource}>
          {children}
        </SessionsViewTestProviders>
      ),
    });

    await waitFor(() => expect(captured.surface).not.toBeNull());
    expect(captured.seams).toMatchObject({ showLinkedEntityColumns: true });
    expect(captured.surface?.renderIssues).toBeTypeOf("function");
    expect(captured.surface?.renderProjects).toBeTypeOf("function");
    expect(captured.surface?.renderPriority).toBeTypeOf("function");
  });

  it("keeps the legacy flag-off cloud seams enabled on an empty page", async () => {
    coreMode.current = "cloud";
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: { list: { items: [], readSource: ReadSource.Cloud, total: 0 } },
      isFetching: false,
      isPlaceholderData: false,
      isLoading: false,
      isError: false,
    });

    render(<SessionsView />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <SessionsViewTestProviders
          dataSource={createLegacySessionsViewTestDataSource()}
        >
          {children}
        </SessionsViewTestProviders>
      ),
    });

    await waitFor(() => expect(captured.surface).not.toBeNull());
    expect(captured.seams).toMatchObject({ showLinkedEntityColumns: true });
    expect(captured.surface?.renderIssues).toBeTypeOf("function");
    expect(captured.surface?.renderProjects).toBeTypeOf("function");
    expect(captured.surface?.renderPriority).toBeTypeOf("function");
  });

  it("keeps the flag-off Local mode out of linked-entity columns", async () => {
    coreMode.current = "local";
    const localRow = createAgentSessionListItemFixture({
      id: "local-session",
      priority: null,
    });
    Reflect.deleteProperty(localRow, "linkedArtifacts");
    Reflect.deleteProperty(localRow, "project");
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: {
        list: {
          items: [localRow],
          total: 1,
          readSource: ReadSource.Local,
        },
      },
      isFetching: false,
      isPlaceholderData: false,
      isLoading: false,
      isError: false,
    });
    const dataSource = createLegacySessionsViewTestDataSource();
    render(<SessionsView />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <SessionsViewTestProviders dataSource={dataSource}>
          {children}
        </SessionsViewTestProviders>
      ),
    });

    // Rendered for real — the local producer emits neither `project` nor
    // `linkedArtifacts`, so opting in here would grow two tracks of em dashes
    // on an already ~1,000px-overflowing grid.
    await waitFor(() => expect(captured.seams).not.toBeNull());
    expect(captured.seams?.showLinkedEntityColumns).toBe(false);
    // No renderers reach the surface, so neither the columns nor their
    // View-menu entries exist on the local half.
    await waitFor(() => expect(captured.surface).not.toBeNull());
    expect(captured.surface?.renderIssues).toBeUndefined();
    expect(captured.surface?.renderProjects).toBeUndefined();
  });

  it("withholds flag-off Priority when a version-skew source has no writer", async () => {
    coreMode.current = "cloud";
    const localRow = createAgentSessionListItemFixture({
      id: "local-session",
      priority: null,
    });
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: {
        list: { items: [localRow], total: 1, readSource: ReadSource.Local },
      },
      isFetching: false,
      isPlaceholderData: false,
      isLoading: false,
      isError: false,
    });
    const dataSource = createLegacySessionsViewTestDataSource();
    Reflect.deleteProperty(dataSource, "updatePriority");

    render(<SessionsView />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <SessionsViewTestProviders dataSource={dataSource}>
          {children}
        </SessionsViewTestProviders>
      ),
    });

    await waitFor(() => expect(captured.surface).not.toBeNull());
    expect(captured.surface?.renderPriority).toBeUndefined();
  });

  it("keeps enabled fallback Priority visible when the row has a read-only operand", async () => {
    coreMode.current = "cloud";
    const fallbackList = toDesktopLocalFallbackList({
      items: [
        createAgentSessionListItemFixture({
          externalSessionId: "external-local-fallback",
          id: "local-fallback",
          priority: null,
        }),
      ],
      total: 1,
      viewerScope: AgentSessionViewerScope.Organization,
    });
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: { list: fallbackList },
      isFetching: false,
      isPlaceholderData: false,
      isLoading: false,
      isError: false,
    });
    const dataSource = createCompositeSessionsViewTestDataSource();
    Reflect.deleteProperty(dataSource, "updatePriority");

    render(<SessionsView />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <SessionsViewTestProviders dataSource={dataSource}>
          {children}
        </SessionsViewTestProviders>
      ),
    });

    await waitFor(() => expect(captured.surface).not.toBeNull());
    expect(captured.surface?.renderPriority).toBeTypeOf("function");
  });

  it("AC-008 DT-SP-11 keeps shipped cloud-mode capabilities available for fallback rows", async () => {
    coreMode.current = "cloud";
    const fallbackList = toDesktopLocalFallbackList({
      items: [
        createAgentSessionListItemFixture({
          externalSessionId: "external-local-fallback",
          id: "local-fallback",
          linkedArtifacts: [],
          name: "Local fallback",
          priority: null,
          tagPermissions: { canApply: true, canRemove: true },
          tags: [],
        }),
      ],
      pageInfo: {
        capability: AgentSessionListCapability.ServerPaginationV1,
        limit: 25,
        offset: 0,
      },
      total: 14,
      viewerScope: AgentSessionViewerScope.Organization,
    });
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: { list: fallbackList },
      isFetching: false,
      isPlaceholderData: false,
      isLoading: false,
      isError: false,
    });

    const dataSource = createCompositeSessionsViewTestDataSource();
    render(<SessionsView />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <SessionsViewTestProviders dataSource={dataSource}>
          {children}
        </SessionsViewTestProviders>
      ),
    });

    await waitFor(() => expect(captured.surface).not.toBeNull());
    expect(captured.seams).toMatchObject({ showLinkedEntityColumns: true });
    expect(captured.seams?.getIssueHref).toBeTypeOf("function");
    expect(captured.surface?.renderIssues).toBeTypeOf("function");
    expect(captured.surface?.renderProjects).toBeTypeOf("function");
    expect(captured.surface?.renderPriority).toBeTypeOf("function");
    expect(captured.surface?.renderTags).toBeTypeOf("function");
    expect(captured.surface?.exportItem).toBeDefined();
    expect(captured.surface?.pageInfo).toEqual({
      capability: AgentSessionListCapability.ServerPaginationV1,
      limit: 25,
      offset: 0,
    });
    expect(captured.surface?.rows).toEqual([
      expect.objectContaining({ id: "local-fallback" }),
    ]);
    const getSessionHref = captured.surface?.getSessionHref;
    if (typeof getSessionHref !== "function") {
      throw new Error("Sessions surface did not expose its detail href seam.");
    }
    expect(getSessionHref({ id: "local-fallback" })).toBe(
      "/sessions/local-fallback"
    );
  });
});

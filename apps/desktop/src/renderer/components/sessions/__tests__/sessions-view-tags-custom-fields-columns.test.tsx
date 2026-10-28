import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import type { CustomFieldWithOptions } from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { ReadSource } from "@repo/api/src/types/read-source";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { sessionsCustomFieldColumnId } from "@repo/app/agents/components/sessions/sessions-list-custom-fields";
import type { SessionsListSurfaceV2Props } from "@repo/app/agents/components/sessions/sessions-list-surface-v2-props";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import {
  reconcileDesktopSessionsFallback,
  toDesktopLocalFallbackList,
} from "../../../shared-agent-sessions/desktop-session-source-precedence";
import { SessionsView } from "../SessionsView";
import {
  createCompositeSessionsViewTestDataSource,
  createLegacySessionsViewTestDataSource,
  SessionsViewTestProviders,
} from "./fixtures/sessions-view-render-fixture";

/**
 * ISS-12455: the desktop Sessions view has to WIRE the Tags and custom-field
 * seams, not merely leave them wireable — the same defect shape FEA-4209 /
 * FEA-4210 found for the linked-entity columns
 * (`sessions-view-linked-entity-columns.test.tsx`), for the pair the ticket
 * found missing. In cloud mode Desktop already reads the same HTTP list the
 * web app does, so rows carry `tags`/`tagAvailability` and `customFields` —
 * the host just never passed `renderTags`/`customFields` down.
 *
 * Also pins the one deliberate asymmetry with the web host: `onCreateField`
 * stays stripped in cloud mode too. The bridge actually ADMITS
 * `POST /custom-fields` and `PUT /custom-fields/[id]` (added for Documents'
 * custom-field-settings surface, and the path-only allowlist has no notion of
 * which surface asked), so this is a deliberate product choice pending the
 * ticket's open "should Add Field be offered on Desktop?" question — not a
 * route the gateway would refuse.
 *
 * ISS-12691 added the `favorites` seam here too, on the same cloud/local gate:
 * a cloud session id is an artifact id, the same precondition `customFields`
 * and `renderTags` already rely on.
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
  useCustomFields: vi.fn(),
  useFavoriteArtifacts: vi.fn(),
}));

/** The surface props it was last rendered with. */
const captured = vi.hoisted<{
  surface: SessionsListSurfaceV2Props | null;
}>(() => ({ surface: null }));

/** Flipped per test; read through a getter so the module mock stays hoisted. */
const coreMode = vi.hoisted(() => ({ current: "cloud" as "cloud" | "local" }));

let desktopApiDescriptor: PropertyDescriptor | undefined;

const SESSION_FIELD: CustomFieldWithOptions = {
  id: "session-field",
  organizationId: "org-1",
  name: "session-field",
  description: null,
  fieldType: CustomFieldType.Text,
  createdById: null,
  createdAt: new Date("2026-08-28T00:00:00.000Z"),
  updatedAt: new Date("2026-08-28T00:00:00.000Z"),
  precision: null,
  numberFormat: null,
  currencyCode: null,
  customLabel: null,
  customLabelPosition: null,
  isGlobalToOrg: true,
  entityTypes: [CustomFieldEntityType.Session],
  referenceTargetSources: [],
  showInTable: true,
  isSearchable: false,
  isSortable: false,
  enumOptions: [],
};

vi.mock(
  "@repo/app/agents/components/sessions/sessions-list-surface-v2",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@repo/app/agents/components/sessions/sessions-list-surface-v2")
      >();
    return {
      ...original,
      SessionsListSurfaceV2: (props: SessionsListSurfaceV2Props) => {
        captured.surface = props;
        return <div data-testid={original.SESSIONS_HISTORY_LIST_TEST_ID} />;
      },
    };
  }
);

vi.mock("@repo/app/custom-fields/hooks/use-custom-fields", () => ({
  useCreateCustomField: () => ({ mutateAsync: vi.fn() }),
  useCustomFieldReferenceTargetSearch: () => vi.fn(),
  useCustomFields: (options: unknown) => hooks.useCustomFields(options),
  useUpdateCustomField: () => ({ mutateAsync: vi.fn() }),
  useUpdateCustomFieldValueForEntityType: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("@repo/app/users/hooks/use-users", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/app/users/hooks/use-users")>()),
  useOrganizationUsers: () => ({ data: [] }),
}));

vi.mock("@repo/app/documents/hooks/use-artifact-favorites", () => ({
  useFavoriteArtifacts: (options: unknown) =>
    hooks.useFavoriteArtifacts(options),
  useToggleFavoriteArtifact: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
}));

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
  useFeatureFlagGate: () => ({ enabled: false, isReady: true }),
  useFeatureFlagGateOptional: () => ({ enabled: false, isReady: true }),
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

describe("SessionsView — Tags and custom-field column seams (ISS-12455)", () => {
  beforeEach(() => {
    desktopApiDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "desktopApi"
    );
    vi.clearAllMocks();
    captured.surface = null;
    hooks.useCustomFields.mockReturnValue({
      data: [SESSION_FIELD],
      isSuccess: true,
    });
    hooks.useFavoriteArtifacts.mockReturnValue({
      data: [],
      isError: false,
      isPending: false,
    });
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
          items: [{ id: "session-1", customFields: [], tags: [] }],
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

  it("opts the CLOUD-mode list into Tags and custom fields, with field-creation stripped", async () => {
    coreMode.current = "cloud";
    render(<SessionsView />, {
      wrapper: SessionsViewTestProviders,
    });

    await waitFor(() => expect(captured.surface).not.toBeNull());
    await waitFor(() =>
      expect(typeof captured.surface?.renderTags).toBe("function")
    );
    const customFields = captured.surface?.customFields;
    expect(customFields).not.toBeUndefined();
    expect(customFields?.fields).toEqual([SESSION_FIELD]);
    // Deliberately stripped pending the ticket's open "Add Field?" question —
    // see the module docstring above.
    expect(customFields?.onCreateField).toBeUndefined();
    expect(customFields?.onAddExistingField).toBeUndefined();
    // ISS-12691: the same cloud-mode opt-in for the favorite star.
    const favorites = captured.surface?.favorites as
      | { onChange: unknown; favoriteIds: ReadonlySet<string> }
      | undefined;
    expect(favorites).not.toBeUndefined();
    expect(typeof favorites?.onChange).toBe("function");
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
    expect(captured.surface?.renderTags).toBeTypeOf("function");
    expect(captured.surface?.customFields).toBeDefined();
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
    expect(captured.surface?.renderTags).toBeTypeOf("function");
    expect(captured.surface?.customFields).toBeDefined();
  });

  it("withholds custom fields when a mixed fallback row lacks the projection", async () => {
    coreMode.current = "cloud";
    const cloudRow = createAgentSessionListItemFixture({
      customFields: [],
      externalSessionId: "cloud-external",
      id: "cloud-row",
      linkedArtifacts: [],
      priority: null,
      project: null,
      tags: [],
    });
    const localRow = createAgentSessionListItemFixture({
      externalSessionId: "local-external",
      id: "local-row",
    });
    Reflect.deleteProperty(localRow, "customFields");
    Reflect.deleteProperty(localRow, "linkedArtifacts");
    Reflect.deleteProperty(localRow, "priority");
    Reflect.deleteProperty(localRow, "project");
    Reflect.deleteProperty(localRow, "tags");
    const mixed = reconcileDesktopSessionsFallback({
      cachedCloud: {
        items: [cloudRow],
        total: 1,
        viewerScope: AgentSessionViewerScope.Self,
      },
      limit: 25,
      local: {
        items: [localRow],
        total: 1,
        viewerScope: AgentSessionViewerScope.Self,
      },
    });
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: { list: mixed },
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
    expect(captured.surface?.customFields).toBeUndefined();
    expect(captured.surface?.renderTags).toBeTypeOf("function");
    expect(captured.surface?.renderPriority).toBeTypeOf("function");
    expect(captured.surface?.renderIssues).toBeTypeOf("function");
    expect(captured.surface?.renderProjects).toBeTypeOf("function");
  });

  it("hands the surface a visible-column set the custom-field headers survive", async () => {
    // ISS-12455 (whitlockk review): passing the controller is not the wiring. The
    // surface filters its custom-field headers against
    // `controlledView.value.visibleColumnIds`, and a host that built that set
    // from `toSessionsListViewState` alone handed over BUILT-IN ids only — so
    // the definitions loaded, the controller arrived, and not one custom header
    // rendered. The rendered proof is the launched-app spec
    // (`apps/desktop/test/e2e/sessions-list-tags-custom-field-columns.spec.ts`);
    // this pins the seam value the mocked surface can see.
    coreMode.current = "cloud";
    render(<SessionsView />, {
      wrapper: SessionsViewTestProviders,
    });

    await waitFor(() => expect(captured.surface).not.toBeNull());
    await waitFor(() => {
      const controlledView = captured.surface?.controlledView;
      expect([...(controlledView?.value.visibleColumnIds ?? [])]).toContain(
        sessionsCustomFieldColumnId(SESSION_FIELD.id)
      );
    });
  });

  it("withholds every optional seam from an operand-less composite fallback row", async () => {
    coreMode.current = "cloud";
    const localRow = createAgentSessionListItemFixture({
      externalSessionId: "local-external",
      id: "local-row",
    });
    Reflect.deleteProperty(localRow, "customFields");
    Reflect.deleteProperty(localRow, "linkedArtifacts");
    Reflect.deleteProperty(localRow, "priority");
    Reflect.deleteProperty(localRow, "project");
    Reflect.deleteProperty(localRow, "tags");
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: {
        list: toDesktopLocalFallbackList({
          items: [localRow],
          total: 1,
          viewerScope: AgentSessionViewerScope.Self,
        }),
      },
      isFetching: false,
      isPlaceholderData: false,
      isLoading: false,
      isError: false,
    });

    render(<SessionsView />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <SessionsViewTestProviders
          dataSource={createCompositeSessionsViewTestDataSource()}
        >
          {children}
        </SessionsViewTestProviders>
      ),
    });

    await waitFor(() => expect(captured.surface).not.toBeNull());
    expect(captured.surface?.customFields).toBeUndefined();
    expect(captured.surface?.renderIssues).toBeUndefined();
    expect(captured.surface?.renderPriority).toBeUndefined();
    expect(captured.surface?.renderProjects).toBeUndefined();
    expect(captured.surface?.renderTags).toBeUndefined();
  });

  it("keeps the LOCAL-mode list out of Tags and custom fields entirely", async () => {
    coreMode.current = "local";
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: {
        list: {
          items: [{ id: "session-1" }],
          total: 1,
          readSource: ReadSource.Local,
        },
      },
      isFetching: false,
      isPlaceholderData: false,
      isLoading: false,
      isError: false,
    });
    render(<SessionsView />, {
      wrapper: SessionsViewTestProviders,
    });

    // Rendered for real — the local producer emits no org tag vocabulary and no
    // `customFields` projection, so opting in here would grow an em-dash track
    // on data the local source never had.
    await waitFor(() => expect(captured.surface).not.toBeNull());
    expect(captured.surface?.renderTags).toBeUndefined();
    expect(captured.surface?.customFields).toBeUndefined();
    // ISS-12691: a local-mode session id is not an artifact id, so the star
    // has nothing to read or persist against either.
    expect(captured.surface?.favorites).toBeUndefined();
  });
});

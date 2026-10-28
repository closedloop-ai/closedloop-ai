import { GRID_TABLE_SCROLL_BAND_TEST_ID } from "@closedloop-ai/design-system/components/ui/grid-table-list-surface";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import { SESSIONS_ARTIFACT_TAGS_FLAG_KEY } from "@repo/api/src/types/sessions-artifact-tags-flag";
import { ArtifactTagAvailability } from "@repo/api/src/types/tag";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../../shared/local-session-source-status";
import { RouteScrollerProvider } from "../../../navigation/route-scroller-context";
import { NavId } from "../../../navigation/route-table";
import { useContentScrollRestoration } from "../../../navigation/use-content-scroll-restoration";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import {
  applyDefaultSessionsViewHooks,
  createLegacySessionsViewTestDataSource,
  installDesktopApiStub,
  listWith,
  renderSessionsView,
  rerenderSessionsView,
  restoreDesktopApi,
  sessionsViewHookMocks,
} from "./fixtures/sessions-view-render-fixture";

const VIEWER_ID = "11111111-1111-4111-8111-111111111111";
const ROW_ID = "revision-row";
const ROW_NAME = "agent/revision-work";
const FIRST_ROW = createAgentSessionListItemFixture({
  id: ROW_ID,
  name: ROW_NAME,
  status: SESSION_STATUS.ACTIVE,
  tagAvailability: ArtifactTagAvailability.Available,
  tagPermissions: { canApply: true, canRemove: true },
  user: { id: VIEWER_ID, name: "Session owner" },
});
const SECOND_ROW = createAgentSessionListItemFixture({
  id: "revision-other",
  name: "agent/other-work",
  tagAvailability: ArtifactTagAvailability.Available,
  tagPermissions: { canApply: true, canRemove: true },
});

vi.mock("@repo/app/users/hooks/use-users", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@repo/app/users/hooks/use-users")>();
  return {
    ...original,
    useCurrentUser: () => ({ data: { id: VIEWER_ID } }),
  };
});
vi.mock("@closedloop-ai/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

let restoreWidth: (() => void) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  applyDefaultSessionsViewHooks();
  sessionsViewHookMocks().useDesktopAppCoreMode.mockReturnValue(
    DesktopAppCoreMode.Cloud
  );
  sessionsViewHookMocks().useFeatureFlagEnabledOptional.mockImplementation(
    (key: string) => key === SESSIONS_ARTIFACT_TAGS_FLAG_KEY
  );
  sessionsViewHookMocks().useSessionsViewState.mockReturnValue({
    isViewReady: true,
    sortKey: null,
    sortDir: "desc",
    visibleColumns: new Set(["name", "status"]),
    setSort: vi.fn(),
    toggleColumn: vi.fn(),
  });
  restoreWidth = stubContainerWidthPx(1440);
});

afterEach(() => {
  cleanup();
  restoreDesktopApi();
  restoreWidth?.();
  restoreWidth = undefined;
});

describe("Desktop Sessions revision refresh", () => {
  it("keeps selected rows and an in-progress rename when onDbChanged supplies replacement rows", async () => {
    const callbacks: Array<() => void> = [];
    const sourceStatus = vi.fn().mockResolvedValue({
      localSessionSourceStatus: LOCAL_SESSION_SOURCE_STATUSES.ready,
    });
    installDesktopApiStub({
      getLocalSessionSourceStatus: sourceStatus,
      onDbChanged: (callback: () => void) => {
        callbacks.push(callback);
        return () => undefined;
      },
    });
    const firstRows = [FIRST_ROW, SECOND_ROW];
    const pageData = (items: typeof firstRows) => ({
      data: { list: listWith(items) },
      isError: false,
      isFetching: false,
      isLoading: false,
      isPlaceholderData: false,
      refetch: vi.fn(),
    });
    sessionsViewHookMocks().useAgentSessionsPageData.mockReturnValue(
      pageData(firstRows)
    );
    const dataSource = {
      ...createLegacySessionsViewTestDataSource(),
      renameSession: vi.fn().mockResolvedValue(undefined),
    };
    const view = await renderSessionsView({}, { dataSource });
    const row = view.container.querySelector<HTMLElement>(
      `[data-grid-row-id="${ROW_ID}"]`
    );
    if (!row) {
      throw new Error("Expected the Desktop production row");
    }
    fireEvent.click(row);
    expect(row.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(
      await screen.findByRole("button", {
        name: `Edit session name for ${ROW_NAME}`,
      })
    );
    const draft = screen.getByRole("textbox", {
      name: `Edit session name for ${ROW_NAME}`,
    });
    fireEvent.change(draft, { target: { value: "unfinished rename" } });
    expect(document.activeElement).toBe(draft);
    expect(callbacks.length).toBeGreaterThan(0);

    sessionsViewHookMocks().useAgentSessionsPageData.mockReturnValue(
      pageData([{ ...FIRST_ROW, status: SESSION_STATUS.INACTIVE }, SECOND_ROW])
    );
    await act(async () => {
      for (const callback of callbacks) {
        callback();
      }
      await Promise.resolve();
    });
    await rerenderSessionsView(view);
    expect(
      within(row).getByText(SESSION_STATUS_LABELS[SESSION_STATUS.INACTIVE])
    ).toBeTruthy();
    expect(row.isConnected).toBe(true);
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(draft.isConnected).toBe(true);
    expect(draft).toHaveProperty("value", "unfinished rename");
    expect(document.activeElement).toBe(draft);
    expect(dataSource.renameSession).not.toHaveBeenCalled();
  });

  it("keeps the shell route-scroll anchor through a typed DB revision refresh and detail round trip", async () => {
    const callbacks: Array<(payload: { sessionId?: string }) => void> = [];
    installDesktopApiStub({
      getLocalSessionSourceStatus: vi.fn().mockResolvedValue({
        localSessionSourceStatus: LOCAL_SESSION_SOURCE_STATUSES.ready,
      }),
      onDbChanged: (callback: (payload: { sessionId?: string }) => void) => {
        callbacks.push(callback);
        return () => undefined;
      },
    });
    const pageData = (
      status: (typeof SESSION_STATUS)[keyof typeof SESSION_STATUS]
    ) => ({
      data: {
        list: listWith([{ ...FIRST_ROW, status }, SECOND_ROW]),
      },
      isError: false,
      isFetching: false,
      isLoading: false,
      isPlaceholderData: false,
      refetch: vi.fn(),
    });
    sessionsViewHookMocks().useAgentSessionsPageData.mockReturnValue(
      pageData(SESSION_STATUS.ACTIVE)
    );
    const dataSource = createLegacySessionsViewTestDataSource();
    const href = "/sessions/iss-9529-revision-scroll";
    let setScrollKey: ((key: string | null) => void) | undefined;

    function RouteScrollHarness({ children }: { children: ReactNode }) {
      const [scrollKey, updateScrollKey] = useState<string | null>(href);
      setScrollKey = updateScrollKey;
      const { registerRouteScroller } = useContentScrollRestoration(scrollKey);
      return (
        <RouteScrollerProvider
          activeNavId={NavId.Sessions}
          navId={NavId.Sessions}
          registerRouteScroller={registerRouteScroller}
        >
          {children}
        </RouteScrollerProvider>
      );
    }

    const view = await renderSessionsView(
      {},
      {
        dataSource,
        wrapWith: (children) => (
          <RouteScrollHarness>{children}</RouteScrollHarness>
        ),
      }
    );
    const band = screen.getByTestId(GRID_TABLE_SCROLL_BAND_TEST_ID);
    Object.defineProperties(band, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1000 },
    });
    band.scrollTop = 180;
    fireEvent.scroll(band);
    expect(callbacks.length).toBeGreaterThan(0);

    sessionsViewHookMocks().useAgentSessionsPageData.mockReturnValue(
      pageData(SESSION_STATUS.INACTIVE)
    );
    await act(async () => {
      for (const callback of callbacks) {
        callback({ sessionId: ROW_ID });
      }
      await Promise.resolve();
    });
    await rerenderSessionsView(view);
    expect(
      within(band).getByText(SESSION_STATUS_LABELS[SESSION_STATUS.INACTIVE])
    ).toBeTruthy();
    expect(band.isConnected).toBe(true);
    expect(band.scrollTop).toBe(180);

    act(() => setScrollKey?.(null));
    band.scrollTop = 0;
    act(() => setScrollKey?.(href));
    expect(band.scrollTop).toBe(180);
  });
});

import { batchItemApplied } from "@repo/api/src/types/batch-mutation-result";
import { SESSIONS_ARTIFACT_TAGS_FLAG_KEY } from "@repo/api/src/types/sessions-artifact-tags-flag";
import {
  ArtifactTagAvailability,
  TagColor,
  TagEntityType,
} from "@repo/api/src/types/tag";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import {
  ARTIFACT_BULK_ACTION_BAR_FEATURE_FLAG_KEY,
  ARTIFACT_TAGS_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { DateRange } from "@repo/app/shared/lib/format-utils";
import { BULK_TAG_ACTION_LABEL } from "@repo/app/tags/lib/bulk-tag-labels";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../../shared/local-session-source-status";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import {
  applyDefaultSessionsViewHooks,
  installDesktopApiStub,
  listWith,
  renderSessionsView,
  restoreDesktopApi,
  sessionsViewHookMocks,
} from "./fixtures/sessions-view-render-fixture";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("@repo/app/shared/api/use-api-client-optional", () => ({
  useApiClientOptional: () => api,
}));
vi.mock("@closedloop-ai/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

const IDS = ["artifact-a", "artifact-b"];
const TAG = { id: "tag-a", name: "backend", color: TagColor.Blue };
const ROW_TAG_EDITOR_NAME = /^Edit tags for /;
let restoreWidth: (() => void) | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  applyDefaultSessionsViewHooks();
  sessionsViewHookMocks().useFeatureFlagEnabledOptional.mockImplementation(
    (key: string) => key === SESSIONS_ARTIFACT_TAGS_FLAG_KEY
  );
  sessionsViewHookMocks().useSharedDateRange.mockReturnValue({
    dateRange: DateRange.AllTime,
    setDateRange: vi.fn(),
  });
  installDesktopApiStub({
    getLocalSessionSourceStatus: vi.fn().mockResolvedValue({
      localSessionSourceStatus: LOCAL_SESSION_SOURCE_STATUSES.ready,
    }),
    onDbChanged: () => () => undefined,
  });
  api.get.mockResolvedValue([TAG]);
  api.post.mockResolvedValue({ results: IDS.map(batchItemApplied) });
  restoreWidth = stubContainerWidthPx(1440);
});

afterEach(() => {
  cleanup();
  restoreDesktopApi();
  restoreWidth?.();
  restoreWidth = undefined;
});

describe("Desktop Sessions host tag opt-in", () => {
  it("uses the shared registry for cloud Sessions but not system status", async () => {
    sessionsViewHookMocks().useDesktopAppCoreMode.mockReturnValue(
      DesktopAppCoreMode.Cloud
    );
    sessionsViewHookMocks().useFeatureFlagEnabledOptional.mockImplementation(
      (key: string) => key === ARTIFACT_BULK_ACTION_BAR_FEATURE_FLAG_KEY
    );
    api.get.mockImplementation((route: string) => {
      if (route === "/projects") {
        return Promise.resolve([{ id: "project-1", name: "Platform" }]);
      }
      if (route === "/users") {
        return Promise.resolve([{ id: "user-1", email: "ada@example.com" }]);
      }
      return Promise.resolve([]);
    });
    const rows = IDS.map((id) => createAgentSessionListItemFixture({ id }));
    sessionsViewHookMocks().useAgentSessionsPageData.mockReturnValue({
      data: { list: listWith(rows) },
      isError: false,
      isFetching: false,
      isLoading: false,
      isPlaceholderData: false,
      refetch: vi.fn(),
    });
    const { container } = await renderSessionsView();
    const first = container.querySelector<HTMLElement>(
      `[data-grid-row-id="${IDS[0]}"]`
    );
    const second = container.querySelector<HTMLElement>(
      `[data-grid-row-id="${IDS[1]}"]`
    );
    if (!(first && second)) {
      throw new Error("Missing cloud Session rows");
    }
    fireEvent.click(first);
    fireEvent.click(second, { ctrlKey: true });
    expect(
      await screen.findByRole("button", { name: "Move to project" })
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Assign owner" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Change status" })).toBeNull();
  });
  it("wires the real shared rail for projected writable artifact rows", async () => {
    const rows = IDS.map((id) =>
      createAgentSessionListItemFixture({
        id,
        tagAvailability: ArtifactTagAvailability.Available,
        tagPermissions: { canApply: true, canRemove: false },
      })
    );
    sessionsViewHookMocks().useAgentSessionsPageData.mockReturnValue({
      data: { list: listWith(rows) },
      isError: false,
      isFetching: false,
      isLoading: false,
      isPlaceholderData: false,
      refetch: vi.fn(),
    });
    const { container } = await renderSessionsView();
    expect(screen.getByRole("grid").getAttribute("aria-multiselectable")).toBe(
      "true"
    );
    const first = container.querySelector<HTMLElement>(
      `[data-grid-row-id="${IDS[0]}"]`
    );
    const second = container.querySelector<HTMLElement>(
      `[data-grid-row-id="${IDS[1]}"]`
    );
    if (!(first && second)) {
      throw new Error("Projected artifact rows did not render");
    }
    fireEvent.click(first);
    fireEvent.click(second, { ctrlKey: true });
    fireEvent.click(
      screen.getByRole("button", { name: BULK_TAG_ACTION_LABEL })
    );
    fireEvent.click(await screen.findByRole("button", { name: TAG.name }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledExactlyOnceWith(
        "/entity-tags/batch/v2",
        { tagId: TAG.id, entityType: TagEntityType.Artifact, entityIds: IDS }
      )
    );
    // Operator ruling on the ISS-12305 review (Asana precedent): the picker
    // closes and the selection stays.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: TAG.name })).toBeNull()
    );
    expect(screen.getByRole("toolbar").isConnected).toBe(true);
  });

  it("keeps denied rows selectable while refusing a mixed Desktop bulk write", async () => {
    const rows = IDS.map((id, index) =>
      createAgentSessionListItemFixture({
        id,
        tagAvailability: ArtifactTagAvailability.Available,
        tagPermissions:
          index === 0
            ? { canApply: true, canRemove: false }
            : { canApply: false, canRemove: false },
      })
    );
    sessionsViewHookMocks().useAgentSessionsPageData.mockReturnValue({
      data: { list: listWith(rows) },
      isError: false,
      isFetching: false,
      isLoading: false,
      isPlaceholderData: false,
      refetch: vi.fn(),
    });
    const { container } = await renderSessionsView();
    const first = container.querySelector<HTMLElement>(
      `[data-grid-row-id="${IDS[0]}"]`
    );
    const second = container.querySelector<HTMLElement>(
      `[data-grid-row-id="${IDS[1]}"]`
    );
    if (!(first && second)) {
      throw new Error("Missing mixed-permission Desktop rows");
    }
    fireEvent.click(first);
    fireEvent.click(second, { ctrlKey: true });
    expect(second.getAttribute("aria-selected")).toBe("true");
    expect(
      screen.queryByRole("button", { name: "Session actions" })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: BULK_TAG_ACTION_LABEL })
    ).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });

  // Operator ruling on the ISS-12305 review (Asana precedent): every row stays
  // selectable whatever its eligibility; only the write skips ineligible rows.
  it("keeps permission-free local rows selectable but offers them no tag write", async () => {
    const rows = IDS.map((id) => createAgentSessionListItemFixture({ id }));
    sessionsViewHookMocks().useAgentSessionsPageData.mockReturnValue({
      data: { list: listWith(rows) },
      isError: false,
      isFetching: false,
      isLoading: false,
      isPlaceholderData: false,
      refetch: vi.fn(),
    });
    const { container } = await renderSessionsView();
    expect(screen.getByRole("grid").getAttribute("aria-multiselectable")).toBe(
      "true"
    );
    const first = container.querySelector<HTMLElement>(
      `[data-grid-row-id="${IDS[0]}"]`
    );
    const second = container.querySelector<HTMLElement>(
      `[data-grid-row-id="${IDS[1]}"]`
    );
    if (!(first && second)) {
      throw new Error("Local rows did not render");
    }
    fireEvent.click(first);
    fireEvent.click(second, { ctrlKey: true });
    expect(screen.getByRole("toolbar").isConnected).toBe(true);
    expect(
      screen.queryByRole("button", { name: BULK_TAG_ACTION_LABEL })
    ).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });

  it.each([
    { state: "absent", flags: undefined },
    { state: "off", flags: [] },
    { state: "wrong key", flags: [ARTIFACT_TAGS_FEATURE_FLAG_KEY] },
  ])(
    "withholds Desktop bulk tags for the exact flag $state (DT-G01)",
    async ({ flags }) => {
      sessionsViewHookMocks().useFeatureFlagEnabledOptional.mockImplementation(
        (key: string) => flags?.some((flag) => flag === key)
      );
      const rows = IDS.map((id) =>
        createAgentSessionListItemFixture({
          id,
          tagAvailability: ArtifactTagAvailability.Available,
          tagPermissions: { canApply: true, canRemove: true },
        })
      );
      sessionsViewHookMocks().useAgentSessionsPageData.mockReturnValue({
        data: { list: listWith(rows) },
        isError: false,
        isFetching: false,
        isLoading: false,
        isPlaceholderData: false,
        refetch: vi.fn(),
      });
      const { container } = await renderSessionsView();
      for (const id of IDS) {
        const row = container.querySelector<HTMLElement>(
          `[data-grid-row-id="${id}"]`
        );
        if (!row) {
          throw new Error(`Missing writable row ${id}`);
        }
        fireEvent.click(row, { ctrlKey: true });
      }
      expect(
        screen.queryByRole("button", { name: BULK_TAG_ACTION_LABEL })
      ).toBeNull();
      expect(api.post).not.toHaveBeenCalled();
      expect(
        sessionsViewHookMocks().useFeatureFlagEnabledOptional
      ).toHaveBeenCalledWith(SESSIONS_ARTIFACT_TAGS_FLAG_KEY);
    }
  );

  // ISS-12455 made the Desktop cloud Tags cell editable per row; bulk tagging
  // sits beside that editor rather than replacing it.
  it("renders Desktop projected tags with each row's editor and no write on mount (DT-T03/T04)", async () => {
    sessionsViewHookMocks().useDesktopAppCoreMode.mockReturnValue(
      DesktopAppCoreMode.Cloud
    );
    sessionsViewHookMocks().useSessionsViewState.mockReturnValue({
      isViewReady: true,
      sortKey: null,
      sortDir: "desc",
      visibleColumns: new Set(["name", "tags"]),
      setSort: vi.fn(),
      toggleColumn: vi.fn(),
    });
    const rows = IDS.map((id) =>
      createAgentSessionListItemFixture({
        id,
        tags: [TAG],
        tagAvailability: ArtifactTagAvailability.Available,
        tagPermissions: { canApply: true, canRemove: true },
      })
    );
    sessionsViewHookMocks().useAgentSessionsPageData.mockReturnValue({
      data: { list: listWith(rows) },
      isError: false,
      isFetching: false,
      isLoading: false,
      isPlaceholderData: false,
      refetch: vi.fn(),
    });
    await renderSessionsView();
    expect(screen.getAllByText(TAG.name)).toHaveLength(2);
    expect(
      screen.getAllByRole("button", { name: ROW_TAG_EDITOR_NAME })
    ).toHaveLength(rows.length);
    expect(api.post).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });
});

import { batchItemApplied } from "@repo/api/src/types/batch-mutation-result";
import { BatchMutationRoute } from "@repo/api/src/types/batch-mutation-routes";
import { SESSIONS_ARTIFACT_TAGS_FLAG_KEY } from "@repo/api/src/types/sessions-artifact-tags-flag";
import {
  ArtifactTagAvailability,
  TagColor,
  TagEntityType,
} from "@repo/api/src/types/tag";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { ApiAdapterProvider } from "@repo/app/shared/api/provider";
import { DateRange } from "@repo/app/shared/lib/format-utils";
import { BULK_TAG_ACTION_LABEL } from "@repo/app/tags/lib/bulk-tag-labels";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness } from "../../../../../test/cloud-api-fetch-ipc-test-harness";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../../shared/local-session-source-status";
import { createDesktopCloudApiAdapter } from "../../../shared-agent-sessions/cloud-api-adapter";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import {
  applyDefaultSessionsViewHooks,
  installDesktopApiStub,
  listWith,
  restoreDesktopApi,
  SessionsViewTestProviders,
  sessionsViewHookMocks,
} from "./fixtures/sessions-view-render-fixture";

const IDS = ["artifact-a", "artifact-b"];
const TAG = { id: "tag-a", name: "backend", color: TagColor.Blue };
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
  sessionsViewHookMocks().useSharedDateRange.mockReturnValue({
    dateRange: DateRange.AllTime,
    setDateRange: vi.fn(),
  });
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
  restoreWidth = stubContainerWidthPx(1440);
});

afterEach(() => {
  cleanup();
  restoreDesktopApi();
  restoreWidth?.();
  restoreWidth = undefined;
});

describe("Desktop tag UI → renderer adapter → main handler (DT-T02-T04)", () => {
  it("offers each row's tag editor while real GET and bulk POST cross the existing IPC boundary", async () => {
    const calls: { path: string; method: string; body: string | null }[] = [];
    const main = createHarness({
      fetchImpl: (url, init) => {
        calls.push({
          path: url.pathname,
          method: init.method ?? "GET",
          body: typeof init.body === "string" ? init.body : null,
        });
        const data =
          url.pathname === "/tags"
            ? [TAG]
            : { results: IDS.map(batchItemApplied) };
        return Promise.resolve(
          new Response(JSON.stringify({ success: true, data }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        );
      },
    });
    installDesktopApiStub({
      cloudApiFetch: main.invoke,
      getLocalSessionSourceStatus: vi.fn().mockResolvedValue({
        localSessionSourceStatus: LOCAL_SESSION_SOURCE_STATUSES.ready,
      }),
      onDbChanged: () => () => undefined,
    });
    if (!window.desktopApi) {
      throw new Error("Desktop fixture did not install its bridge");
    }
    const adapter = createDesktopCloudApiAdapter(window.desktopApi);
    const { SessionsView } = await import("../SessionsView");
    const { container } = render(
      <SessionsViewTestProviders>
        <ApiAdapterProvider adapter={adapter}>
          <SessionsView />
        </ApiAdapterProvider>
      </SessionsViewTestProviders>
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getAllByText(TAG.name)).toHaveLength(2);
    // ISS-12455 wired the editable per-row cell into cloud mode; bulk
    // tagging sits beside it rather than replacing it.
    expect(
      container.querySelectorAll('[aria-label^="Edit tags for"]')
    ).toHaveLength(IDS.length);
    const first = container.querySelector<HTMLElement>(
      `[data-grid-row-id="${IDS[0]}"]`
    );
    const second = container.querySelector<HTMLElement>(
      `[data-grid-row-id="${IDS[1]}"]`
    );
    if (!(first && second)) {
      throw new Error("Missing cloud-artifact row projection");
    }
    fireEvent.click(first);
    fireEvent.click(second, { ctrlKey: true });
    fireEvent.click(
      screen.getByRole("button", { name: BULK_TAG_ACTION_LABEL })
    );
    fireEvent.click(await screen.findByRole("button", { name: TAG.name }));
    // The picker closes and the selection stays (operator ruling on the
    // ISS-12305 review, Asana precedent).
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: TAG.name })).toBeNull()
    );
    expect(screen.getByRole("toolbar").isConnected).toBe(true);
    expect(
      calls.some((call) => call.method === "GET" && call.path === "/tags")
    ).toBe(true);
    const writes = calls.filter((call) => call.method !== "GET");
    expect(writes).toEqual([
      {
        path: `${BatchMutationRoute.EntityTags}/v2`,
        method: "POST",
        body: JSON.stringify({
          tagId: TAG.id,
          entityType: TagEntityType.Artifact,
          entityIds: IDS,
        }),
      },
    ]);

    for (const { request, expectedReason } of [
      {
        request: { path: "/entity-tags", method: "POST", body: "{}" },
        expectedReason: `cloud-api-fetch: POST /entity-tags admits entityType ${TagEntityType.Artifact} and nothing else`,
      },
      {
        request: {
          path: "/entity-tags?tagId=tag-a&entityId=artifact-a",
          method: "DELETE",
        },
        expectedReason: `cloud-api-fetch: DELETE /entity-tags admits entityType ${TagEntityType.Artifact} and nothing else`,
      },
    ]) {
      const denied = await main.invoke(request);
      expect(denied.kind).toBe("network-error");
      if (denied.kind !== "network-error") {
        throw new Error("Unsupported write was admitted");
      }
      expect(denied.message).toBe(expectedReason);
    }
    expect(calls.filter((call) => call.method !== "GET")).toEqual(writes);
  });
});

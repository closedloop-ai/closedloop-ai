import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import {
  BATCH_ITEM_FAILURE_MESSAGE,
  BatchItemFailureCode,
} from "@repo/api/src/types/batch-mutation-result";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import { SESSIONS_ARTIFACT_TAGS_FLAG_KEY } from "@repo/api/src/types/sessions-artifact-tags-flag";
import { TagEntityType } from "@repo/api/src/types/tag";
import { SESSIONS_NOUN } from "@repo/app/agents/lib/sessions-noun";
import { artifactStatusFullLabel } from "@repo/app/shared/components/artifact-status/artifact-status-presentation";
import { selectionSentence } from "@repo/app/shared/components/generic-artifact-surface/bulk-action-bar";
import { sessionStatusView } from "@repo/app/shared/lib/artifact-status-adapter";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import {
  BULK_REMOVE_TAG_ACTION_LABEL,
  BULK_TAG_ACTION_LABEL,
} from "@repo/app/tags/lib/bulk-tag-labels";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import {
  GRID_TABLE_PAGINATION_BAND_TEST_ID,
  GRID_TABLE_SCROLL_BAND_TEST_ID,
} from "@repo/design-system/components/ui/grid-table-list-surface";
import { GRID_TABLE_V2_NARROW_LEADING_LABEL } from "@repo/design-system/components/ui/grid-table-v2";
import type { Meta, StoryObj } from "@storybook/react";
import { act } from "react";
import {
  expect,
  fireEvent,
  screen,
  userEvent,
  waitFor,
  within,
} from "storybook/test";
import SessionsPage from "@/app/(authenticated)/[orgSlug]/sessions/page";
import {
  addFixtureTag,
  bulkTagFixtureTag,
  bulkTaggedIds,
  bulkTagRoutes,
  bulkTagWrites,
  deselectListRow,
  expectListRowTagMembership,
  removeFixtureTag,
  resetBulkTagFixture,
  retryFixtureTag,
  selectListRows,
  withBulkTagState,
} from "./fixtures/bulk-tag-fixtures";
import { sessionListResponse } from "./fixtures/live-app-fixtures";
import {
  sessionsListApiRoutes,
  sessionsListRowsFixture,
  sessionsUsageEmptyFixture,
} from "./fixtures/sessions-list-fixtures";
import { LivePage } from "./live-page";
import {
  expectActiveNavItem,
  LIVE_ORG_SLUG,
  narrowStoryViewport,
  withLiveRoute,
} from "./live-route";

// ISS-11361 Target sidebar, entry 2 of 62: Sessions List (Artifact list).
// The live route's own page (`apps/app/.../sessions/page.tsx`, which mounts
// `SessionsV2Page` → `SessionsListV2Host`) in the app frame, so the header,
// date-range toolbar, filters, summary strip, table and footer are the live
// ones. Each story is one state the live page reaches from its two reads
// (`/agent-sessions`, `/agent-sessions/usage`) or from its URL.

const SESSIONS_PATH = `/${LIVE_ORG_SLUG}/sessions`;

/** `sessionsListApiRoutes` with some reads answered differently. */
function withRoutes(overrides: FixtureRoute[]): FixtureRoute[] {
  return [...overrides, ...sessionsListApiRoutes];
}

function failing(path: string): FixtureRoute {
  return { method: "GET", path, respond: () => null, status: 500 };
}

function pending(path: string): FixtureRoute {
  return { method: "GET", path, respond: () => new Promise(() => undefined) };
}

function listOf(rows: typeof sessionsListRowsFixture): FixtureRoute {
  return {
    method: "GET",
    path: "/agent-sessions",
    respond: () => ({
      ...sessionListResponse(rows),
      viewerScope: AgentSessionViewerScope.Organization,
    }),
  };
}

const emptyUsage: FixtureRoute = {
  method: "GET",
  path: "/agent-sessions/usage",
  respond: () => sessionsUsageEmptyFixture,
};

function connectedAgent(hasConnectedAgent: boolean): FixtureRoute {
  return {
    method: "GET",
    path: "/compute-targets/has-connected-agent",
    respond: () => ({ hasConnectedAgent }),
  };
}

/** The first two sessions on the page: the selection the Add Tag stories make. */
const SELECTED_SESSION_IDS = sessionsListRowsFixture
  .slice(0, 2)
  .map((item) => item.id);
const ACTIVE_STATUS_PATTERN = new RegExp(
  SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE]
);
const NO_SELECTION = "No sessions selected";
const ONE_SESSION_SELECTED = selectionSentence(1, SESSIONS_NOUN);
const TWO_SESSIONS_SELECTED = selectionSentence(2, SESSIONS_NOUN);
const NEXT_PAGE = "Go to next page";
const PREVIOUS_PAGE = "Go to previous page";
const FAVORITE_SESSIONS = "Favorite sessions";
const PARTIAL_FAVORITE_RECEIPT =
  "Added to favorites for 1 of 2 sessions. 1 failed.";
const FIRST_PAGE_NAME = sessionsListRowsFixture[0]?.name;
const SECOND_PAGE_NAME = sessionsListRowsFixture[2]?.name;
const SECOND_PAGE_SESSION_ID = sessionsListRowsFixture[2]?.id;
if (!(FIRST_PAGE_NAME && SECOND_PAGE_NAME && SECOND_PAGE_SESSION_ID)) {
  throw new Error("Expected named Sessions pagination fixtures");
}

type DeferredFavoriteWrite = {
  promise: Promise<unknown>;
  reject: (reason?: unknown) => void;
  resolve: (value: unknown) => void;
};

let favoriteWrites: DeferredFavoriteWrite[] = [];

/** Every session can take a tag, and the list reflects the tags written. */
const ADD_TAG_PARAMETERS = {
  appCore: {
    apiRoutes: withRoutes([
      ...bulkTagRoutes,
      {
        method: "GET",
        path: "/agent-sessions",
        respond: () =>
          sessionListResponse(
            sessionsListRowsFixture.map((item) =>
              withBulkTagState(item, item.id)
            )
          ),
      },
    ]),
    enabledFlags: [SESSIONS_ARTIFACT_TAGS_FLAG_KEY],
  },
};

// Surface controls stay disabled because each state is a fixture-driven live page.
const GROUP_COLLAPSE_PARAMETERS = {
  appCore: {
    apiRoutes: withRoutes([
      ...bulkTagRoutes,
      listOf(
        sessionsListRowsFixture
          .slice(0, 2)
          .map((item) => withBulkTagState(item, item.id))
      ),
    ]),
    enabledFlags: [SESSIONS_ARTIFACT_TAGS_FLAG_KEY],
  },
};

const meta = {
  title: "Surfaces/Artifacts/Sessions/Sessions List",
  tags: ["stable"],
  decorators: [withLiveRoute],
  render: () => (
    <LivePage activePath="/sessions">
      <SessionsPage />
    </LivePage>
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    liveRoute: { path: SESSIONS_PATH },
    appCore: { apiRoutes: sessionsListApiRoutes },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const [firstRow] = sessionsListRowsFixture;
    if (!firstRow) {
      throw new Error("The narrow Sessions story needs one fixture row");
    }
    await expect(
      await canvas.findByText(firstRow.name ?? "", {}, { timeout: 10_000 })
    ).toBeVisible();
    await expect(document.documentElement).not.toHaveClass("dark");
    await expect(
      canvas.getByRole("heading", { name: "Sessions" })
    ).toBeVisible();
    await expect(
      canvas.getByRole("link", { name: firstRow?.name })
    ).toBeVisible();
    await expectActiveNavItem(canvasElement, "Sessions");
    const scrollBand = canvas.getByTestId(GRID_TABLE_SCROLL_BAND_TEST_ID);
    const footer = canvas.getByTestId(GRID_TABLE_PAGINATION_BAND_TEST_ID);
    scrollBand.scrollTop = scrollBand.scrollHeight;
    fireEvent.scroll(scrollBand);
    await expect(scrollBand).toHaveClass("flex-1", "overflow-auto");
    await expect(footer.parentElement).toBe(scrollBand.parentElement);
    if (scrollBand.parentElement?.getBoundingClientRect().height) {
      await waitFor(() => {
        const bounds = footer.getBoundingClientRect();
        expect(bounds.height).toBeGreaterThan(0);
        expect(bounds.bottom).toBeLessThanOrEqual(globalThis.innerHeight);
      });
    }
  },
};

/** Both reads are still in flight. */
export const Loading: Story = {
  parameters: {
    appCore: {
      apiRoutes: withRoutes([
        pending("/agent-sessions/usage"),
        pending("/agent-sessions"),
      ]),
    },
  },
};

/** The rows are in; the summary strip's usage read is still in flight. */
export const LoadingSummary: Story = {
  parameters: {
    appCore: { apiRoutes: withRoutes([pending("/agent-sessions/usage")]) },
  },
};

/** An agent is connected, but no session has synced yet. */
export const Empty: Story = {
  parameters: {
    appCore: {
      apiRoutes: withRoutes([emptyUsage, listOf([]), connectedAgent(true)]),
    },
  },
};

/** A status filter from the URL that matches no session. */
export const NoMatches: Story = {
  parameters: {
    liveRoute: { path: `${SESSIONS_PATH}?status=${SESSION_STATUS.ERROR}` },
    appCore: {
      apiRoutes: withRoutes([emptyUsage, listOf([]), connectedAgent(true)]),
    },
  },
};

/** The session list read failed; the summary strip still loaded. */
export const ErrorState: Story = {
  name: "Error",
  parameters: {
    appCore: { apiRoutes: withRoutes([failing("/agent-sessions")]) },
  },
};

/** No session has ever synced and no agent has connected to the workspace. */
export const NotConnected: Story = {
  parameters: {
    appCore: {
      apiRoutes: withRoutes([emptyUsage, listOf([]), connectedAgent(false)]),
    },
  },
};

/** Nothing in the last 7 days, but the workspace has older sessions. */
export const NothingInRange: Story = {
  parameters: {
    appCore: {
      apiRoutes: withRoutes([
        emptyUsage,
        {
          method: "GET",
          path: "/agent-sessions",
          respond: ({ searchParams }) =>
            searchParams.has("startDate")
              ? sessionListResponse([])
              : sessionListResponse(sessionsListRowsFixture),
        },
        connectedAgent(true),
      ]),
    },
  },
};

/** The summary strip's usage read failed; the rows still loaded. */
export const SummaryUnavailable: Story = {
  parameters: {
    appCore: { apiRoutes: withRoutes([failing("/agent-sessions/usage")]) },
  },
};

/**
 * The selection's write partly failed (ISS-12305): the picker shows the error
 * and every selected session stays selected. The existing Add retry contract
 * requires narrowing the selection to the failed sessions before retrying.
 */
export const AddTagPartialFailure: Story = {
  beforeEach: () => resetBulkTagFixture(SELECTED_SESSION_IDS.slice(1)),
  parameters: ADD_TAG_PARAMETERS,
  play: async ({ canvasElement }) => {
    await selectListRows(canvasElement, SELECTED_SESSION_IDS);
    await addFixtureTag();
    await expect(
      await screen.findByText(
        BATCH_ITEM_FAILURE_MESSAGE[BatchItemFailureCode.ArtifactsNotFound]
      )
    ).toBeInTheDocument();
    await expect(
      within(canvasElement).getByRole("toolbar", {
        name: TWO_SESSIONS_SELECTED,
      })
    ).toBeInTheDocument();
  },
};

/** The URL carries a status filter; the list and strip show its matches. */
export const WithActiveFilters: Story = {
  parameters: {
    liveRoute: { path: `${SESSIONS_PATH}?status=${SESSION_STATUS.INACTIVE}` },
    appCore: {
      apiRoutes: withRoutes([
        listOf(
          sessionsListRowsFixture.filter(
            (item) => item.status === SESSION_STATUS.INACTIVE
          )
        ),
      ]),
    },
  },
};

/** Opened from a teammate's profile: `?userId=` scopes the list to them. */
export const OwnerScope: Story = {
  parameters: {
    liveRoute: { path: `${SESSIONS_PATH}?userId=user-priya` },
    appCore: {
      apiRoutes: withRoutes([
        listOf(
          sessionsListRowsFixture.filter(
            (item) => item.user?.id === "user-priya"
          )
        ),
      ]),
    },
  },
};

/** Two sessions are selected, so the rail offers both tag mutations. */
export const RowsSelected: Story = {
  beforeEach: () => resetBulkTagFixture(),
  parameters: ADD_TAG_PARAMETERS,
  play: async ({ canvasElement }) => {
    await selectListRows(canvasElement, SELECTED_SESSION_IDS);
    const rail = within(canvasElement).getByRole("toolbar", {
      name: selectionSentence(SELECTED_SESSION_IDS.length, SESSIONS_NOUN),
    });
    await expect(
      within(rail).getByRole("button", { name: BULK_TAG_ACTION_LABEL })
    ).toBeInTheDocument();
    await expect(
      within(rail).getByRole("button", { name: BULK_REMOVE_TAG_ACTION_LABEL })
    ).toBeInTheDocument();
  },
};

/** One tag is added to every selected session in a single write. */
export const AddTag: Story = {
  beforeEach: () => resetBulkTagFixture(),
  parameters: ADD_TAG_PARAMETERS,
  play: async ({ canvasElement }) => {
    await selectListRows(canvasElement, SELECTED_SESSION_IDS);
    await addFixtureTag();
    await waitFor(() => expect(bulkTagWrites()).toHaveLength(1));
    // Operator ruling on the ISS-12305 review (Asana precedent): the write
    // keeps the selection.
    await expect(
      within(canvasElement).getByRole("toolbar", {
        name: TWO_SESSIONS_SELECTED,
      })
    ).toBeInTheDocument();
    await expect(bulkTagWrites()).toEqual([
      {
        entityIds: SELECTED_SESSION_IDS,
        entityType: TagEntityType.Artifact,
        tagId: bulkTagFixtureTag.id,
      },
    ]);
  },
};

/** The selected sessions both lose their existing fixture tag. */
export const RemoveTag: Story = {
  beforeEach: () => resetBulkTagFixture([], SELECTED_SESSION_IDS),
  parameters: ADD_TAG_PARAMETERS,
  play: async ({ canvasElement }) => {
    await selectListRows(canvasElement, SELECTED_SESSION_IDS);
    await removeFixtureTag();
    await waitFor(() => expect(bulkTagWrites()).toHaveLength(1));
    for (const id of SELECTED_SESSION_IDS) {
      await expectListRowTagMembership(canvasElement, id, false);
    }
  },
};

/** One selected session loses the tag; the other is a successful no-op. */
export const RemoveTagNotPresent: Story = {
  beforeEach: () => resetBulkTagFixture([], SELECTED_SESSION_IDS.slice(0, 1)),
  parameters: ADD_TAG_PARAMETERS,
  play: async ({ canvasElement }) => {
    await selectListRows(canvasElement, SELECTED_SESSION_IDS);
    await removeFixtureTag();
    await waitFor(() => expect(bulkTagWrites()).toHaveLength(1));
    for (const id of SELECTED_SESSION_IDS) {
      await expectListRowTagMembership(canvasElement, id, false);
    }
  },
};

/** One removal fails and remains available for the existing retry flow. */
export const RemoveTagPartialFailure: Story = {
  beforeEach: () =>
    resetBulkTagFixture(SELECTED_SESSION_IDS.slice(1), SELECTED_SESSION_IDS),
  // No hang: a deliberate ~15-step remove, partial-failure and retry play
  // (#8956, ISS-10686) that took 5280ms (Sessions) and 5309ms (Branches) in CI.
  // 10s is about 2x that; every other story keeps the sweep's 5s default.
  parameters: { ...ADD_TAG_PARAMETERS, storySweep: { timeoutMs: 10_000 } },
  play: async ({ canvasElement }) => {
    await showSessionTagsColumn(canvasElement);
    for (const id of SELECTED_SESSION_IDS) {
      await expectListRowTagMembership(canvasElement, id, true);
    }
    await selectListRows(canvasElement, SELECTED_SESSION_IDS);
    await removeFixtureTag();
    await expect(
      await screen.findByText(
        BATCH_ITEM_FAILURE_MESSAGE[BatchItemFailureCode.ArtifactsNotFound]
      )
    ).toBeInTheDocument();
    await waitFor(() => expect(bulkTagWrites()).toHaveLength(1));
    await expect(bulkTaggedIds()).toEqual([SELECTED_SESSION_IDS[1]]);
    await expectListRowTagMembership(
      canvasElement,
      SELECTED_SESSION_IDS[0] ?? "",
      false
    );
    await expectListRowTagMembership(
      canvasElement,
      SELECTED_SESSION_IDS[1] ?? "",
      true
    );
    await expect(
      within(canvasElement).getByRole("toolbar", {
        name: selectionSentence(SELECTED_SESSION_IDS.length, SESSIONS_NOUN),
      })
    ).toBeInTheDocument();
    await deselectListRow(canvasElement, SELECTED_SESSION_IDS[0] ?? "");
    await expect(
      within(canvasElement).getByRole("toolbar", {
        name: selectionSentence(1, SESSIONS_NOUN),
      })
    ).toBeInTheDocument();
    await retryFixtureTag();
    await waitFor(() => expect(bulkTagWrites()).toHaveLength(2));
    await expect(bulkTagWrites()[1]?.entityIds).toEqual([
      SELECTED_SESSION_IDS[1],
    ]);
    await expectListRowTagMembership(
      canvasElement,
      SELECTED_SESSION_IDS[1] ?? "",
      false
    );
    await expect(
      within(canvasElement).queryByRole("toolbar", {
        name: selectionSentence(1, SESSIONS_NOUN),
      })
    ).toBeNull();
    await expect(
      screen.queryByText(
        BATCH_ITEM_FAILURE_MESSAGE[BatchItemFailureCode.ArtifactsNotFound]
      )
    ).toBeNull();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  },
};

async function showSessionTagsColumn(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "Options" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Tags" }));
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(canvas.getByRole("columnheader", { name: "Tags" })).toBeVisible()
  );
}

export const GroupCollapseReconcilesSelection: Story = {
  beforeEach: () => resetBulkTagFixture(),
  parameters: GROUP_COLLAPSE_PARAMETERS,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Status column options" })
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Group" }));
    await selectStoryRows(canvasElement, SELECTED_SESSION_IDS);
    const activeToggle = canvas.getByRole("button", {
      name: ACTIVE_STATUS_PATTERN,
    });
    await userEvent.click(activeToggle);
    await expect(selectionStatus(canvasElement)).toHaveTextContent(
      ONE_SESSION_SELECTED
    );
    await userEvent.click(activeToggle);

    await expect(
      sessionRow(canvasElement, SELECTED_SESSION_IDS[0]!)
    ).toHaveAttribute("aria-selected", "false");
    await expect(
      sessionRow(canvasElement, SELECTED_SESSION_IDS[1]!)
    ).toHaveAttribute("aria-selected", "true");
  },
};

export const PendingFavoriteAfterPageChange: Story = {
  beforeEach: () => {
    favoriteWrites = [];
  },
  parameters: {
    appCore: {
      apiRoutes: withRoutes([
        pagedSessionsRoute(),
        {
          method: "POST",
          path: "/artifacts/*",
          respond: () => {
            const pending = deferredFavoriteWrite();
            favoriteWrites.push(pending);
            return pending.promise;
          },
        },
      ]),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await selectListRows(canvasElement, SELECTED_SESSION_IDS);
    await userEvent.click(
      await screen.findByRole("button", { name: FAVORITE_SESSIONS })
    );
    await waitFor(() => expect(favoriteWrites).toHaveLength(2));

    await userEvent.click(canvas.getByLabelText(NEXT_PAGE));
    await expect(await canvas.findByText(SECOND_PAGE_NAME)).toBeVisible();
    await fireEvent.click(sessionRow(canvasElement, SECOND_PAGE_SESSION_ID));
    await expect(selectionStatus(canvasElement)).toHaveTextContent(
      ONE_SESSION_SELECTED
    );
    await act(async () => {
      favoriteWrites[0]!.resolve({});
      favoriteWrites[1]!.reject(new Error("fixture partial failure"));
      await Promise.allSettled(favoriteWrites.map(({ promise }) => promise));
    });
    await expect(
      await screen.findByText(PARTIAL_FAVORITE_RECEIPT)
    ).toBeInTheDocument();
    await expect(
      sessionRow(canvasElement, SECOND_PAGE_SESSION_ID)
    ).toHaveAttribute("aria-selected", "true");
    await expect(selectionStatus(canvasElement)).toHaveTextContent(
      ONE_SESSION_SELECTED
    );
    await expect(canvas.queryByRole("toolbar")).not.toBeInTheDocument();
    await expect(
      canvas.queryByRole("button", { name: FAVORITE_SESSIONS })
    ).not.toBeInTheDocument();

    await userEvent.click(canvas.getByLabelText(PREVIOUS_PAGE));
    await expect(await canvas.findByText(FIRST_PAGE_NAME)).toBeVisible();
    await expect(
      sessionRow(canvasElement, SELECTED_SESSION_IDS[0]!)
    ).toHaveAttribute("aria-selected", "false");
    await expect(
      sessionRow(canvasElement, SELECTED_SESSION_IDS[1]!)
    ).toHaveAttribute("aria-selected", "false");
    await expect(canvas.queryByRole("toolbar")).not.toBeInTheDocument();
    await expect(
      canvas.queryByRole("button", { name: FAVORITE_SESSIONS })
    ).not.toBeInTheDocument();
  },
};

/** Pointer and keyboard interaction keep the session lead cell reachable. */
export const HoverAndKeyboardFocus: Story = {
  beforeEach: () =>
    import.meta.env.MODE === "test" ? stubContainerWidthPx(1280) : undefined,
  parameters: {
    appCore: {
      apiRoutes: sessionsListApiRoutes,
      enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const sessionName = sessionsListRowsFixture[0]?.name;
    const link = await canvas.findByRole("link", {
      name: sessionName,
    });
    await userEvent.hover(link);
    const settledLink = await canvas.findByRole("link", {
      name: sessionsListRowsFixture[0]?.name,
    });
    const row = settledLink.closest<HTMLElement>('[role="row"]');
    if (!row) {
      throw new Error("The Sessions grid row must own its session link");
    }
    const leadCell = settledLink.closest<HTMLElement>('[role="gridcell"]');
    if (!leadCell) {
      throw new Error("The Sessions grid lead cell must own its session link");
    }
    act(() => {
      leadCell.focus();
    });
    await userEvent.tab({ shift: true });
    await userEvent.tab();
    await expect(leadCell).toHaveFocus();
  },
};

/** The production page in the dark theme. */
export const Dark: Story = {
  globals: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(document.documentElement).toHaveClass("dark");
    await expect(
      within(canvasElement).getByRole("heading", { name: "Sessions" })
    ).toBeVisible();
    await expect(
      await within(canvasElement).findByRole("link", {
        name: sessionsListRowsFixture[0]?.name,
      })
    ).toBeVisible();
  },
};

/** The flag-on phone projection keeps the canonical status and row identity. */
export const Narrow: Story = {
  beforeEach: narrowStoryViewport,
  globals: { viewport: { value: "mobile1" } },
  parameters: {
    appCore: {
      apiRoutes: sessionsListApiRoutes,
      enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const [firstRow] = sessionsListRowsFixture;
    if (!firstRow) {
      throw new Error("The narrow Sessions story needs one fixture row");
    }
    const firstName = await canvas.findByText(
      firstRow.name,
      {},
      {
        timeout: 10_000,
      }
    );
    const firstGridRow = firstName.closest('[role="row"]');
    if (!firstGridRow) {
      throw new Error("The narrow Sessions row must own its session name");
    }
    await expect(canvas.getAllByRole("columnheader")).toHaveLength(1);
    await expect(canvas.getByRole("columnheader")).toHaveTextContent(
      GRID_TABLE_V2_NARROW_LEADING_LABEL
    );
    await expect(
      within(firstGridRow).getByRole("img", {
        name: artifactStatusFullLabel(
          sessionStatusView(firstRow.id, firstRow.status, firstRow.rawStatus)
        ),
      })
    ).toBeVisible();
  },
};

/** The production page falls back to cards without wide-grid chrome. */
export const NarrowCardFallback: Story = {
  globals: { viewport: { value: "390-844" } },
  beforeEach: () =>
    import.meta.env.MODE === "test" ? stubContainerWidthPx(390) : undefined,
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      expect(
        canvasElement.querySelectorAll("[data-grid-card-id]").length
      ).toBeGreaterThan(0);
    });
    await expect(within(canvasElement).queryByRole("grid")).toBeNull();
    await expect(
      canvasElement.querySelector('[data-grid-row-id="__grid-chrome__header"]')
    ).toBeNull();
  },
};

function pagedSessionsRoute(): FixtureRoute {
  return {
    method: "GET",
    path: "/agent-sessions",
    respond: ({ searchParams }) => {
      const offset = Number(searchParams.get("offset") ?? 0);
      const items =
        offset === 0
          ? sessionsListRowsFixture.slice(0, 2)
          : sessionsListRowsFixture.slice(2, 4);
      return {
        ...sessionListResponse(items),
        total: 26,
        viewerScope: AgentSessionViewerScope.Organization,
      };
    },
  };
}

function sessionRow(canvasElement: HTMLElement, id: string): HTMLElement {
  const row = canvasElement.querySelector<HTMLElement>(
    `[data-grid-row-id="${id}"]`
  );
  if (!row) {
    throw new Error(`Expected session row ${id}`);
  }
  return row;
}

async function selectStoryRows(
  canvasElement: HTMLElement,
  rowIds: readonly string[]
): Promise<void> {
  for (const [index, id] of rowIds.entries()) {
    const row = await waitFor(() => sessionRow(canvasElement, id), {
      timeout: 2000,
    });
    await fireEvent.click(row, {
      ctrlKey: index > 0,
    });
  }
  await waitFor(() =>
    expect(selectionStatus(canvasElement)).toHaveTextContent(
      TWO_SESSIONS_SELECTED
    )
  );
}

function selectionStatus(canvasElement: HTMLElement): HTMLElement {
  const status = canvasElement.querySelector<HTMLElement>("output[aria-live]");
  if (!status) {
    throw new Error("Expected the sessions selection status");
  }
  return status;
}

function deferredFavoriteWrite(): DeferredFavoriteWrite {
  let resolve: (value: unknown) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

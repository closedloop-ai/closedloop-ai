import { ArtifactStatusVocabulary } from "@repo/api/src/types/artifact-status-contract";
import {
  BATCH_ITEM_FAILURE_MESSAGE,
  BatchItemFailureCode,
} from "@repo/api/src/types/batch-mutation-result";
import { BranchStatus } from "@repo/api/src/types/branch";
import {
  type BranchListMetricValue,
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import {
  ArtifactTagAvailability,
  TagEntityType,
} from "@repo/api/src/types/tag";
import { APPROVED_BRANCH_COLUMN_SPECS } from "@repo/app/branches/components/approved-branches-grid-adapter";
import {
  makeBranchAnalytics,
  makeBranchListMetrics,
} from "@repo/app/branches/components/branch-analytics-fixtures";
import {
  BranchesListSurfaceV2Preview,
  type BranchesListSurfaceV2PreviewSummaryState,
  BranchesListSurfaceV2PreviewSummaryState as PreviewSummaryState,
} from "@repo/app/branches/components/branches-list-surface-v2-demo";
import {
  BRANCH_NAME_COLUMN_ID,
  branchColumnLabel,
} from "@repo/app/branches/lib/branch-column-view-model";
import { branchStatusEvidence } from "@repo/app/branches/lib/branch-row";
import { BRANCH_SAMPLE_ROWS } from "@repo/app/branches/lib/branch-sample-data";
import { BRANCHES_NOUN } from "@repo/app/branches/lib/branches-noun";
import { artifactStatusFullLabel } from "@repo/app/shared/components/artifact-status/artifact-status-presentation";
import { selectionSentence } from "@repo/app/shared/components/generic-artifact-surface/bulk-action-bar";
import { artifactColumnDefinitions } from "@repo/app/shared/components/generic-artifact-surface/fixtures";
import { LIST_TOOLBAR_FILTER_LABEL } from "@repo/app/shared/components/list-toolbar-copy";
import { artifactStatusView } from "@repo/app/shared/lib/artifact-status-adapter";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { PRODUCT_GRID_FAVORITE_COLUMN_LABEL } from "@repo/app/shared/lib/product-grid-favorites";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import { getByRoleInOwnParent } from "@repo/app/shared/storybook/scoped-role-query";
import {
  BULK_REMOVE_TAG_ACTION_LABEL,
  BULK_TAG_ACTION_LABEL,
} from "@repo/app/tags/lib/bulk-tag-labels";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import {
  ROW_ACTIONS_COLUMN,
  ROW_ACTIONS_COLUMN_ID,
} from "@repo/design-system/components/ui/grid-table";
import {
  GRID_TABLE_PAGINATION_BAND_TEST_ID,
  GRID_TABLE_SCROLL_BAND_TEST_ID,
} from "@repo/design-system/components/ui/grid-table-list-surface";
import { GRID_TABLE_V2_NARROW_LEADING_LABEL } from "@repo/design-system/components/ui/grid-table-v2";
import type { Meta, StoryObj } from "@storybook/react";
import {
  expect,
  fireEvent,
  screen,
  userEvent,
  waitFor,
  within,
} from "storybook/test";
import BranchesPage from "@/app/(authenticated)/[orgSlug]/branches/page";
import {
  branchesEmptyAnalytics,
  branchesListApiRoutes,
  branchesListRoutes,
  branchesListRowsFixture,
  branchListResponse,
} from "./fixtures/branches-list-fixtures";
import {
  addFixtureTag,
  bulkTagFixtureTag,
  bulkTaggedIds,
  bulkTagRoutes,
  bulkTagWrites,
  deselectListRow,
  expectListRowTagMembership,
  failNextBulkTagWrite,
  removeFixtureTag,
  resetBulkTagFixture,
  retryFixtureTag,
  selectListRows,
  withBulkTagState,
} from "./fixtures/bulk-tag-fixtures";
import { LivePage } from "./live-page";
import {
  expectActiveNavItem,
  LIVE_ORG_SLUG,
  narrowStoryViewport,
  withLiveRoute,
} from "./live-route";

// ISS-11361 Target sidebar, entry 4 of 62: Branches List (Artifact list).
// The live route's own page (`apps/app/.../branches/page.tsx`, which mounts
// `BranchesListSurfaceV2`) in the app frame, so the header, toolbar, summary
// band, table and footer are the live ones. Each story is one state the live
// page reaches from its reads (`/branches`, `/branches/analytics`) or its URL.
//
// ISS-9392 state matrix:
// - default: Default; hover and focus-visible: HoverAndKeyboardFocus.
// - selected: RowsSelected; editing: AddTag; loading: Loading; empty: Empty.
// - partial: PreviewAdapterPartial; error: Unavailable and SummaryUnavailable.
// - disabled: DisabledPullRequestAction; read-only: ReadOnlyTags; permission:
//   TagPermissionDenied.
// - narrow: PreviewAdapterNarrow; overflow: Overflow; light: Default; dark: Dark.
// - dragging and drag-over are owned by the composed Table Grid Header V2
//   Handles story; this surface consumes that mastered header unchanged.
// Every named state is collected for visual regression. Interaction stories
// run Storybook's accessibility instrumentation, with pointer and keyboard
// paths both exercised below.

const BRANCHES_PATH = `/${LIVE_ORG_SLUG}/branches`;
const LOADING_VALUE_RE = /^Loading/;
const MERGED_STATUS_RE = /Merged/;
const STATUS_FILTER_RE = /^Status/;
const PARTIAL_METRIC_VALUE_RE = /\*$/;
const BRANCHES_ROLLOUT_FLAGS = [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY] as const;

/** `branchesListApiRoutes` with some reads answered differently. */
function withRoutes(overrides: FixtureRoute[]): FixtureRoute[] {
  return [...overrides, ...branchesListApiRoutes];
}

function failing(path: string): FixtureRoute {
  return { method: "GET", path, respond: () => null, status: 500 };
}

function pending(path: string): FixtureRoute {
  return { method: "GET", path, respond: () => new Promise(() => undefined) };
}

/** A branch's cloud artifact, the identity a tag is written to. */
function branchArtifactId(branchId: string): string {
  return `artifact-${branchId}`;
}

/** The first two branches on the page: the selection the Add Tag stories make. */
const SELECTED_BRANCH_IDS = branchesListRowsFixture
  .slice(0, 2)
  .map((row) => row.id);

/** Every branch can take a tag, and the list reflects the tags written. */
const ADD_TAG_PARAMETERS = {
  appCore: {
    apiRoutes: withRoutes([
      ...bulkTagRoutes,
      {
        method: "GET",
        path: "/branches",
        respond: () =>
          branchListResponse(
            branchesListRowsFixture.map((row) => {
              const artifactId = branchArtifactId(row.id);
              return withBulkTagState({ ...row, artifactId }, artifactId);
            })
          ),
      },
    ]),
  },
};

// Surface controls stay disabled because each state is a fixture-driven live page.
const meta = {
  title: "Surfaces/Artifacts/Branches/Branches List",
  tags: ["stable"],
  decorators: [withLiveRoute],
  render: () => (
    <LivePage activePath="/branches">
      <BranchesPage />
    </LivePage>
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    liveRoute: { path: BRANCHES_PATH },
    appCore: {
      apiRoutes: branchesListApiRoutes,
      enabledFlags: BRANCHES_ROLLOUT_FLAGS,
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * ISS-12117 §2 (from ISS-11364): the Branches list carries branch-specific
 * columns, not the generic artifact set. The rendered headers must be exactly
 * the production column set (`APPROVED_BRANCH_COLUMN_SPECS`, after the lead
 * Name column) under its production labels, so a new or unlabelled column
 * shows up here; and none of them may be a generic artifact column a branch has
 * no value for (`artifactColumnDefinitions`): a branch is not versioned, not
 * produced by one model, its comments live on its pull request, and "Last
 * active" replaces the generic "Updated".
 */
const GENERIC_ONLY_COLUMN_IDS: readonly string[] = [
  "comments",
  "updated",
  "currentVersion",
  "model",
  "creationCost",
];

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const [firstRow] = branchesListRowsFixture;
    if (!firstRow) {
      throw new Error("The narrow Branches story needs one fixture row");
    }
    await expect(
      (await canvas.findAllByText(firstRow.branchName, {}, { timeout: 10_000 }))
        .length
    ).toBeGreaterThan(0);
    const leadHeader = getByRoleInOwnParent(
      canvasElement,
      "columnheader",
      branchColumnLabel(BRANCH_NAME_COLUMN_ID)
    );
    const headers = within(
      leadHeader.parentElement ?? canvasElement
    ).getAllByRole("columnheader");
    await expect(
      headers.map((header) => header.textContent?.trim() ?? "")
    ).toEqual([
      // ISS-12918: Branches inherits the shared far-left star column.
      PRODUCT_GRID_FAVORITE_COLUMN_LABEL,
      branchColumnLabel(BRANCH_NAME_COLUMN_ID),
      ...APPROVED_BRANCH_COLUMN_SPECS.map((spec) => spec.label),
      ROW_ACTIONS_COLUMN.label,
    ]);
    await expect(headers.at(-1)).toHaveAttribute(
      "aria-label",
      ROW_ACTIONS_COLUMN.ariaLabel
    );
    const genericIds = artifactColumnDefinitions.map((column) => column.id);
    for (const id of GENERIC_ONLY_COLUMN_IDS) {
      await expect(genericIds).toContain(id);
    }
    const renderedIds = [
      ...APPROVED_BRANCH_COLUMN_SPECS.map((spec) => spec.id),
      ...headers.map((header) => header.dataset.columnId ?? ""),
    ];
    await expect(renderedIds).toContain(ROW_ACTIONS_COLUMN_ID);
    for (const id of GENERIC_ONLY_COLUMN_IDS) {
      await expect(renderedIds).not.toContain(id);
    }
    const branchNavLink = getByRoleInOwnParent(
      canvasElement,
      "link",
      "Branches"
    );
    await expectActiveNavItem(
      branchNavLink.parentElement ?? canvasElement,
      "Branches"
    );
    await expectBoundedBranchesFooter(canvasElement);
  },
};

/** The branch and summary reads are still in flight. */
export const Loading: Story = {
  parameters: {
    appCore: {
      apiRoutes: withRoutes([
        pending("/branches/analytics"),
        pending("/branches"),
      ]),
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByText("Loading branches…")
    ).toBeVisible();
  },
};

/** No branch has activity in the workspace yet. */
export const Empty: Story = {
  parameters: {
    appCore: { apiRoutes: branchesListRoutes([], branchesEmptyAnalytics) },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("No matching branches")).toBeVisible();
    await userEvent.click(canvas.getByRole("radio", { name: "All time" }));
    await expect(await canvas.findByText("No branches yet")).toBeVisible();
    await expect(canvas.queryByText("No matching branches")).toBeNull();
  },
};

/** A status filter from the URL that matches no branch. */
export const NoMatches: Story = {
  parameters: {
    liveRoute: { path: `${BRANCHES_PATH}?status=${BranchStatus.Closed}` },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("No matching branches")).toBeVisible();
    await expect(canvas.queryByText("No branches yet")).toBeNull();
    await expect(
      canvas.getByRole("button", { name: LIST_TOOLBAR_FILTER_LABEL })
    ).toHaveTextContent(`${LIST_TOOLBAR_FILTER_LABEL}1`);
    await expect(
      canvas.getByRole("button", { name: "Clear filters" })
    ).toBeVisible();
    const activeCard = canvas.getByText("Active branches").closest("div")
      ?.parentElement?.parentElement;
    await waitFor(() => expect(activeCard).toHaveTextContent("No data"));
  },
};

/** The branch list read failed. */
export const Unavailable: Story = {
  parameters: {
    appCore: {
      apiRoutes: withRoutes([
        failing("/branches/analytics"),
        failing("/branches"),
      ]),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText("Couldn't load branches")
    ).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Retry" })).toBeEnabled();
  },
};

/** Pointer hover and keyboard focus-visible on the production branch lead. */
export const HoverAndKeyboardFocus: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const branch = await canvas.findByRole("link", {
      name: branchesListRowsFixture[0]?.branchName,
    });
    await userEvent.hover(branch);
    const row = branch.closest('[role="row"]');
    if (!row) {
      throw new Error("The branch link must render inside its data row");
    }
    branch.focus();
    await userEvent.tab({ shift: true });
    await userEvent.tab();
    await expect(branch).toHaveFocus();
  },
};

/** The production list in the dark theme. */
export const Dark: Story = {
  globals: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(document.documentElement).toHaveClass("dark");
    await expect(
      within(canvasElement).getByRole("heading", { name: "Branches" })
    ).toBeVisible();
  },
};

/** The flag-on phone projection keeps the canonical status and row identity. */
export const Narrow: Story = {
  beforeEach: narrowStoryViewport,
  globals: { viewport: { value: "mobile1" } },
  parameters: {
    appCore: {
      apiRoutes: branchesListApiRoutes,
      enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const [firstRow] = branchesListRowsFixture;
    if (!firstRow) {
      throw new Error("The narrow Branches story needs one fixture row");
    }
    const [firstName] = await canvas.findAllByText(
      firstRow.branchName,
      {},
      { timeout: 10_000 }
    );
    const firstGridRow = firstName?.closest<HTMLElement>('[role="row"]');
    if (!firstGridRow) {
      throw new Error("The narrow Branches row must own its branch name");
    }
    await expect(canvas.getAllByRole("columnheader")).toHaveLength(1);
    await expect(canvas.getByRole("columnheader")).toHaveTextContent(
      GRID_TABLE_V2_NARROW_LEADING_LABEL
    );
    await expect(
      within(firstGridRow).getByRole("img", {
        name: artifactStatusFullLabel(
          artifactStatusView(
            firstRow.artifactId ?? firstRow.id,
            ArtifactStatusVocabulary.Branch,
            branchStatusEvidence(firstRow)
          )
        ),
      })
    ).toBeVisible();
    await userEvent.click(
      within(firstGridRow).getByRole("button", { name: "Branch actions" })
    );
    await expect(
      await screen.findByRole("menuitem", { name: "Copy branch name" })
    ).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      expect(
        screen.queryByRole("menuitem", { name: "Copy branch name" })
      ).toBeNull();
    });
    await expect(canvas.getByRole("grid")).toBeVisible();
  },
};

/** The rows loaded; the summary analytics read failed. */
export const SummaryUnavailable: Story = {
  parameters: {
    appCore: { apiRoutes: withRoutes([failing("/branches/analytics")]) },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      (await canvas.findAllByText(branchesListRowsFixture[0]?.branchName ?? ""))
        .length
    ).toBeGreaterThan(0);
    await expect(
      (await canvas.findAllByText("Unavailable")).length
    ).toBeGreaterThan(0);
  },
};

/**
 * The selection's write partly failed (ISS-12305): the picker shows the error
 * and every selected branch stays selected. The existing Add retry contract
 * requires narrowing the selection to the failed branches before retrying.
 */
export const AddTagPartialFailure: Story = {
  beforeEach: () =>
    resetBulkTagFixture(SELECTED_BRANCH_IDS.slice(1).map(branchArtifactId)),
  parameters: ADD_TAG_PARAMETERS,
  play: async ({ canvasElement }) => {
    await selectListRows(canvasElement, SELECTED_BRANCH_IDS);
    await addFixtureTag();
    await expect(
      await screen.findByText(
        BATCH_ITEM_FAILURE_MESSAGE[BatchItemFailureCode.ArtifactsNotFound]
      )
    ).toBeInTheDocument();
    await expect(
      within(canvasElement).getByRole("toolbar", {
        name: selectionSentence(SELECTED_BRANCH_IDS.length, BRANCHES_NOUN),
      })
    ).toBeInTheDocument();
  },
};

/** The URL carries a status filter; the list shows its matches. */
export const WithActiveFilters: Story = {
  parameters: {
    liveRoute: { path: `${BRANCHES_PATH}?status=${BranchStatus.Merged}` },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const merged = branchesListRowsFixture.find(
      (row) => row.status === BranchStatus.Merged
    );
    const notMerged = branchesListRowsFixture.find(
      (row) => row.status !== BranchStatus.Merged
    );
    await expect(
      (await canvas.findAllByText(merged?.branchName ?? "")).length
    ).toBeGreaterThan(0);
    await expect(
      canvas.queryByText(notMerged?.branchName ?? "")
    ).not.toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: LIST_TOOLBAR_FILTER_LABEL })
    ).toHaveTextContent(`${LIST_TOOLBAR_FILTER_LABEL}1`);
    await expect(
      canvas.getByRole("button", { name: "Clear filters" })
    ).toBeVisible();
    const activeCard = canvas.getByText("Active branches").closest("div")
      ?.parentElement?.parentElement;
    await waitFor(() => expect(activeCard).toHaveTextContent("0"));
    await userEvent.click(
      canvas.getByRole("button", { name: LIST_TOOLBAR_FILTER_LABEL })
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: STATUS_FILTER_RE })
    );
    const mergedFilter = await screen.findByRole("menuitem", {
      name: MERGED_STATUS_RE,
    });
    await expect(within(mergedFilter).getByRole("checkbox")).toBeChecked();
  },
};

/** Two branches are selected, so the rail offers both tag mutations. */
export const RowsSelected: Story = {
  beforeEach: () => resetBulkTagFixture(),
  parameters: ADD_TAG_PARAMETERS,
  play: async ({ canvasElement }) => {
    await selectListRows(canvasElement, SELECTED_BRANCH_IDS);
    const rail = within(canvasElement).getByRole("toolbar", {
      name: selectionSentence(SELECTED_BRANCH_IDS.length, BRANCHES_NOUN),
    });
    await expect(
      within(rail).getByRole("button", { name: BULK_TAG_ACTION_LABEL })
    ).toBeInTheDocument();
    await expect(
      within(rail).getByRole("button", { name: BULK_REMOVE_TAG_ACTION_LABEL })
    ).toBeInTheDocument();
  },
};

/** One tag is added to every selected branch's artifact in a single write. */
export const AddTag: Story = {
  beforeEach: () => resetBulkTagFixture(),
  parameters: ADD_TAG_PARAMETERS,
  play: async ({ canvasElement }) => {
    await selectListRows(canvasElement, SELECTED_BRANCH_IDS);
    await addFixtureTag();
    await waitFor(() => expect(bulkTagWrites()).toHaveLength(1));
    // Operator ruling on the ISS-12305 review (Asana precedent): the write
    // keeps the selection.
    await expect(
      within(canvasElement).getByRole("toolbar", {
        name: selectionSentence(SELECTED_BRANCH_IDS.length, BRANCHES_NOUN),
      })
    ).toBeInTheDocument();
    await expect(bulkTagWrites()).toEqual([
      {
        entityIds: SELECTED_BRANCH_IDS.map(branchArtifactId),
        entityType: TagEntityType.Artifact,
        tagId: bulkTagFixtureTag.id,
      },
    ]);
  },
};

/** Tag values remain non-interactive when the source is read-only. */
export const ReadOnlyTags: Story = {
  render: () => (
    <PreviewAdapterStory
      rows={[
        {
          ...PREVIEW_STORY_ROWS[0]!,
          tagAvailability: ArtifactTagAvailability.Available,
          tagPermissions: { canApply: true, canRemove: true },
          tags: [bulkTagFixtureTag],
        },
      ]}
      summaryState={PreviewSummaryState.Complete}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tag = await canvas.findByText(bulkTagFixtureTag.name);
    tag.scrollIntoView({ block: "nearest", inline: "center" });
    await expect(tag).toBeVisible();
    expectOnScreen(tag);
    await expect(
      canvas.queryByRole("button", { name: bulkTagFixtureTag.name })
    ).not.toBeInTheDocument();
  },
};

/** Selection stays available while a denied tag capability omits Add Tag. */
export const TagPermissionDenied: Story = {
  parameters: {
    appCore: {
      apiRoutes: branchesListRoutes(
        branchesListRowsFixture.map((row) => ({
          ...row,
          artifactId: branchArtifactId(row.id),
          tagAvailability: ArtifactTagAvailability.Available,
          tagPermissions: { canApply: false, canRemove: false },
          tags: [],
        }))
      ),
    },
  },
  play: async ({ canvasElement }) => {
    await selectListRows(canvasElement, SELECTED_BRANCH_IDS);
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("toolbar", {
        name: selectionSentence(SELECTED_BRANCH_IDS.length, BRANCHES_NOUN),
      })
    ).toBeInTheDocument();
    await expect(
      canvas.queryByRole("button", { name: BULK_TAG_ACTION_LABEL })
    ).not.toBeInTheDocument();
  },
};

/** The production-bound prototype adapter using the canonical Branches list. */
export const PreviewAdapter: Story = {
  render: () => (
    <PreviewAdapterStory summaryState={PreviewSummaryState.Complete} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "Branches" })
    ).toBeVisible();
    await expect(canvas.getByRole("status")).toHaveTextContent("1–25 of 36");
    await userEvent.click(canvas.getByLabelText("Go to next page"));
    await expect(await canvas.findByText("26–36 of 36")).toBeVisible();
  },
};

/** Preview metrics retain their partial-data disclosures. */
export const PreviewAdapterPartial: Story = {
  render: () => (
    <PreviewAdapterStory summaryState={PreviewSummaryState.Partial} />
  ),
  play: async ({ canvasElement }) => {
    const values = await within(canvasElement).findAllByText(
      PARTIAL_METRIC_VALUE_RE
    );
    await expect(values.length).toBeGreaterThan(0);
  },
};

/** Preview metrics expose the canonical summary-error state. */
export const PreviewAdapterError: Story = {
  render: () => (
    <PreviewAdapterStory summaryState={PreviewSummaryState.Error} />
  ),
  play: async ({ canvasElement }) => {
    await expect(
      (await within(canvasElement).findAllByText("Unavailable")).length
    ).toBeGreaterThan(0);
  },
};

/** Preview metrics expose the canonical loading state. */
export const PreviewAdapterLoading: Story = {
  render: () => (
    <PreviewAdapterStory summaryState={PreviewSummaryState.Loading} />
  ),
  play: async ({ canvasElement }) => {
    await expect(
      (await within(canvasElement).findAllByText(LOADING_VALUE_RE)).length
    ).toBeGreaterThan(0);
  },
};

/** The preview adapter follows the canonical narrow card fallback. */
export const PreviewAdapterNarrow: Story = {
  globals: { viewport: { value: "390-844" } },
  parameters: { appCore: { enabledFlags: [] } },
  beforeEach: () => {
    const restoreViewport = narrowStoryViewport();
    const restoreContainer =
      import.meta.env.MODE === "test" ? stubContainerWidthPx(390) : undefined;
    return () => {
      restoreContainer?.();
      restoreViewport();
    };
  },
  render: () => (
    <PreviewAdapterStory summaryState={PreviewSummaryState.Complete} />
  ),
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
    await expectBoundedBranchesFooter(
      canvasElement,
      GRID_TABLE_SCROLL_BAND_TEST_ID
    );
  },
};

/** Long branch and repository values exercise cell overflow and tooltips. */
export const Overflow: Story = {
  render: () => (
    <PreviewAdapterStory
      rows={PREVIEW_STORY_ROWS.map((row, index) =>
        index === 0
          ? {
              ...row,
              branchName:
                "agent/preview-adapter-0-with-a-very-long-branch-name-for-overflow",
              repo: "closedloop-ai/a-very-long-repository-name-for-overflow",
            }
          : row
      )}
      summaryState={PreviewSummaryState.Complete}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const value = await canvas.findByText(
      "agent/preview-adapter-0-with-a-very-long-branch-name-for-overflow",
      {},
      { timeout: 10_000 }
    );
    value.scrollIntoView({ block: "nearest", inline: "start" });
    await expect(value).toHaveClass("truncate");
    await expect(canvas.getByRole("status")).toHaveTextContent("1–25 of 36");
    expectOnScreen(value);
  },
};

/** A row without a pull request keeps the Open PR action disabled. */
export const DisabledPullRequestAction: Story = {
  render: () => (
    <PreviewAdapterStory
      rows={[
        {
          ...PREVIEW_STORY_ROWS[0]!,
          hasPullRequest: false,
          prNumber: null,
          prRepo: null,
          prState: null,
          prTitle: null,
          prUrl: null,
        },
      ]}
      summaryState={PreviewSummaryState.Complete}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const actions = await canvas.findByRole(
      "button",
      { name: "Branch actions" },
      { timeout: 10_000 }
    );
    actions.scrollIntoView({ block: "nearest", inline: "center" });
    expectOnScreen(actions);
    await userEvent.click(actions);
    const openPr = await screen.findByRole("menuitem", { name: "Open PR" });
    await expect(openPr).toHaveAttribute("data-disabled");
    await waitFor(() => {
      expect(openPr).toBeVisible();
      expect(actions).toHaveAttribute("aria-expanded", "true");
      expectOnScreen(openPr);
    });
  },
};

function PreviewAdapterStory({
  rows = PREVIEW_STORY_ROWS,
  summaryState,
}: {
  rows?: typeof PREVIEW_STORY_ROWS;
  summaryState: BranchesListSurfaceV2PreviewSummaryState;
}) {
  return (
    <div className="flex h-svh min-h-0 flex-col">
      <h1 className="sr-only">Branches</h1>
      <BranchesListSurfaceV2Preview
        now={PREVIEW_STORY_NOW}
        resolveSummaryCards={() => PREVIEW_STORY_ANALYTICS}
        rows={rows}
        summaryState={summaryState}
        surfaceProps={{
          renderBranchLink: ({ children, className }) => (
            <button className={`${className} text-left`} type="button">
              {children}
            </button>
          ),
        }}
      />
    </div>
  );
}

function makePreviewStoryRows() {
  return Array.from({ length: PREVIEW_STORY_ROW_COUNT }, (_, index) => {
    const source = BRANCH_SAMPLE_ROWS[index % BRANCH_SAMPLE_ROWS.length]!;
    return {
      ...source,
      branchName: `agent/preview-adapter-${index}`,
      canonicalIdentity: `preview-adapter-${index}`,
      id: `preview-adapter-${index}`,
      lastActivityAt: new Date(
        PREVIEW_STORY_NOW.getTime() - index * PREVIEW_STORY_HOUR_MS
      ).toISOString(),
      lastActivityLabel: index === 0 ? "just now" : `${index}h ago`,
      ownerKey: source.ownerKey ?? `preview:${source.owner.toLowerCase()}`,
    };
  });
}

function completePreviewMetric(value: number): BranchListMetricValue {
  return {
    current: { state: BranchMetricAvailability.Complete, value },
  };
}

const PREVIEW_STORY_ROW_COUNT = 36;
const PREVIEW_STORY_NOW = new Date("2026-07-29T00:00:00.000Z");
const PREVIEW_STORY_HOUR_MS = 60 * 60 * 1000;
const PREVIEW_STORY_ROWS = makePreviewStoryRows();
const PREVIEW_STORY_ANALYTICS = makeBranchAnalytics({
  canonicalMetrics: makeBranchListMetrics({
    activeBranches: completePreviewMetric(19),
    aiSpendUsd: completePreviewMetric(1862),
    canonicalLocPerDollar: completePreviewMetric(42.7),
    cohortSize: PREVIEW_STORY_ROW_COUNT,
    label: BranchMetricComparisonLabel.MonthOverMonth,
    lastActiveAt: {
      state: BranchMetricAvailability.Complete,
      value: PREVIEW_STORY_NOW.toISOString(),
    },
    medianPrSize: completePreviewMetric(384),
    mergeRatePct: completePreviewMetric(73),
    period: BranchMetricPeriod.ThirtyDays,
    totalLocPushed: completePreviewMetric(12_840),
  }),
});
/** The selected branches both lose their existing fixture tag. */
export const RemoveTag: Story = {
  beforeEach: () =>
    resetBulkTagFixture([], SELECTED_BRANCH_IDS.map(branchArtifactId)),
  parameters: ADD_TAG_PARAMETERS,
  play: async ({ canvasElement }) => {
    await selectListRows(canvasElement, SELECTED_BRANCH_IDS);
    await removeFixtureTag();
    await waitFor(() => expect(bulkTagWrites()).toHaveLength(1));
    for (const id of SELECTED_BRANCH_IDS) {
      await expectListRowTagMembership(canvasElement, id, false);
    }
  },
};

/** One selected branch loses the tag; the other is a successful no-op. */
export const RemoveTagNotPresent: Story = {
  beforeEach: () =>
    resetBulkTagFixture([], [branchArtifactId(SELECTED_BRANCH_IDS[0] ?? "")]),
  parameters: ADD_TAG_PARAMETERS,
  play: async ({ canvasElement }) => {
    await selectListRows(canvasElement, SELECTED_BRANCH_IDS);
    await removeFixtureTag();
    await waitFor(() => expect(bulkTagWrites()).toHaveLength(1));
    for (const id of SELECTED_BRANCH_IDS) {
      await expectListRowTagMembership(canvasElement, id, false);
    }
  },
};

/** One removal fails and remains available for the existing retry flow. */
export const RemoveTagPartialFailure: Story = {
  beforeEach: () => {
    const artifactIds = SELECTED_BRANCH_IDS.map(branchArtifactId);
    resetBulkTagFixture(artifactIds.slice(1), artifactIds);
  },
  // No hang: a deliberate ~15-step remove, partial-failure and retry play
  // (#8956, ISS-10686) that took 5280ms (Sessions) and 5309ms (Branches) in CI.
  // 10s is about 2x that; every other story keeps the sweep's 5s default.
  parameters: { ...ADD_TAG_PARAMETERS, storySweep: { timeoutMs: 10_000 } },
  play: async ({ canvasElement }) => {
    await selectListRows(canvasElement, SELECTED_BRANCH_IDS);
    await removeFixtureTag();
    await expect(
      await screen.findByText(
        BATCH_ITEM_FAILURE_MESSAGE[BatchItemFailureCode.ArtifactsNotFound]
      )
    ).toBeVisible();
    await waitFor(() => expect(bulkTagWrites()).toHaveLength(1));
    await expect(bulkTaggedIds()).toEqual([
      branchArtifactId(SELECTED_BRANCH_IDS[1] ?? ""),
    ]);
    await expectListRowTagMembership(
      canvasElement,
      SELECTED_BRANCH_IDS[0] ?? "",
      false
    );
    await expectListRowTagMembership(
      canvasElement,
      SELECTED_BRANCH_IDS[1] ?? "",
      true
    );
    await expect(
      within(canvasElement).getByRole("toolbar", {
        name: selectionSentence(SELECTED_BRANCH_IDS.length, BRANCHES_NOUN),
      })
    ).toBeInTheDocument();
    await deselectListRow(canvasElement, SELECTED_BRANCH_IDS[0] ?? "");
    await expect(
      within(canvasElement).getByRole("toolbar", {
        name: selectionSentence(1, BRANCHES_NOUN),
      })
    ).toBeInTheDocument();
    await retryFixtureTag();
    await waitFor(() => expect(bulkTagWrites()).toHaveLength(2));
    await expect(bulkTagWrites()[1]?.entityIds).toEqual([
      branchArtifactId(SELECTED_BRANCH_IDS[1] ?? ""),
    ]);
    await expectListRowTagMembership(
      canvasElement,
      SELECTED_BRANCH_IDS[1] ?? "",
      false
    );
    await expect(
      within(canvasElement).queryByRole("toolbar", {
        name: selectionSentence(1, BRANCHES_NOUN),
      })
    ).toBeNull();
    await expect(
      screen.queryByText(
        BATCH_ITEM_FAILURE_MESSAGE[BatchItemFailureCode.ArtifactsNotFound]
      )
    ).toBeNull();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await selectListRows(canvasElement, SELECTED_BRANCH_IDS);
    await addFixtureTag();
    await waitFor(() => expect(bulkTagWrites()).toHaveLength(3));
    for (const id of SELECTED_BRANCH_IDS) {
      await expectListRowTagMembership(canvasElement, id, true);
    }
    failNextBulkTagWrite([branchArtifactId(SELECTED_BRANCH_IDS[1] ?? "")]);
    await removeFixtureTag();
    await waitFor(() => expect(bulkTagWrites()).toHaveLength(4));
    await expect(bulkTagWrites()[3]?.entityIds).toEqual(
      SELECTED_BRANCH_IDS.map(branchArtifactId)
    );
    await expectListRowTagMembership(
      canvasElement,
      SELECTED_BRANCH_IDS[0] ?? "",
      false
    );
    await expectListRowTagMembership(
      canvasElement,
      SELECTED_BRANCH_IDS[1] ?? "",
      true
    );
    const failure = await screen.findByText(
      BATCH_ITEM_FAILURE_MESSAGE[BatchItemFailureCode.ArtifactsNotFound]
    );
    await expect(failure).toBeVisible();
    failure.scrollIntoView({ block: "nearest" });
    expectOnScreen(failure);
  },
};

/**
 * A geometry check for a real browser (`test:branches-plays`). The jsdom story
 * sweep lays nothing out, so every rect there is zero and the check is skipped.
 */
function expectOnScreen(element: HTMLElement): void {
  if (document.documentElement.getBoundingClientRect().width === 0) {
    return;
  }
  const bounds = element.getBoundingClientRect();
  expect(bounds.width).toBeGreaterThan(0);
  expect(bounds.height).toBeGreaterThan(0);
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(globalThis.innerWidth);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(globalThis.innerHeight);
}

async function expectBoundedBranchesFooter(
  canvasElement: HTMLElement,
  scrollBandTestId = "branches-scroll-container"
) {
  const canvas = within(canvasElement);
  const scrollBand = canvas.getByTestId(scrollBandTestId);
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
}

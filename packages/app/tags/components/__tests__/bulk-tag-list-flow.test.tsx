import {
  BatchItemFailureCode,
  batchItemApplied,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import { SESSIONS_ARTIFACT_TAGS_FLAG_KEY } from "@repo/api/src/types/sessions-artifact-tags-flag";
import {
  ArtifactTagAvailability,
  type Tag,
  TagColor,
  TagEntityType,
} from "@repo/api/src/types/tag";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { TableBulkActions } from "@repo/design-system/components/ui/table-bulk-actions";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { useQueryClient } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionTableRowFixture } from "../../../agents/components/sessions/session-list-fixtures";
import { SessionsListSurfaceV2 } from "../../../agents/components/sessions/sessions-list-surface-v2";
import { useSessionsBulkTagActions } from "../../../agents/components/sessions/use-sessions-bulk-tag-actions";
import { DEFAULT_SESSION_FACET_FILTERS } from "../../../agents/lib/session-filter-adapter";
import { SESSIONS_NOUN } from "../../../agents/lib/sessions-noun";
import { BranchesListSurfaceV2 } from "../../../branches/components/branches-list-surface-v2";
import { useBranchesBulkTagActions } from "../../../branches/components/use-branches-bulk-tag-actions";
import { useBranchViewState } from "../../../branches/hooks/use-branch-view-state";
import { BranchCohortNoticeKind } from "../../../branches/lib/branch-cohort-transparency";
import {
  type BranchRow,
  DEFAULT_BRANCH_FILTERS,
} from "../../../branches/lib/branch-row";
import { BRANCH_SAMPLE_ROWS } from "../../../branches/lib/branch-sample-data";
import { BRANCHES_NOUN } from "../../../branches/lib/branches-noun";
import { selectionSentence } from "../../../shared/components/generic-artifact-surface/bulk-action-bar";
import { formatRelativeTime } from "../../../shared/lib/date-utils";
import { DateRange } from "../../../shared/lib/format-utils";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import type { FixtureRoute } from "../../../shared/storybook/fixture-fetch";
import { stubContainerWidthPx } from "../../../test/mocks/container-width";
import { stubResponsiveNarrowViewport } from "../../../test/mocks/responsive-narrow-viewport";
import { tagKeys } from "../../hooks/use-tags";
import {
  BULK_TAG_ACTION_LABEL,
  BULK_TAG_EMPTY_LABEL,
} from "../../lib/bulk-tag-labels";
import { useBulkTagFamilyActions } from "../bulk-tag-action";
import { TagsSettingsTab } from "../tags-settings-tab";

const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];
const LIST_FLAGS = [
  SESSIONS_ARTIFACT_TAGS_FLAG_KEY,
  GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
];
const TAGS: Tag[] = [TagColor.Blue, TagColor.Red].map((color, index) => ({
  id: `tag-${index}`,
  name: index === 0 ? "backend" : "urgent",
  color,
  organizationId: "org_test",
  createdById: "user_test",
  createdAt: new Date(
    index === 0 ? "2026-01-01T00:00:00Z" : "2026-01-02T00:00:00Z"
  ),
  updatedAt: new Date("2026-01-02T00:00:00Z"),
}));
const ROWS = IDS.map((id) =>
  createSessionTableRowFixture({
    id,
    tagAvailability: ArtifactTagAvailability.Available,
    tagPermissions: { canApply: true, canRemove: true },
  })
);
const BRANCHES = BRANCH_SAMPLE_ROWS.slice(0, 2).map((row, index) => ({
  ...row,
  id: `branch-${index}`,
  artifactId: IDS[index],
  tagAvailability: ArtifactTagAvailability.Available,
  tagPermissions: { canApply: true, canRemove: true },
  lastActivityAt: new Date().toISOString(),
}));
let restoreWidth: (() => void) | undefined;

afterEach(() => {
  cleanup();
  restoreWidth?.();
  restoreWidth = undefined;
});

describe("production list tag wiring", () => {
  it("keeps the real Branch clear-only rail usable for an entirely ineligible selection (DT-G06)", async () => {
    restoreWidth = stubContainerWidthPx(1440);
    const writes: unknown[] = [];
    const branches = [
      ...BRANCHES,
      {
        ...BRANCHES[0],
        id: "denied",
        tagPermissions: { canApply: false, canRemove: true },
      },
      { ...BRANCHES[1], id: "local", artifactId: undefined },
    ];
    const { container } = render(
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "POST",
            path: "/entity-tags/batch/v2",
            respond: ({ body }) => {
              writes.push(body);
              return { results: IDS.map(batchItemApplied) };
            },
          },
        ]}
      >
        <TooltipProvider>
          <List branchRows={branches} entity="branches" />
        </TooltipProvider>
      </AppCoreStoryProviders>
    );
    fireEvent.click(await findRow(container, "denied"));
    fireEvent.click(await findRow(container, "local"), { ctrlKey: true });
    expect(
      screen.getByRole("toolbar", { name: selectionSentence(2, BRANCHES_NOUN) })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: BULK_TAG_ACTION_LABEL })
    ).toBeNull();
    expect(writes).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(writes).toEqual([]);
  });

  /**
   * DT-R05, changed by the ISS-12305 review: the catalog is parsed row by row,
   * so an entry this build cannot read is dropped instead of failing the whole
   * picker. Only a body that is not a list still reports a catalog error.
   */
  it("drops an unreadable catalog entry and offers no write for it (DT-R05)", async () => {
    const writes = renderPickerWithCatalog([
      { id: "malformed-tag", color: TagColor.Blue },
    ]);
    const user = userEvent.setup({ delay: null });
    await user.click(
      screen.getByRole("button", { name: BULK_TAG_ACTION_LABEL })
    );
    expect(await screen.findByText(BULK_TAG_EMPTY_LABEL)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(writes).toEqual([]);
  });

  it("keeps the readable tags when one carries a color this build does not know", async () => {
    renderPickerWithCatalog([
      TAGS[0],
      { ...TAGS[1], id: "future-tag", name: "future", color: "chartreuse" },
      TAGS[1],
    ]);
    const user = userEvent.setup({ delay: null });
    await user.click(
      screen.getByRole("button", { name: BULK_TAG_ACTION_LABEL })
    );
    expect(
      await screen.findByRole("button", { name: TAGS[0].name })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: TAGS[1].name })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "future" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports a catalog error when the body is not a list (DT-R05)", async () => {
    const writes = renderPickerWithCatalog({ id: "not-a-list" });
    const user = userEvent.setup({ delay: null });
    await user.click(
      screen.getByRole("button", { name: BULK_TAG_ACTION_LABEL })
    );
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(BULK_TAG_EMPTY_LABEL)).toBeNull();
    expect(writes).toEqual([]);
  });
  it.each(["sessions", "branches"] as const)(
    "uses the shared selected state in rendered %s narrow rows (DT-U03)",
    async (entity) => {
      restoreWidth = stubResponsiveNarrowViewport(true).restore;
      const { container } = render(
        <AppCoreStoryProviders enabledFlags={LIST_FLAGS}>
          <TooltipProvider>
            <List entity={entity} />
          </TooltipProvider>
        </AppCoreStoryProviders>
      );
      const id = entity === "sessions" ? IDS[0] : BRANCHES[0].id;
      const row = await waitFor(() => {
        const element = container.querySelector<HTMLElement>(
          `[data-grid-row-id="${id}"]`
        );
        if (!element) {
          throw new Error("Missing narrow row identity");
        }
        return element;
      });
      const identity = row.querySelector<HTMLElement>("[data-grid-cell]");
      if (!identity) {
        throw new Error("Missing narrow row identity cell");
      }
      expect(container.querySelectorAll('[role="columnheader"]')).toHaveLength(
        1
      );
      fireEvent.keyDown(identity, { key: " " });
      expect(row).toHaveAttribute("aria-selected", "true");
      fireEvent.click(row, { ctrlKey: true });
      expect(row).toHaveAttribute("aria-selected", "false");
    }
  );
  it.each(["sessions", "branches"] as const)(
    "routes Space and Ctrl+A through the %s list's production callbacks",
    async (entity) => {
      restoreWidth = stubContainerWidthPx(1440);
      const { container } = render(
        <AppCoreStoryProviders enabledFlags={LIST_FLAGS}>
          <TooltipProvider>
            <List entity={entity} />
          </TooltipProvider>
        </AppCoreStoryProviders>
      );
      const ids = entity === "sessions" ? IDS : BRANCHES.map((row) => row.id);
      const first = await findRow(container, ids[0]);
      const second = await findRow(container, ids[1]);
      const cell = first.querySelector<HTMLElement>("[data-grid-cell]");
      if (!cell) {
        throw new Error("Missing grid identity cell");
      }
      fireEvent.focus(cell);
      fireEvent.keyDown(cell, { key: " " });
      expect(first).toHaveAttribute("aria-selected", "true");
      expect(second).toHaveAttribute("aria-selected", "false");
      fireEvent.keyDown(cell, { key: "a", ctrlKey: true });
      expect(second).toHaveAttribute("aria-selected", "true");
      expect(
        screen.getByRole("button", { name: BULK_TAG_ACTION_LABEL })
      ).toBeInTheDocument();
    }
  );
  it.each(["sessions", "branches"] as const)(
    "selects multiple %s rows through the actual grid and writes canonical artifacts",
    async (entity) => {
      const requests: unknown[] = [];
      const routes: FixtureRoute[] = [
        { method: "GET", path: "/tags", respond: () => TAGS },
        {
          method: "POST",
          path: "/entity-tags/batch/v2",
          respond: ({ body }) => {
            requests.push(body);
            return { results: IDS.map(batchItemApplied) };
          },
        },
      ];
      restoreWidth = stubContainerWidthPx(1440);
      const user = userEvent.setup({ delay: null });
      const { container } = render(
        <AppCoreStoryProviders apiRoutes={routes} enabledFlags={LIST_FLAGS}>
          <TooltipProvider>
            <List entity={entity} />
          </TooltipProvider>
        </AppCoreStoryProviders>
      );
      const rowIds =
        entity === "sessions" ? IDS : BRANCHES.map((row) => row.id);
      const grid = screen.getByRole("grid");
      expect(grid).toHaveAttribute("aria-multiselectable", "true");
      const first = await findRow(container, rowIds[0]);
      const second = await findRow(container, rowIds[1]);
      fireEvent.click(first);
      fireEvent.click(second, { ctrlKey: true });
      expect(first).toHaveAttribute("aria-selected", "true");
      expect(second).toHaveAttribute("aria-selected", "true");
      await user.click(
        screen.getByRole("button", { name: BULK_TAG_ACTION_LABEL })
      );
      await user.click(
        await screen.findByRole("button", { name: TAGS[0].name })
      );
      await waitFor(() => expect(requests).toHaveLength(1));
      expect(requests[0]).toEqual({
        tagId: TAGS[0].id,
        entityType: TagEntityType.Artifact,
        entityIds: IDS,
      });
      // Operator ruling on the ISS-12305 review (Asana precedent): the picker
      // closes and the selection stays.
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: TAGS[0].name })).toBeNull()
      );
      expect(
        screen.getByRole("toolbar", {
          name: selectionSentence(
            2,
            entity === "sessions" ? SESSIONS_NOUN : BRANCHES_NOUN
          ),
        })
      ).toBeInTheDocument();
    }
  );

  it.each(["sessions", "branches"] as const)(
    "keeps the whole %s selection after a partial write and retries from it",
    async (entity) => {
      const requests: unknown[] = [];
      const routes: FixtureRoute[] = [
        { method: "GET", path: "/tags", respond: () => TAGS },
        {
          method: "POST",
          path: "/entity-tags/batch/v2",
          respond: ({ body }) => {
            requests.push(body);
            return {
              results:
                requests.length === 1
                  ? [
                      batchItemApplied(IDS[0]),
                      batchItemFailed(
                        IDS[1],
                        BatchItemFailureCode.ArtifactsNotFound
                      ),
                    ]
                  : IDS.map(batchItemApplied),
            };
          },
        },
      ];
      restoreWidth = stubContainerWidthPx(1440);
      const user = userEvent.setup({ delay: null });
      const { container } = render(
        <AppCoreStoryProviders apiRoutes={routes} enabledFlags={LIST_FLAGS}>
          <TooltipProvider>
            <List entity={entity} />
          </TooltipProvider>
        </AppCoreStoryProviders>
      );
      const rowIds =
        entity === "sessions" ? IDS : BRANCHES.map((row) => row.id);
      fireEvent.click(await findRow(container, rowIds[0]));
      fireEvent.click(await findRow(container, rowIds[1]), { ctrlKey: true });
      await user.click(
        screen.getByRole("button", { name: BULK_TAG_ACTION_LABEL })
      );
      await user.click(
        await screen.findByRole("button", { name: TAGS[0].name })
      );
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(
        screen.getByRole("toolbar", {
          name: selectionSentence(
            2,
            entity === "sessions" ? SESSIONS_NOUN : BRANCHES_NOUN
          ),
        })
      ).toBeInTheDocument();
      expect(await findRow(container, rowIds[0])).toHaveAttribute(
        "aria-selected",
        "true"
      );
      expect(await findRow(container, rowIds[1])).toHaveAttribute(
        "aria-selected",
        "true"
      );
      await user.click(screen.getByRole("button", { name: TAGS[0].name }));
      await waitFor(() => expect(requests).toHaveLength(2));
      expect(requests[1]).toEqual({
        tagId: TAGS[0].id,
        entityType: TagEntityType.Artifact,
        entityIds: IDS,
      });
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: TAGS[0].name })).toBeNull()
      );
      expect(screen.getByRole("toolbar")).toBeInTheDocument();
    }
  );

  it.each(["sessions", "branches"] as const)(
    "keeps the whole %s selection after a partial write and retries its failed selection",
    async (entity) => {
      const requests: unknown[] = [];
      const routes: FixtureRoute[] = [
        { method: "GET", path: "/tags", respond: () => TAGS },
        {
          method: "POST",
          path: "/entity-tags/batch/v2",
          respond: ({ body }) => {
            requests.push(body);
            const request = body as { entityIds: string[] };
            return {
              results:
                requests.length === 1
                  ? [
                      batchItemApplied(IDS[0]),
                      batchItemFailed(
                        IDS[1],
                        BatchItemFailureCode.ArtifactsNotFound
                      ),
                    ]
                  : request.entityIds.map(batchItemApplied),
            };
          },
        },
      ];
      restoreWidth = stubContainerWidthPx(1440);
      const user = userEvent.setup({ delay: null });
      const { container } = render(
        <AppCoreStoryProviders
          apiRoutes={routes}
          enabledFlags={[SESSIONS_ARTIFACT_TAGS_FLAG_KEY]}
        >
          <TooltipProvider>
            <List entity={entity} />
          </TooltipProvider>
        </AppCoreStoryProviders>
      );
      const rowIds =
        entity === "sessions" ? IDS : BRANCHES.map((row) => row.id);
      fireEvent.click(await findRow(container, rowIds[0]));
      fireEvent.click(await findRow(container, rowIds[1]), { ctrlKey: true });
      await user.click(
        screen.getByRole("button", { name: BULK_TAG_ACTION_LABEL })
      );
      await user.click(
        await screen.findByRole("button", { name: TAGS[0].name })
      );
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(
        screen.getByRole("toolbar", {
          name: selectionSentence(
            2,
            entity === "sessions" ? SESSIONS_NOUN : BRANCHES_NOUN
          ),
        })
      ).toBeInTheDocument();
      expect(await findRow(container, rowIds[0])).toHaveAttribute(
        "aria-selected",
        "true"
      );
      expect(await findRow(container, rowIds[1])).toHaveAttribute(
        "aria-selected",
        "true"
      );
      fireEvent.click(await findRow(container, rowIds[0]), { ctrlKey: true });
      expect(await findRow(container, rowIds[0])).toHaveAttribute(
        "aria-selected",
        "false"
      );
      expect(
        screen.getByRole("toolbar", {
          name: selectionSentence(
            1,
            entity === "sessions" ? SESSIONS_NOUN : BRANCHES_NOUN
          ),
        })
      ).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: TAGS[0].name }));
      await waitFor(() => expect(requests).toHaveLength(2));
      expect(requests[1]).toEqual({
        tagId: TAGS[0].id,
        entityType: TagEntityType.Artifact,
        entityIds: [IDS[1]],
      });
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: TAGS[0].name })).toBeNull()
      );
      expect(await findRow(container, rowIds[1])).toHaveAttribute(
        "aria-selected",
        "true"
      );
      expect(screen.queryByRole("toolbar")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    }
  );

  it("preserves canonical tag metadata before mounting the existing Created column", async () => {
    const user = userEvent.setup({ delay: null });
    render(
      <AppCoreStoryProviders
        apiRoutes={[{ method: "GET", path: "/tags", respond: () => TAGS }]}
      >
        <TooltipProvider>
          <PickerThenSettings />
        </TooltipProvider>
      </AppCoreStoryProviders>
    );
    await user.click(
      screen.getByRole("button", { name: BULK_TAG_ACTION_LABEL })
    );
    await screen.findByRole("button", { name: TAGS[0].name });
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Tags" }));
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Created")).toBeInTheDocument();
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    for (const tag of TAGS) {
      const row = within(table)
        .getAllByRole("row")
        .find((candidate) =>
          within(candidate).queryByRole("button", { name: tag.name })
        );
      expect(row).toHaveTextContent(formatRelativeTime(tag.createdAt));
    }
    expect(screen.getByTestId("canonical-cache")).toHaveTextContent(
      "org_test:user_test:2026-01-01"
    );
  });
});

function List({
  entity,
  branchRows = BRANCHES,
}: {
  entity: "sessions" | "branches";
  branchRows?: readonly BranchRow[];
}) {
  const sessionActions = useSessionsBulkTagActions(ROWS);
  const branchActions = useBranchesBulkTagActions(branchRows);
  if (entity === "branches") {
    return <BranchesList bulkActions={branchActions} rows={branchRows} />;
  }
  return (
    <SessionsListSurfaceV2
      bulkActions={sessionActions}
      controlledView={{
        value: {
          dateRange: DateRange.AllTime,
          facets: DEFAULT_SESSION_FACET_FILTERS,
          grouping: EMPTY_TABLE_GROUPING,
          page: 0,
          scopeUserId: null,
          search: "",
          sortBy: null,
          sortDir: "asc",
          visibleColumnIds: new Set(["status"]),
        },
        onChange: () => undefined,
      }}
      rows={ROWS}
      usage={undefined}
    />
  );
}

/** The shared Branches surface with only the props a selection flow reads. */
function BranchesList({
  bulkActions,
  rows,
}: {
  bulkActions: ReturnType<typeof useBranchesBulkTagActions>;
  rows: readonly BranchRow[];
}) {
  const { dateRange, sortDir, sortKey, visibleColumns } = useBranchViewState(
    undefined,
    true
  );
  const items = [...rows];
  const noop = () => undefined;
  return (
    <BranchesListSurfaceV2
      allRows={items}
      bulkActions={bulkActions}
      cohortNotice={{
        kind: BranchCohortNoticeKind.Hidden,
        total: items.length,
      }}
      comparisonSuppressedByFilter={false}
      hasActiveFilters={false}
      hasWindow={false}
      isError={false}
      isPending={false}
      isPlaceholderData={false}
      items={items}
      onPageChange={noop}
      onPageSizeChange={noop}
      onRetry={noop}
      onShowAllTime={noop}
      onSort={noop}
      onSummaryRetry={noop}
      page={0}
      pageSize={25}
      sortBy={sortKey}
      sortDir={sortDir}
      summaryAnalyticsErrored={false}
      summaryCards={undefined}
      summaryCardsErrored={false}
      summaryCardsPending={false}
      summaryCardsReloading={false}
      toolbar={{
        dateRange,
        filters: DEFAULT_BRANCH_FILTERS,
        onDateRangeChange: noop,
        onFiltersChange: noop,
        onToggleColumn: noop,
        rows: items,
        visibleColumns,
      }}
      total={items.length}
      totalPages={1}
      visibleColumns={visibleColumns}
    />
  );
}

/** Mounts the shared picker over a fixture catalog body; returns the writes it sends. */
function renderPickerWithCatalog(catalog: unknown): unknown[] {
  const writes: unknown[] = [];
  render(
    <AppCoreStoryProviders
      apiRoutes={[
        { method: "GET", path: "/tags", respond: () => catalog },
        {
          method: "POST",
          path: "/entity-tags/batch/v2",
          respond: ({ body }) => {
            writes.push(body);
            return { results: IDS.map(batchItemApplied) };
          },
        },
      ]}
    >
      <TooltipProvider>
        <PickerThenSettings />
      </TooltipProvider>
    </AppCoreStoryProviders>
  );
  return writes;
}

function PickerThenSettings() {
  const targets = IDS.map((id) => ({
    artifactId: id,
    rowId: id,
    canApply: true,
  }));
  const actions = useBulkTagFamilyActions({
    addTargets: targets,
    removeTargets: targets,
  });
  const client = useQueryClient();
  const [settings, setSettings] = useState(false);
  const cached = client.getQueryData<Tag[]>(tagKeys.list({}));
  return (
    <>
      <TableBulkActions
        actions={actions}
        rowIds={IDS}
        selection={{ clear: () => undefined, retain: () => undefined }}
      />
      <button onClick={() => setSettings(true)} type="button">
        Tags
      </button>
      {settings ? (
        <>
          <TagsSettingsTab />
          <output data-testid="canonical-cache">
            {cached
              ?.map(
                (tag) =>
                  `${tag.organizationId}:${tag.createdById}:${tag.createdAt.toISOString().slice(0, 10)}`
              )
              .join(",")}
          </output>
        </>
      ) : null}
    </>
  );
}

async function findRow(container: HTMLElement, id: string) {
  return await waitFor(() => {
    const row = container.querySelector<HTMLElement>(
      `[data-grid-row-id="${id}"]`
    );
    if (!row) {
      throw new Error(`Missing row ${id}`);
    }
    return row;
  });
}

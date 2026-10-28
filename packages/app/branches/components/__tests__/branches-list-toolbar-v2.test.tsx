import { BranchMetricId } from "@repo/api/src/types/branch-metrics";
import { GitHubConnectReturnStatus } from "@repo/api/src/types/github-status";
import { LIST_TOOLBAR_FILTER_LABEL } from "@repo/app/shared/components/list-toolbar-copy";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubResponsiveNarrowViewport } from "../../../test/mocks/responsive-narrow-viewport";
import {
  type BranchRow,
  BranchRowStatus,
  DEFAULT_BRANCH_FILTERS,
} from "../../lib/branch-row";
import { BranchesListSurfaceV2 } from "../branches-list-surface-v2";
import type { BranchesToolbarProps } from "../branches-toolbar-model";
import { branchesListSurfaceV2SummaryPropsFixture } from "./branches-list-surface-v2-props.fixtures";
import { branchesToolbarPropsFixture } from "./branches-toolbar-props.fixtures";

/**
 * ISS-9225 — the Branches v2 surface renders the CANONICAL v2 toolbar.
 *
 * Every assertion here drives the production mount and reads the rendered
 * affordance, never a threaded prop: the surface used to take an opaque
 * `ReactNode`, so a prop-level assertion would have stayed green through
 * exactly the gap this ticket exists to close.
 */

/** The wide Options menu trigger. */
const OPTIONS_TRIGGER = /options/i;

const ROW: BranchRow = {
  id: "owner%2Fweb::feature-a",
  branchName: "feature/a",
  baseBranch: "main",
  repo: "owner/web",
  owner: "Alex Rivera",
  status: BranchRowStatus.Open,
  prNumber: 42,
  prTitle: "Add feature",
  prUrl: "https://github.com/owner/web/pull/42",
  prState: "OPEN",
  checksPassed: 12,
  checksTotal: 12,
  checksStatus: "PASSING",
  behind: 1,
  ahead: 2,
  additions: 10,
  deletions: 5,
  sessionCount: 3,
  commentCount: null,
  lastActivityLabel: "2h ago",
  lastActivityAt: "2026-08-20T00:00:00.000Z",
};

const VISIBLE_COLUMNS = new Set(["owner", "status", "repo"]);
const RE_LAST_7_DAYS = /last 7 days/i;
const RE_REPOSITORY = /repository/i;
const RE_STATUS = /status/i;
const RE_CHANGES = /changes/i;
const RE_FILTER = /^Filter/;
let restoreViewport: (() => void) | undefined;

afterEach(() => {
  restoreViewport?.();
  restoreViewport = undefined;
});

describe("PRD-721 AC-5 / DT-FS-05 Branches toolbar", () => {
  it("NEVER renders the read-source badge (ISS-10209)", () => {
    // Operator direction, 2026-09-14: the badge is legitimate on other
    // surfaces and must never appear on the Branches LISTING. It survived
    // three removals because the listing renders THIS toolbar or the legacy
    // one depending on the workspace-experience split, so taking it out of one
    // arm left the other rendering it. Both arms are pinned; the sibling is in
    // the v1 toolbar, whose prop was deleted outright, so its type is the guard.
    renderSurface();
    // Vacuity guard: prove the toolbar actually mounted, so an empty render
    // cannot pass this by rendering nothing at all.
    expect(screen.getByRole("button", { name: OPTIONS_TRIGGER })).toBeTruthy();
    expect(screen.queryByTestId("read-source-badge")).toBeNull();
  });

  it("renders the shared date-range toggle group", () => {
    renderSurface();

    const group = screen.getByRole("radiogroup", {
      name: "Filter by date range",
    });
    expect(
      within(group).getByRole("radio", { name: RE_LAST_7_DAYS })
    ).toBeInTheDocument();
  });

  it("offers the branch facets through the shared filter popover", async () => {
    const user = userEvent.setup();
    renderSurface();

    await user.click(
      screen.getByRole("button", { name: LIST_TOOLBAR_FILTER_LABEL })
    );

    expect(
      await screen.findByRole("menuitem", { name: RE_REPOSITORY })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: RE_STATUS })
    ).toBeInTheDocument();
    // The RANGE facet too: the v2 popover has to keep every facet kind the v1
    // Branches popover offered, not just the options ones.
    expect(
      screen.getByRole("menuitem", { name: RE_CHANGES })
    ).toBeInTheDocument();
  });

  it("shows the Documents badge count and clears through the champion adapter (ISS-13007 R-IDENTICAL-LISTS)", async () => {
    const user = userEvent.setup();
    const onFiltersChange = vi.fn();
    renderSurface({
      filters: {
        ...DEFAULT_BRANCH_FILTERS,
        statuses: [BranchRowStatus.Open],
      },
      onFiltersChange,
    });

    const trigger = screen.getByRole("button", { name: RE_FILTER });
    expect(trigger).toHaveTextContent(`${LIST_TOOLBAR_FILTER_LABEL}1`);
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onFiltersChange).toHaveBeenCalledWith(DEFAULT_BRANCH_FILTERS);
  });

  it("reports a column toggled from the shared options menu", async () => {
    const user = userEvent.setup();
    const onToggleColumn = vi.fn();
    renderSurface({ onToggleColumn });

    await user.click(optionsTrigger());
    await user.click(
      await screen.findByRole("menuitem", { name: "Repository" })
    );

    expect(onToggleColumn).toHaveBeenCalledWith("repo");
  });

  it("offers the summary cards in Options and reports the card toggled (ISS-12664)", async () => {
    const user = userEvent.setup();
    const onToggleSummaryCard = vi.fn();
    renderSurface({
      hiddenSummaryCards: new Set([BranchMetricId.MedianPrSize]),
      onToggleSummaryCard,
    });

    await user.click(optionsTrigger());
    const menu = await screen.findByRole("menu");
    const mergeRate = within(menu).getByRole("menuitem", {
      name: "Merge rate",
    });
    expect(within(mergeRate).getByRole("switch")).toBeChecked();
    expect(
      within(
        within(menu).getByRole("menuitem", { name: "Median PR size" })
      ).getByRole("switch")
    ).not.toBeChecked();
    await user.click(mergeRate);

    expect(onToggleSummaryCard).toHaveBeenCalledWith(BranchMetricId.MergeRate);
  });

  it("offers the summary cards and 'Reset view' in Options with gridview-adoption off (ISS-12664, ISS-13035)", async () => {
    const user = userEvent.setup();
    const onToggleSummaryCard = vi.fn();
    const onResetView = vi.fn();
    renderSurface({
      enabledFlags: [],
      hiddenSummaryCards: new Set([BranchMetricId.MedianPrSize]),
      onResetView,
      onToggleSummaryCard,
    });

    await user.click(optionsTrigger());
    const menu = await screen.findByRole("menu");
    const mergeRate = within(menu).getByRole("menuitem", {
      name: "Merge rate",
    });
    expect(within(mergeRate).getByRole("switch")).toBeChecked();
    expect(
      within(
        within(menu).getByRole("menuitem", { name: "Median PR size" })
      ).getByRole("switch")
    ).not.toBeChecked();
    await user.click(mergeRate);
    expect(onToggleSummaryCard).toHaveBeenCalledWith(BranchMetricId.MergeRate);

    await user.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: "Reset view",
      })
    );
    expect(onResetView).toHaveBeenCalledTimes(1);
  });

  it("drops a hidden card from the strip and leaves the others (ISS-12664)", () => {
    renderSurface({
      hiddenSummaryCards: new Set([BranchMetricId.MergeRate]),
      onToggleSummaryCard: vi.fn(),
    });

    expect(screen.queryByText("Merge rate")).toBeNull();
    expect(screen.getByText("Median PR size")).toBeInTheDocument();
  });

  it("paints every card when a hidden set arrives without its writer (ISS-12664)", () => {
    renderSurface({ hiddenSummaryCards: new Set([BranchMetricId.MergeRate]) });

    expect(screen.getByText("Merge rate")).toBeInTheDocument();
  });

  it("renders no summary band when every card is hidden (ISS-12664)", () => {
    renderSurface({
      hiddenSummaryCards: new Set(Object.values(BranchMetricId)),
      onToggleSummaryCard: vi.fn(),
    });

    expect(screen.queryByText("Active branches")).toBeNull();
    expect(screen.queryByText("Median PR size")).toBeNull();
  });

  it("keeps the GitHub return failure alert when every card is hidden (ISS-12664)", () => {
    renderSurface({
      hiddenSummaryCards: new Set(Object.values(BranchMetricId)),
      onToggleSummaryCard: vi.fn(),
      summaryBandProps: { githubReturnStatus: GitHubConnectReturnStatus.Error },
    });

    expect(screen.queryByText("Active branches")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(
      GITHUB_RETURN_ERROR_MESSAGE
    );
  });

  it("keeps the host's connect outcome when every card is hidden (ISS-12664)", () => {
    renderSurface({
      hiddenSummaryCards: new Set(Object.values(BranchMetricId)),
      onToggleSummaryCard: vi.fn(),
      summaryBandProps: {
        githubConnectOutcome: <span>{CONNECT_OUTCOME_MARKER}</span>,
      },
    });

    expect(screen.queryByText("Active branches")).toBeNull();
    expect(screen.getByText(CONNECT_OUTCOME_MARKER)).toBeInTheDocument();
  });

  it("offers no summary-card rows when the host supplies no writer (ISS-12664)", async () => {
    const user = userEvent.setup();
    renderSurface();

    await user.click(optionsTrigger());
    const menu = await screen.findByRole("menu");

    expect(
      within(menu).getByRole("menuitem", { name: "Repository" })
    ).toBeTruthy();
    expect(within(menu).queryByText("Merge rate")).toBeNull();
  });

  it("names the reset action 'Reset view', as Sessions does (ISS-12664)", async () => {
    const user = userEvent.setup();
    const onResetView = vi.fn();
    renderSurface({ onResetView });

    await user.click(optionsTrigger());
    await user.click(
      await screen.findByRole("menuitem", { name: "Reset view" })
    );

    expect(onResetView).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("menuitem", { name: "Reset columns" })
    ).not.toBeInTheDocument();
  });

  it("offers wide Options and only the compact View menu at narrow width", () => {
    renderSurface();

    expect(screen.getByRole("button", { name: "Options" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "View" })).toBeNull();
    cleanup();
    renderSurface({ compact: true });
    expect(screen.getByRole("button", { name: "View" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Options" })).toBeNull();
  });

  it("offers the rows-per-page control over a settled result and hides the whole footer over an empty one", () => {
    renderSurface();
    expect(
      screen.getByRole("combobox", { name: "Rows per page" })
    ).toHaveTextContent("25 / page");

    cleanup();
    renderSurface({ items: [], total: 0 });
    expect(
      screen.queryByRole("combobox", { name: "Rows per page" })
    ).not.toBeInTheDocument();
  });
});

const CONNECT_OUTCOME_MARKER = "connect outcome slot";
const GITHUB_RETURN_ERROR_MESSAGE =
  "GitHub did not connect. Local branch data is still available.";

/**
 * The wide cluster's Options trigger. The narrow sibling is the folded View
 * menu once sorting is present.
 */
function optionsTrigger(): HTMLElement {
  return screen.getByRole("button", { name: "Options" });
}

function renderSurface({
  compact = false,
  enabledFlags = [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
  filters = DEFAULT_BRANCH_FILTERS,
  items = [ROW],
  onFiltersChange = () => undefined,
  hiddenSummaryCards,
  onResetView,
  onToggleColumn = () => undefined,
  onToggleSummaryCard,
  summaryBandProps,
  total = 1,
}: Partial<
  Pick<
    BranchesToolbarProps,
    | "filters"
    | "hiddenSummaryCards"
    | "onFiltersChange"
    | "onResetView"
    | "onToggleColumn"
    | "onToggleSummaryCard"
  >
> & {
  compact?: boolean;
  /** Defaults to gridview-adoption on; pass `[]` for the closed arm. */
  enabledFlags?: readonly string[];
  items?: BranchRow[];
  summaryBandProps?: Partial<
    Pick<
      ComponentProps<typeof BranchesListSurfaceV2>,
      "githubConnectOutcome" | "githubReturnStatus"
    >
  >;
  total?: number;
} = {}) {
  if (compact) {
    restoreViewport = stubResponsiveNarrowViewport(true).restore;
  }
  const toolbar: BranchesToolbarProps = branchesToolbarPropsFixture({
    dateRange: "7d",
    filters,
    hiddenSummaryCards,
    onFiltersChange,
    onResetView,
    onToggleColumn,
    onToggleSummaryCard,
    rows: items,
    visibleColumns: VISIBLE_COLUMNS,
  });
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
    >
      <BranchesListSurfaceV2
        allRows={items}
        hasActiveFilters={false}
        hasWindow={false}
        isError={false}
        isPending={false}
        isPlaceholderData={false}
        items={items}
        onPageChange={() => undefined}
        onPageSizeChange={() => undefined}
        onRetry={() => undefined}
        onShowAllTime={() => undefined}
        onSort={() => undefined}
        page={0}
        pageSize={25}
        sortBy="lastActivity"
        sortDir="desc"
        {...branchesListSurfaceV2SummaryPropsFixture()}
        {...summaryBandProps}
        toolbar={toolbar}
        total={total}
        totalPages={Math.max(1, Math.ceil(total / 25))}
        visibleColumns={VISIBLE_COLUMNS}
      />
    </FeatureFlagAdapterProvider>
  );
}

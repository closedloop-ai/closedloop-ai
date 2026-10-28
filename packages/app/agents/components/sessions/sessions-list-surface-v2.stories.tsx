import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { TOTAL_ESTIMATED_COST_ALIAS_LABEL } from "@repo/api/src/types/total-estimated-cost-copy";
import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import {
  getByRoleInOwnParent,
  queryByRoleInOwnParent,
} from "@repo/app/shared/storybook/scoped-role-query";
import { userKeys } from "@repo/app/users/hooks/use-users";
import { GRID_TABLE_METRIC_BAND_TEST_ID } from "@repo/design-system/components/ui/grid-table-list-surface";
import { MonoIdCell } from "@repo/design-system/components/ui/mono-id-cell";
import {
  EMPTY_TABLE_GROUPING,
  type TableGroupingState,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { isGridChromeRowId } from "@repo/design-system/lib/grid-table-v2-chrome-rows";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fireEvent, userEvent, within } from "storybook/test";
import {
  SESSIONS_DEFAULT_VISIBLE_COLUMN_IDS,
  SESSIONS_SEAM_REQUIRED_COLUMN_IDS,
} from "../../lib/sessions-column-visibility";
import { SESSIONS_DATA_COLUMN_ORDER } from "../../lib/sessions-table-columns";
import {
  createFullyPopulatedSessionsUsageFixture,
  createSessionTableRowFixture,
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
} from "./session-list-fixtures";
import { SessionsListSurfaceV2 } from "./sessions-list-surface-v2";
import { SessionsListSurfaceV2Preview } from "./sessions-list-surface-v2-demo";
import { SESSIONS_METRIC_CARD_LABEL } from "./sessions-summary-card-labels";
import {
  SESSIONS_SUMMARY_CARD_IDS,
  SessionsSummaryCardId,
} from "./sessions-summary-card-visibility";

/**
 * The signed-in viewer these stories seed, and an owner of two `ROWS`.
 *
 * `Default` seeds it too, deliberately. The ordinary case for a Sessions
 * listing is a signed-in reader looking at a list that includes their OWN
 * sessions, which is exactly when rename is offered — so a `Default` with no
 * viewer is not a neutral baseline, it is an unrepresentative one that makes a
 * shipped capability look missing (operator feedback, 2026-10-02).
 */
const VIEWER_USER_ID = "u-marisol";
/** One row that viewer owns, and one he does not. */
const OWNED_SESSION_NAME = "agent/seed-generator";
const UNOWNED_SESSION_NAME = "agent/refactor-auth-guard";

/**
 * The global app-core harness configured as a signed-in reader with a writable
 * sessions source: the viewer above, plus the PATCH route a rename commits
 * through. Declared as PARAMETERS, never as a nested `AppCoreStoryProviders` —
 * a second harness replaces the preview's shared navigation port, which
 * `app-core-harness-single-mount.test.ts` fails a story for.
 *
 * Shared by `Default` and `OwnerRenamesFromTheListing` so the two cannot drift
 * into disagreeing about what a signed-in reader sees.
 */
const SIGNED_IN_VIEWER = {
  appCore: {
    apiRoutes: [
      {
        method: "PATCH" as const,
        path: "/agent-sessions/*",
        // Accepts and echoes, as the cloud route does.
        respond: (context: { body: unknown }) => ({
          ok: true,
          received: context.body,
        }),
      },
    ],
    queryData: [[userKeys.currentUser(), { id: VIEWER_USER_ID }]],
  },
};

/**
 * ISS-7052 — the Sessions listing composed on the Grid Table v2 stack: toolbar,
 * the production metric-card summary row, and `GridTableV2`, with pagination.
 *
 * This is the Sessions counterpart to the `Branches/` list-surface stories, and
 * it is deliberately built from the REAL parts rather than a story-local
 * approximation: `SessionsSummaryCards`, the `SessionTableRow` type, the
 * canonical `SESSIONS_COLUMN_SPECS` geometry, and the shared session fixtures.
 * A composite assembled from stand-ins can only prove that something of roughly
 * that shape renders; this one exercises the components the page will actually
 * mount.
 *
 * Titled Surfaces/Sessions, not a Composite: `apps/app/.../sessions/page.tsx`
 * now renders this exact component (via `sessions-list-v2-host.tsx`) behind
 * the `grid-table-v2` PostHog gate (ISS-7052 Part A landed), so this story
 * is the real Sessions surface, not an approximation of it.
 */
const meta = {
  title: "Surfaces v1.0/Sessions/Listing",
  tags: ["deprecated"],
  component: SessionsListSurfaceV2,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SessionsListSurfaceV2>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * ISS-8217: the instant this file's rows are dated against — the LIVE clock,
 * read once as the module loads, rather than the FIXED `SESSION_FIXTURE_NOW_MS`
 * the vitest suites pin their fake clock to.
 *
 * Most stories below mount the surface CLIENT-driven, and the client resolver
 * now applies the selected date window, whose default is the last 7 days. Rows
 * dated from a fixed past instant sit outside that window on every clock but
 * the one the fixture was written on, so the catalog entry paints an empty
 * table — and paints it CORRECTLY: a 7-day window over months-old rows has
 * nothing to show. The mismatch is that the rows are absolute-dated while the
 * window is relative to now, so the anchor is what has to move.
 *
 * This does NOT opt the stories out of the window. The filter still runs on
 * every mount; the rows are simply as recent as the relative labels beside them
 * ("2h ago") already claim, so the window admits them.
 *
 * The vitest suites cannot share this anchor — their assertions need a
 * reproducible instant, so they pin the clock to the fixed one instead
 * (`packages/app/test/mocks/session-fixture-clock.ts`).
 */
const STORY_NOW_MS = Date.now();

/**
 * `autonomy` and `branch` carry a deliberate SPREAD rather than one filler
 * value. This surface renders every entry in `SESSIONS_COLUMN_SPECS`, so both
 * columns are always on screen and a fixture that omits them renders a wall of
 * em dashes — the grid renders as v2 while demonstrating none of the cells it
 * is here to show. Distinct per-row values mean a resolver that reads a
 * constant, the wrong row, or the wrong field is visible rather than hidden
 * behind repeated ones.
 *
 * FEA-4206: Autonomy now renders its TIER WORD, so the scores are chosen for the
 * tiers they land in rather than for being distinct numbers — 92/41/22 span
 * High, Mixed and Guided so all three chip tones appear, and `guided`'s muted
 * tone in particular is only exercised here. A spread of numbers that all
 * classify High would render one repeated word and demonstrate nothing.
 *
 * Every `branch` deliberately DIFFERS from its row's `name`. They were equal on
 * every row, which made the rendered-cell assertion below unfalsifiable:
 * `SESSION_CELL_READERS.branches` reading `row.name` instead of `row.branch`
 * rendered identically and the story stayed green.
 *
 * Autonomy is sortable by these underlying scores, while neither Autonomy nor
 * Branch is groupable. `GROUPABLE_COLUMN_IDS` is
 * `status`/`owner`/`harness`/`model`, so `branches` is not a Group choice — and
 * `groupKey` buckets on a column's WHOLE rendered value, never a prefix, so
 * shared branch prefixes would not collapse into one group even if it were.
 *
 * ISS-7902: `status` is bound to `SESSION_STATUS` rather than spelled
 * `"Active"`/`"Failed"`/`"Completed"`. Those literals dated from when this cell
 * was a `TableChoiceCell` printing the raw word back, so any spelling looked
 * right; the cell now renders `SessionStatusBadge`, which folds an unrecognized
 * value fail-open to Active (ISS-4997). Left alone, five of these six rows would
 * have rendered a pulsing green "Active" — including the two the fixture calls
 * failed and completed — while the Status FACET, which keys on the raw stored
 * value, kept matching only two of them.
 *
 * `ses-5` keeps `autonomy: null` and `ses-6` keeps `branch: null` on purpose:
 * the em-dash empty cell is real production behavior for a row whose producer
 * served no value, and a fixture where every cell is populated stops covering
 * it.
 */
const ROWS = [
  createStoryRow({
    id: "ses-1",
    name: "agent/refactor-auth-guard",
    status: SESSION_STATUS.ACTIVE,
    user: { id: "u-ottilie", name: "Ottilie Eastwick" },
    harness: "claude",
    model: "claude-opus-4-8",
    repo: "closedloop-ai/closedloop-ai",
    costLabel: "$4.12",
    costValue: 4.12,
    durationLabel: "18m",
    durationMs: 18 * MINUTE_MS,
    lastActivityLabel: "2h ago",
    lastActivityAtMs: STORY_NOW_MS - 2 * HOUR_MS,
    autonomy: 92,
    branch: "marisol/auth-guard-rewrite",
  }),
  createStoryRow({
    id: "ses-2",
    name: "fix/token-rounding",
    status: SESSION_STATUS.ERROR,
    user: { id: "u-pascoe", name: "Pascoe Birchall" },
    harness: "claude",
    model: "claude-sonnet-5",
    repo: "closedloop-ai/closedloop-ai",
    costLabel: "$0.24",
    costValue: 0.24,
    durationLabel: "41m",
    durationMs: 41 * MINUTE_MS,
    lastActivityLabel: "Yesterday",
    lastActivityAtMs: STORY_NOW_MS - DAY_MS,
    autonomy: 41,
    branch: "pascoe/cost-rounding-hotfix",
  }),
  createStoryRow({
    id: "ses-3",
    name: "agent/seed-generator",
    status: SESSION_STATUS.INACTIVE,
    user: { id: "u-marisol", name: "Marisol Ashgrove" },
    harness: "codex",
    model: "gpt-5-codex",
    repo: "closedloop-ai/closedloop-electron",
    costLabel: "$1.08",
    costValue: 1.08,
    durationLabel: "3m",
    durationMs: 3 * MINUTE_MS,
    lastActivityLabel: "2 days ago",
    lastActivityAtMs: STORY_NOW_MS - 2 * DAY_MS,
    autonomy: 22,
    branch: "marisol/seed-generator-cli",
  }),
  createStoryRow({
    id: "ses-4",
    name: "feat/grid-table-toolbar",
    status: SESSION_STATUS.ACTIVE,
    user: { id: "u-ottilie", name: "Ottilie Eastwick" },
    harness: "claude",
    model: "claude-opus-5",
    repo: "closedloop-ai/closedloop-ai",
    costLabel: "$9.87",
    costValue: 9.87,
    durationLabel: "1h 12m",
    durationMs: 72 * MINUTE_MS,
    lastActivityLabel: "3 days ago",
    lastActivityAtMs: STORY_NOW_MS - 3 * DAY_MS,
    autonomy: 88,
    branch: "ottilie/toolbar-v2",
  }),
  createStoryRow({
    id: "ses-5",
    name: "chore/upgrade-prisma",
    status: SESSION_STATUS.INACTIVE,
    user: { id: "u-pascoe", name: "Pascoe Birchall" },
    harness: "codex",
    model: "claude-haiku-4-5",
    repo: "closedloop-ai/closedloop-electron",
    costLabel: "$0.61",
    costValue: 0.61,
    durationLabel: "7m",
    durationMs: 7 * MINUTE_MS,
    lastActivityLabel: "5 days ago",
    lastActivityAtMs: STORY_NOW_MS - 5 * DAY_MS,
    autonomy: null,
    branch: "pascoe/prisma-6-upgrade",
  }),
  createStoryRow({
    id: "ses-6",
    name: "agent/backfill-telemetry",
    status: SESSION_STATUS.INACTIVE,
    user: { id: "u-marisol", name: "Marisol Ashgrove" },
    harness: "claude",
    model: "gpt-5.5",
    repo: "closedloop-ai/closedloop-ai",
    costLabel: "$2.45",
    costValue: 2.45,
    durationLabel: "22m",
    durationMs: 22 * MINUTE_MS,
    lastActivityLabel: "1 week ago",
    lastActivityAtMs: STORY_NOW_MS - 7 * DAY_MS,
    autonomy: 63,
    branch: null,
  }),
];

const DEFAULT_STORY_TOTAL_ROWS = 1047;

const USAGE = createFullyPopulatedSessionsUsageFixture();

const DEFAULT_USAGE = {
  ...createFullyPopulatedSessionsUsageFixture(),
  totalSessions: DEFAULT_STORY_TOTAL_ROWS,
};

/** The Active group's header, and "does this header state any number".  */
const ACTIVE_GROUP_HEADER = /Active/;

const ANY_DIGIT = /\d/;

const NEXT_PAGE_LABEL = "Go to next page";

const GROUPED_BY_STATUS: TableGroupingState = {
  primary: {
    fieldId: "status",
    order: TableGroupOrder.Ascending,
    showEmptyGroups: false,
  },
  secondary: {
    fieldId: null,
    order: TableGroupOrder.Ascending,
    showEmptyGroups: false,
  },
};

/**
 * The resting surface: toolbar, the real summary strip, and a production-size
 * dataset. The first six rows retain the semantic cell spread documented above;
 * the remaining unique fixtures let the surface own real sort/filter/page-size
 * behavior while the footer reconciles with the summary's total.
 */
/**
 * ISS-8718 — the owner's inline rename, ON this real surface.
 *
 * The listing already renders it in production: `renderGridLead` mounts
 * `SessionNameLeadCell` (`sessions-list-surface-renderers.tsx`). Every other
 * story here shows the plain lead, because both of the affordance's gates fail
 * without a harness — `useSessionRenamePreconditions` needs a data source
 * offering `renameSession` plus a QueryClient, and `useSessionRenameOwnerGate`
 * needs a viewer whose id matches the row's owner, so with no mocked viewer no
 * row can be owned. So the shipped surface had no story exercising the control
 * at all, which is how it regresses without anything going red.
 *
 * Both gates are satisfied here through `parameters.appCore` — the global
 * harness, NOT a nested `AppCoreStoryProviders`, which
 * `app-core-harness-single-mount.test.ts` forbids.
 *
 * `ROWS` already carries three distinct owners, so the DISTINCTION is the
 * fixture's own: seeding the viewer as `u-marisol` makes his two rows editable
 * while Ottilie's and Pascoe's keep the plain link. Seeing both in one frame is
 * the point — a gate that offered the control to everybody would look identical
 * on a single-row story. Ownership is `sessionNameIsEditableBy`'s current rule;
 * whether a non-owner should ever be offered rename is nobody's question yet.
 */
export const OwnerRenamesFromTheListing: Story = {
  args: { rows: ROWS, usage: DEFAULT_USAGE },
  parameters: SIGNED_IN_VIEWER,
  render: (args) => (
    <SessionsListSurfaceV2Preview
      rows={args.rows}
      surfaceProps={args}
      totalRows={DEFAULT_STORY_TOTAL_ROWS}
      usage={args.usage}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const ownedControl = {
      name: `Edit session name for ${OWNED_SESSION_NAME}`,
    };

    // The gate, both ways, in one frame.
    await expect(canvas.getByRole("button", ownedControl)).toBeInTheDocument();
    await expect(
      canvas.queryByRole("button", {
        name: `Edit session name for ${UNOWNED_SESSION_NAME}`,
      })
    ).toBeNull();

    // And a real commit. The surface is fed its rows as PROPS, so nothing
    // echoes the write back — the renamed row shows because `InlineNameCell`
    // remembers what the write accepted. A render keyed only on the prop would
    // still show the old name here, which is what made ISS-8718's first
    // `CommittedRename` story unprovable.
    await userEvent.click(canvas.getByRole("button", ownedControl));
    const field = canvas.getByRole("textbox", ownedControl);
    await userEvent.clear(field);
    await userEvent.type(field, "agent/renamed-in-the-listing{Enter}");
    await expect(
      canvas.getByText("agent/renamed-in-the-listing")
    ).toBeInTheDocument();
  },
};

export const Default: Story = {
  args: { rows: ROWS, usage: DEFAULT_USAGE },
  parameters: SIGNED_IN_VIEWER,
  render: (args) => (
    <SessionsListSurfaceV2Preview
      rows={args.rows}
      seedCustomFields
      surfaceProps={args}
      totalRows={DEFAULT_STORY_TOTAL_ROWS}
      usage={args.usage}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // The v2 toolbar.
    await expect(
      getByRoleInOwnParent(canvasElement, "button", "Sort")
    ).toBeVisible();
    await expect(
      getByRoleInOwnParent(canvasElement, "button", "Group")
    ).toBeVisible();
    await expect(
      getByRoleInOwnParent(canvasElement, "button", "Options")
    ).toBeVisible();
    // The PRODUCTION summary strip, not a hand-rolled MetricCard row.
    await expect(canvas.getByText("Sessions")).toBeVisible();
    await expect(canvas.getByText("1,047")).toBeVisible();
    // The grid, using the canonical column geometry.
    await expect(
      canvasElement.querySelector('[data-column-id="status"]')
    ).not.toBeNull();
    await expect(
      canvasElement.querySelector('[data-column-id="custom-field:stage"]')
    ).not.toBeNull();
    await expect(canvas.getByText("Cycle time")).toBeVisible();

    await expect(
      getByRoleInOwnParent(canvasElement, "button", "Add field")
    ).toBeVisible();
    // The real production footer: a full page, its page-size control, the same
    // total as the summary, and an enabled route to the next page.
    await expect(
      canvas.getByRole("combobox", { name: "Rows per page" })
    ).toHaveTextContent("25 / page");
    // Named through its own text: ISS-9574 added a second `role="status"` to
    // this surface — the visually hidden selected-count region — so a bare
    // role query is no longer unambiguous about which claim it is reading.
    await expect(
      canvas.getByText("Showing 1-25 of 1,047 sessions")
    ).toBeVisible();
    await expect(dataGridRows(canvasElement)).toHaveLength(25);
    const nextPage = canvas.getByLabelText("Go to next page");
    await expect(nextPage).toBeVisible();
    await expect(nextPage).not.toHaveAttribute("aria-disabled", "true");

    // The two columns the fixture used to leave empty. Scoped to
    // `role="gridcell"` so these read the DATA cell, not the same-`data-column-id`
    // column HEADER, and asserted on rendered text rather than on the fixture
    // object: a fixture that stops supplying `autonomy`/`branch`, and a resolver
    // that stops reading them, both regress to the em dash and both fail here.
    // ses-1's values, and ses-1 is on the first page. Each expected value belongs
    // to that ONE field of ses-1 and to no other — the branch is not the row's
    // `name`, and no other ses-1 field spells "High" — so a resolver that reads a
    // neighbouring field renders something different and fails rather than
    // coincidentally matching. The tier WORD rather than the 92 since FEA-4206:
    // the score moved into the chip's tooltip, which Radix portals outside
    // `canvasElement`, so asserting the number here would assert on nothing.
    await expect(
      canvasElement.querySelector(
        '[role="gridcell"][data-column-id="autonomy"]'
      )
    ).toHaveTextContent("High");
    await expect(
      canvasElement.querySelector(
        '[role="gridcell"][data-column-id="branches"]'
      )
    ).toHaveTextContent("marisol/auth-guard-rewrite");

    const anthropicModel = canvas.getByText("claude-opus-4-8");
    await expect(
      anthropicModel
        .closest('[data-column-id="model"]')
        ?.querySelector("span[aria-hidden]")
    ).toHaveClass("text-primary");

    const openAiModel = canvas.getByText("gpt-5-codex");
    await expect(
      openAiModel
        .closest('[data-column-id="model"]')
        ?.querySelector("span[aria-hidden]")
    ).toHaveClass("text-success");

    // ISS-8718: the owner's inline rename, on the story a reviewer opens. Both
    // ways round, because a gate that offered the control to everybody would
    // look identical on a list of one owner's rows.
    await expect(
      getByRoleInOwnParent(
        canvasElement,
        "button",
        `Edit session name for ${OWNED_SESSION_NAME}`
      )
    ).toBeInTheDocument();
    await expect(
      queryByRoleInOwnParent(
        canvasElement,
        "button",
        `Edit session name for ${UNOWNED_SESSION_NAME}`
      )
    ).toBeNull();
  },
};

/** Grouped, so the paginator stands down and every row is shown in sections. */
export const GroupedByStatus: Story = {
  args: {
    rows: ROWS,
    usage: USAGE,
    pageSize: 4,
    initialGrouping: GROUPED_BY_STATUS,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(
      canvas.getByRole("button", { name: "Groups: 1" })
    ).toBeVisible();
    await expect(canvas.getAllByRole("rowgroup").length).toBeGreaterThan(1);
    await expect(canvas.queryByLabelText("Go to next page")).toBeNull();
  },
};

/** Filters applied, so the chip row renders and the row set narrows. */
export const WithActiveFilters: Story = {
  args: {
    rows: ROWS,
    usage: USAGE,
    pageSize: 4,
    initialFacets: {
      ...DEFAULT_SESSION_FACET_FILTERS,
      statuses: [SESSION_STATUS.ACTIVE],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText("Status: Active")).toBeVisible();
    // Two Active rows, so one page — the control stays mounted and disables.
    await expect(canvas.getByLabelText("Go to next page")).toHaveAttribute(
      "aria-disabled",
      "true"
    );
  },
};

/**
 * The summary strip's loading state, forwarded straight through to
 * `SessionsSummaryCards` — one of the states a hand-assembled metric row could
 * not have exercised at all.
 */
export const LoadingSummary: Story = {
  args: { rows: ROWS, usage: undefined, isLoading: true, pageSize: 4 },
};

/**
 * Narrow viewport: the toolbar folds, the metric strip becomes a carousel, and
 * the shared grid projects its canonical Name-only rows instead of overflowing
 * sideways.
 */
export const CompactWidth: Story = {
  args: { rows: ROWS, usage: USAGE, pageSize: 4 },
  globals: { viewport: { value: "mobile1" } },
};

/**
 * FEA-4217 — the summary-card seam, whose visible half is which cards the strip
 * paints. The host supplies the HIDDEN set it persists and a handler to report a
 * flip to; both are required, because a switch the surface cannot read back
 * springs to ON on the next render.
 *
 * Cost is hidden here, so the strip paints four cards and the toolbar's metric
 * rows report Cost as off. The row and the card are the two ends of one set —
 * seeing them agree is the point of the story (whitlockk review).
 */
export const SummaryCardsPartlyHidden: Story = {
  args: {
    rows: ROWS,
    usage: USAGE,
    pageSize: 4,
    hiddenSummaryCards: new Set([SessionsSummaryCardId.Cost]),
    onToggleSummaryCard: () => undefined,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Scoped to the BAND, not the canvas. The query is for what the CARD paints
    // — ruling 7's alias since 2026-09-20 — and a canvas-wide query for it would
    // find the columns menu's own Cost row, which never goes. The card's own
    // absence is the contract, so the scope is what makes it observable.
    const band = canvas.getByTestId(GRID_TABLE_METRIC_BAND_TEST_ID);

    await expect(
      within(band).getByText(SESSIONS_METRIC_CARD_LABEL)
    ).toBeInTheDocument();
    await expect(
      within(band).queryByText(TOTAL_ESTIMATED_COST_ALIAS_LABEL)
    ).toBeNull();
  },
};

/**
 * Every card hidden: the metric BAND goes, not just the cards.
 *
 * `SessionsSummaryCards` already returns null on this state, but the band around
 * it is the surface's own padded wrapper — left mounted it puts an unexplained
 * gap between the toolbar and the table, which reads as a failed load rather
 * than as a view the reader chose.
 */
export const SummaryCardsAllHidden: Story = {
  args: {
    rows: ROWS,
    usage: USAGE,
    pageSize: 4,
    hiddenSummaryCards: new Set(SESSIONS_SUMMARY_CARD_IDS),
    onToggleSummaryCard: () => undefined,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // No card, and — the part the band guard owns — nothing between the toolbar
    // and the table holding their place.
    // The band's absence is this story's own contract and subsumes a per-card
    // query: no band, no card in it. It also replaces the Cost card's text
    // query, which ISS-10636 made unusable at canvas scope — the Cost COLUMN
    // header carries the same phrase and is still on screen by design.
    await expect(
      canvas.queryByTestId(GRID_TABLE_METRIC_BAND_TEST_ID)
    ).toBeNull();
    await expect(canvas.queryByText(SESSIONS_METRIC_CARD_LABEL)).toBeNull();
    await expect(canvas.getByRole("button", { name: "Options" })).toBeVisible();
  },
};

/**
 * The list-body states, the Sessions counterpart to `Branches List Body`.
 *
 * There is no `SessionsListBody` component to story — the Sessions page renders
 * its table directly, where Branches extracted one. Rather than invent a
 * component to match a Storybook shape, these cover the same states on the
 * surface that will actually replace the page's table. They exist because a
 * list that can only render rows is not drop-in-ready: it has no honest answer
 * for a failed read, and would show a bare header with no explanation.
 */

/** Read in flight: skeleton rows, sized so the region does not jump on arrival. */
export const BodyPending: Story = {
  args: { rows: [], usage: undefined, isLoading: true, isPending: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByTestId("sessions-list-skeleton")).toBeVisible();
    // The toolbar stays mounted while rows load, so the controls do not flicker.
    await expect(canvas.getByRole("button", { name: "Sort" })).toBeVisible();
  },
};

/** The read failed. `SessionsEmptyState` resolves this to its Unavailable copy. */
export const BodyError: Story = {
  args: { rows: [], usage: undefined, isError: true, onRetry: () => undefined },
};

/** Mid-sync rather than errored — deliberately different copy from BodyError. */
export const BodySyncing: Story = {
  args: { rows: [], usage: undefined, isError: true, isSyncing: true },
};

/**
 * Zero rows with no filter active — a genuine empty, which routes to onboarding
 * rather than to "no matches".
 */
export const BodyEmpty: Story = {
  args: { rows: [], usage: USAGE, hasConnectedAgent: false },
};

/**
 * Zero rows BECAUSE a filter narrowed them away. The distinction matters: this
 * offers "clear filters", where a genuine empty offers onboarding. Driven by the
 * real `hasActiveFilters` signal, not by a row count.
 */
export const BodyFilteredEmpty: Story = {
  args: {
    rows: ROWS,
    usage: USAGE,
    initialFacets: {
      ...DEFAULT_SESSION_FACET_FILTERS,
      statuses: ["NoSuchStatus"],
    },
  },
};

/**
 * ISS-7262 — the three HOST SEAMS wired at once, which is the shape a real
 * Sessions host mounts this in. Without a story they existed only in a jsdom
 * assertion, and the lead cell is the one part of them with a visual treatment.
 *
 * The session name is a `Link` (underlining on ROW hover, not only on its own
 * line box), and the headers are drag surfaces because the host wired both
 * halves of the reorder pair.
 *
 * `Owning project` and `Linked issues` need BOTH halves from the host, which is
 * why this story wires a `controlledView` as well as the two renderers. A seam
 * renderer only makes its column OFFERABLE — it is still gated AND default-off
 * (`SESSIONS_DEFAULT_VISIBLE_COLUMN_IDS` is derived without the host-supplied
 * ids, so a seam column is never in the default set), and a host that names it
 * in `visibleColumnIds` without supplying a renderer gets it dropped. Both
 * arms are pinned in `sessions-list-surface-v2-seam-columns.test.tsx`. A real
 * Sessions host does exactly this: `synced-sessions-table.tsx` passes
 * `visibleColumns` alongside `renderIssues`.
 *
 * `getSessionHref` returns `null` for `ses-2` on purpose: a host that cannot
 * resolve a route for one row renders that name as plain text rather than a
 * styled link to nowhere (FEA-4051).
 */
export const HostSeams: Story = {
  args: {
    rows: ROWS,
    usage: USAGE,
    pageSize: 4,
    getSessionHref: (row) =>
      row.id === "ses-2" ? null : `/sessions/${row.id}`,
    renderProjects: (row) => (
      <MonoIdCell label="Owning project" value={`proj-${row.id}`} />
    ),
    renderIssues: (row) => (
      <MonoIdCell label="Linked issue" value={`ISS-${row.id}`} />
    ),
    columnOrder: [...SESSIONS_DATA_COLUMN_ORDER],
    onColumnOrderChange: () => undefined,
    controlledView: {
      value: {
        sortBy: null,
        sortDir: "asc",
        grouping: EMPTY_TABLE_GROUPING,
        facets: DEFAULT_SESSION_FACET_FILTERS,
        dateRange: DEFAULT_DATE_RANGE,
        // The canonical default set PLUS the two seam ids, rather than a
        // hand-listed set: this stays the documented first screen if the
        // default columns change, and only the seam half is story-specific.
        visibleColumnIds: new Set([
          ...SESSIONS_DEFAULT_VISIBLE_COLUMN_IDS,
          ...SESSIONS_SEAM_REQUIRED_COLUMN_IDS,
        ]),
        page: 0,
        scopeUserId: null,
      },
      onChange: () => undefined,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // The navigable row, and the one the host had no route for.
    await expect(
      canvas.getByRole("link", { name: "agent/refactor-auth-guard" })
    ).toBeVisible();
    // BOTH seam-required columns, admitted because this host fills them AND
    // names them. Asserting only one would leave the other free to regress —
    // they are admitted by the same filter but by two different renderers.
    await expect(
      canvasElement.querySelector('[data-column-id="issues"]')
    ).not.toBeNull();
    await expect(
      canvasElement.querySelector('[data-column-id="projects"]')
    ).not.toBeNull();
    // Reorder is wired, so the data headers are drag surfaces.
    await expect(
      canvasElement.querySelector(
        '[role="columnheader"][data-column-id="repo"]'
      )
    ).toHaveAttribute("draggable", "true");
  },
};

/**
 * ISS-7865 — the SERVER-DRIVEN mount: a host that owns the query hands over one
 * page plus the server's total, and groups it.
 *
 * This is the state that changes what a group header may say. `items` is one
 * page of a larger set, so a count beside the label would read as the
 * population — `GroupSectionHeader` documents its `count` as optional for
 * exactly this caller, and `showGroupCounts={false}` is how the surface takes
 * that option. The paginator stays, because a grouped page is still a page.
 */
export const ServerDrivenGrouped: Story = {
  args: {
    rows: ROWS,
    usage: USAGE,
    pageSize: 2,
    controlledView: {
      onChange: () => undefined,
      totalRows: 25,
      value: {
        sortBy: null,
        sortDir: "asc",
        grouping: GROUPED_BY_STATUS,
        facets: DEFAULT_SESSION_FACET_FILTERS,
        dateRange: DEFAULT_DATE_RANGE,
        visibleColumnIds: new Set(SESSIONS_DEFAULT_VISIBLE_COLUMN_IDS),
        page: 0,
        scopeUserId: null,
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // A group header renders, and states NO count — the page is not the
    // population, so a bare number beside the label would be a lie.
    const header = await canvas.findByRole("button", {
      name: ACTIVE_GROUP_HEADER,
    });
    await expect(header).toBeVisible();
    await expect(header).not.toHaveTextContent(ANY_DIGIT);

    // The paginator stays: this page is 2 of 13 rows the host matched, and it is
    // the only control that reaches the other twelve pages.
    await expect(canvas.getByLabelText(NEXT_PAGE_LABEL)).toBeVisible();
  },
};

/**
 * ISS-8037 — the cross-surface `?userId=` OWNER SCOPE, arriving from another
 * surface's link.
 *
 * It narrows the list exactly as a facet does, so the chip row names it exactly
 * as it names a facet: one "Owner: …" chip, in the Owner facet's own label
 * vocabulary, with the same remove affordance. Before this the scope reached
 * this surface through nothing at all, and a scope that excluded every row left
 * the list claiming the org had no sessions.
 *
 * Uncontrolled on purpose: the chip and "Clear all" are live here, so the
 * removal path is the thing you can actually try.
 */
export const OwnerScope: Story = {
  args: {
    initialScopeUserId: "u-pascoe",
    pageSize: 4,
    resolveOwnerName: (userId: string) =>
      userId === "u-pascoe" ? "Pascoe Birchall" : undefined,
    rows: ROWS,
    usage: USAGE,
  },
};

/**
 * ISS-8037 — the state the ticket was actually about: a scope that matches
 * nothing.
 *
 * Before the scope was an axis, this screen said "No sessions yet" — a
 * confident claim that the org is empty, over an org with plenty, with no
 * control on the page that would widen it again. It now reads as the filtered
 * empty it is, and "Clear filters" drops the scope along with everything else.
 */
export const OwnerScopeMatchesNothing: Story = {
  args: {
    initialScopeUserId: "u-nobody",
    resolveOwnerName: (userId: string) =>
      userId === "u-nobody" ? "Dana Reyes" : undefined,
    rows: ROWS,
    usage: USAGE,
  },
};

/**
 * ISS-8217: a row on this file's live anchor rather than on the fixtures'
 * fixed one.
 *
 * `startedAtMs` has to be re-anchored here and not only alongside the
 * `lastActivityAtMs` overrides above: the window measures a row by the instant
 * it STARTED, and `createSessionTableRowFixture` dates that from
 * `SESSION_FIXTURE_NOW_MS`. Left at the factory default every row is months
 * old and the whole file renders empty tables.
 *
 * Two hours is the factory's own offset, so the `startedLabel` it also supplies
 * ("2h ago") keeps stating something true.
 */
function createStoryRow(overrides: Partial<SessionTableRow>): SessionTableRow {
  return createSessionTableRowFixture({
    startedAtMs: STORY_NOW_MS - 2 * HOUR_MS,
    ...overrides,
  });
}

/**
 * ISS-8966 — the host-owned free-text SEARCH term, arriving from the shell's
 * own search box.
 *
 * The same treatment the owner scope gets, for the same reason: it narrows the
 * list exactly as a facet does, so the chip row names it as one — "Search: …",
 * in the shared `FilterChip`, with the same remove affordance — and the Filter
 * popover counts it. Uncontrolled on purpose, so the chip's X and "Clear all"
 * are both live here.
 */
export const SearchTerm: Story = {
  args: {
    initialSearch: "refactor",
    pageSize: 4,
    rows: ROWS,
    usage: USAGE,
  },
};

/**
 * ISS-8966 — the state the ticket was actually about: a search that matches
 * nothing.
 *
 * Before the term was an axis, this screen said "No sessions yet" — a confident
 * claim that the account is empty, over an account with plenty, and no control
 * on the page that would widen it again. It now reads as the filtered empty it
 * is, and "Clear filters" drops the term along with everything else.
 */
export const SearchMatchesNothing: Story = {
  args: {
    initialSearch: "zzz-no-such-session",
    rows: ROWS,
    usage: USAGE,
  },
};

/**
 * The DATA rows of a rendered grid, excluding chrome.
 *
 * ISS-10245 made `navigableHeaderCells` unconditional, so `GridTableV2`'s chrome
 * header row carries `data-grid-row-id` alongside the real rows — as `rows[0]`
 * it has no data cells to click, and in a count it reads as one row too many.
 */
function dataGridRows(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("[data-grid-row-id]")].filter(
    (row) => !isGridChromeRowId(row.dataset.gridRowId ?? "")
  );
}

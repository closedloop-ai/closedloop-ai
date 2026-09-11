import {
  createFullyPopulatedSessionsUsageFixture,
  createSessionSummaryDeltasFixture,
  mixedAgentSessionListFixtures,
} from "@repo/app/agents/components/sessions/session-list-fixtures";
import { SessionsEmptyState } from "@repo/app/agents/components/sessions/sessions-empty-state";
import { SessionsRecoveryAction } from "@repo/app/agents/components/sessions/sessions-recovery-action";
import { SessionsSummaryCards } from "@repo/app/agents/components/sessions/sessions-summary-cards";
import { SessionsToolbar } from "@repo/app/agents/components/sessions/sessions-toolbar";
import { SyncedSessionsTable } from "@repo/app/agents/components/sessions/synced-sessions-table";
import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import { SessionGroupBy } from "@repo/app/agents/lib/session-grouping";
import {
  SessionSortDir,
  SessionSortKey,
} from "@repo/app/agents/lib/session-sort-group";
import { sessionsRangeReadout } from "@repo/app/agents/lib/sessions-range-readout";
import { SESSIONS_DEFAULT_VISIBLE_COLUMN_IDS } from "@repo/app/agents/lib/sessions-table-columns";
import type { DateRange } from "@repo/app/shared/lib/format-utils";
import { DATE_RANGES } from "@repo/app/shared/lib/format-utils";
import { PRIMARY_NAV_DESTINATIONS } from "@repo/app/shared/lib/primary-nav-destinations";
import { Button } from "@repo/design-system/components/ui/button";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { TablePaginationFooter } from "@repo/design-system/components/ui/table-pagination-footer";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import { AppScreenShell } from "./app-shell";

/**
 * The Sessions listing surface.
 *
 * This is the first surface assembled from the REAL composites rather than a
 * mockup of them: `SessionsToolbar`, `SessionsSummaryCards`, `SessionsTable`
 * and `SessionsEmptyState` are the same components
 * `apps/app/(authenticated)/[orgSlug]/sessions/page.tsx` mounts, in the same
 * arrangement, over the shared shell. Nothing here re-implements a part.
 *
 * That is the point of the Surfaces level. A screen built out of hand-written
 * lookalikes can drift from the product without anything failing; a screen
 * built out of the shipped composites cannot, because a change to a composite
 * lands here on the next render.
 *
 * The one thing this cannot borrow is the page's data layer. The real page is
 * a client component wired to `useAgentSessions` / `useAgentSessionUsage`, so
 * the states those queries produce are reproduced here as an explicit
 * `listState` control instead of being faked with a network mock.
 */

const NAV_PATHS = PRIMARY_NAV_DESTINATIONS.map(
  (destination) => destination.path
);

// The page's never-saved default, NOT every toggleable column. `pr`, `merge`,
// `started` and `updated` are hidden until someone turns them on, so showing
// them here would put a wider table in front of a reviewer than the product
// opens with.
const VISIBLE_COLUMNS = new Set(SESSIONS_DEFAULT_VISIBLE_COLUMN_IDS);

/**
 * The shared mixed-state fixture, five rows across different cloud sync states.
 * Shared rather than hand-built here, per `packages/app/agents/AGENTS.md`, so
 * this surface and the table's own stories cannot drift onto different data.
 */
const ROWS = mixedAgentSessionListFixtures;

/**
 * The five states the real page can be in, named for what the reader sees
 * rather than for the query flag that produces it.
 */
const LIST_STATES = [
  "populated",
  "loading",
  "no-matching-filters",
  "no-agent-connected",
  "unavailable",
] as const;
type ListState = (typeof LIST_STATES)[number];

const SUMMARY_STATES = ["settled", "loading", "error"] as const;
type SummaryState = (typeof SUMMARY_STATES)[number];

type SessionsSurfaceProps = {
  /** Org-relative path the sidebar should mark as current. */
  activePath?: string;
  /** How many fixture rows the table renders. */
  sessionCount?: number;
  /** Total matching sessions the footer reports, which is not the page size. */
  total?: number;
  /** The toolbar's time window. Drives the list AND the summary in production. */
  dateRange?: DateRange;
  /** The filter/view toolbar above the scroll area. */
  showToolbar?: boolean;
  /** The summary card strip above the table. */
  showSummaryCards?: boolean;
  /** The pagination footer pinned below the scroll area. */
  showPaginationFooter?: boolean;
  /** Which of the list's five states to render. */
  listState?: ListState;
  /** The summary strip settles independently of the list, so it has its own. */
  summaryState?: SummaryState;
  /** The View menu's Group by dimension. */
  groupBy?: SessionGroupBy;
  /** Period-over-period deltas on the summary cards. */
  showDeltas?: boolean;
};

const SessionsSurface = ({
  activePath = "/sessions",
  dateRange = "7d",
  groupBy = SessionGroupBy.None,
  listState = "populated",
  sessionCount = ROWS.length,
  showDeltas = true,
  showPaginationFooter = true,
  showSummaryCards = true,
  showToolbar = true,
  summaryState = "settled",
  total = 431,
}: SessionsSurfaceProps) => {
  const rows = ROWS.slice(0, sessionCount);

  // Mirrors the page's `tableContent` branch order: pending first, then the
  // three empty readings, then the table.
  // `SyncedSessionsTable`, with the props the web shell
  // (`apps/app/components/agent-sessions/sessions-table.tsx`) injects. That
  // shell is thin on purpose: it supplies href construction, the page's
  // sort/column state, and the fact that the page owns the scroll container,
  // then delegates every row-level decision here. Mounting the presentational
  // `SessionsTable` underneath it instead would silently drop the row-state
  // chips and the linked-entity columns the product renders.
  let listContent = (
    <SyncedSessionsTable
      getIssueHref={(issue) => `#/issues/${issue.id}`}
      getSessionHref={(item) => `#/sessions/${item.id}`}
      groupBy={groupBy}
      hostScroll
      items={rows}
      onColumnOrderChange={fn()}
      onSort={fn()}
      showLinkedEntityColumns
      sortBy={SessionSortKey.LastActivity}
      sortDir={SessionSortDir.Desc}
      visibleColumns={VISIBLE_COLUMNS}
    />
  );
  if (listState === "loading") {
    listContent = <Skeleton className="h-[320px] w-full" />;
  } else if (listState === "no-matching-filters") {
    listContent = (
      <SessionsEmptyState
        onClearFilters={fn()}
        signals={{ hasActiveFilters: true, isUnavailable: false }}
      />
    );
  } else if (listState === "no-agent-connected") {
    listContent = (
      <SessionsEmptyState
        hasConnectedAgent={false}
        onboardingAction={<Button size="sm">Connect a compute target</Button>}
        signals={{ hasActiveFilters: false, isUnavailable: false }}
      />
    );
  } else if (listState === "unavailable") {
    listContent = (
      <SessionsEmptyState
        errorRecoveryAction={
          <SessionsRecoveryAction
            href="/closedloop/sessions"
            onClearFilters={fn()}
          />
        }
        signals={{ hasActiveFilters: false, isUnavailable: true }}
      />
    );
  }

  const rowsOnPage = listState === "populated" ? rows.length : 0;
  const pageSize = 25;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <AppScreenShell activePath={activePath} breadcrumbs={["Sessions"]}>
      <div className="flex min-h-0 flex-1 flex-col">
        {showToolbar ? (
          <div className="border-b px-4 py-3">
            <SessionsToolbar
              dateRange={dateRange}
              filters={DEFAULT_SESSION_FACET_FILTERS}
              groupBy={groupBy}
              includeLinkedEntityColumns
              onClearFilters={fn()}
              onDateRangeChange={fn()}
              onFiltersChange={fn()}
              onGroupByChange={fn()}
              onResetView={fn()}
              onToggleColumn={fn()}
              visibleColumns={VISIBLE_COLUMNS}
            />
          </div>
        ) : null}

        {/* Cards and table share one scroll container so they scroll together,
            exactly as the page arranges them. The toolbar above stays pinned. */}
        <div className="min-h-0 flex-1 overflow-auto">
          {showSummaryCards ? (
            <div className="sticky left-0 flex flex-col gap-4 px-4 pt-3 pb-4">
              <SessionsSummaryCards
                deltas={
                  showDeltas ? createSessionSummaryDeltasFixture() : undefined
                }
                isError={summaryState === "error"}
                isLoading={summaryState === "loading"}
                usage={
                  summaryState === "settled"
                    ? createFullyPopulatedSessionsUsageFixture()
                    : undefined
                }
                wrapBelow
              />
            </div>
          ) : null}

          <div>{listContent}</div>
        </div>

        {showPaginationFooter && rowsOnPage > 0 ? (
          <TablePaginationFooter
            className="sm:px-6"
            onPageChange={fn()}
            onPageSizeChange={fn()}
            page={0}
            pageSize={pageSize}
            readout={sessionsRangeReadout({
              pageIndex: 0,
              pageSize,
              rowsOnPage,
              total,
            })}
            totalPages={totalPages}
          />
        ) : null}
      </div>
    </AppScreenShell>
  );
};

/**
 * The main sessions listing page for browsing or filtering every session
 * across an organization, rather than Session Detail which shows just one in
 * full.
 */
const meta = {
  title: "Surfaces/Sessions",
  component: SessionsSurface,
  tags: ["autodocs"],
  argTypes: {
    activePath: {
      options: NAV_PATHS,
      control: { type: "select" },
      description: "Which sidebar destination renders as current.",
      table: { category: "Shell" },
    },
    sessionCount: {
      control: { type: "number", min: 0, max: ROWS.length, step: 1 },
      description:
        "Rows the table renders, up to the shared fixture's five mixed-sync-state sessions.",
      table: { category: "Content" },
    },
    total: {
      control: { type: "number", min: 0, step: 1 },
      description:
        "Total matching sessions the footer reports. Not the page size, so the readout can say 1-5 of 431.",
      table: { category: "Content" },
    },
    dateRange: {
      options: DATE_RANGES,
      control: { type: "radio" },
      description:
        "The toolbar's time window. In production it scopes the list AND the summary.",
      table: { category: "Content" },
    },
    showToolbar: {
      control: "boolean",
      description: "The filter and view toolbar above the scroll area.",
      table: { category: "Composition" },
    },
    showSummaryCards: {
      control: "boolean",
      description: "The summary card strip above the table.",
      table: { category: "Composition" },
    },
    showPaginationFooter: {
      control: "boolean",
      description:
        "The footer below the scroll area. Never renders with no rows, matching the page.",
      table: { category: "Composition" },
    },
    showDeltas: {
      control: "boolean",
      description:
        "Period-over-period movement on the cards. Its presence is the surface declaring it compares at all.",
      table: { category: "Composition" },
    },
    listState: {
      options: LIST_STATES,
      control: { type: "select" },
      description:
        "The five readings the list can produce: rows, pending, filtered away, never connected, and could not load.",
      table: { category: "State" },
    },
    summaryState: {
      options: SUMMARY_STATES,
      control: { type: "radio" },
      description:
        "The summary strip settles independently of the list, so the two can disagree on screen.",
      table: { category: "State" },
    },
    groupBy: {
      options: Object.values(SessionGroupBy),
      control: { type: "radio" },
      description:
        "The View menu's Group by dimension. The banded column drops out of every row.",
      table: { category: "State" },
    },
  },
  args: {
    activePath: "/sessions",
    dateRange: "7d",
    groupBy: SessionGroupBy.None,
    listState: "populated",
    sessionCount: ROWS.length,
    showDeltas: true,
    showPaginationFooter: true,
    showSummaryCards: true,
    showToolbar: true,
    summaryState: "settled",
    total: 431,
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SessionsSurface>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** The list read is still pending. The summary strip settles first in
 * production, so the cards carry values while the table is still a skeleton. */
export const Loading: Story = {
  args: { listState: "loading", showPaginationFooter: false },
};

/** Filters narrowed the list to nothing. The only action offered is the one
 * that gets the reader back to a populated list. */
export const NoMatchingFilters: Story = {
  name: "No matching filters",
  args: { listState: "no-matching-filters" },
};

/** A first-run org that has never connected a compute target, so the empty
 * state is onboarding rather than a shrug. */
export const NoAgentConnected: Story = {
  name: "No agent connected",
  args: { listState: "no-agent-connected", summaryState: "error" },
};

/** The read failed. This is the state that used to render "No sessions found",
 * which claimed an empty org when the truth was an unavailable one. */
export const Unavailable: Story = {
  args: { listState: "unavailable", summaryState: "error" },
};

/** Grouped by status. The banded column drops out of every row, so the table
 * is narrower than the ungrouped reading. */
export const GroupedByStatus: Story = {
  name: "Grouped by status",
  args: { groupBy: SessionGroupBy.Status },
};

/** The table alone. Worth seeing, because it is what a narrow viewport and a
 * reader who has collapsed everything both end up with. */
export const TableOnly: Story = {
  name: "Table only",
  args: { showSummaryCards: false, showToolbar: false },
};

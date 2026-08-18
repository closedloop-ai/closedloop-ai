"use client";

import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { FilterPopover } from "@repo/design-system/components/ui/filter-popover";
import { TableViewMenu } from "@repo/design-system/components/ui/table-view-menu";
import type { ReactNode } from "react";
import { DateRangeFilter } from "../../../shared/components/date-range-filter";
import { useFeatureFlagEnabled } from "../../../shared/feature-flags/use-feature-flag-enabled";
import { NOOP_TABLE_FILTERS_CONTROLLER } from "../../../shared/lib/facet-filter";
import {
  GRID_TABLE_V2_FEATURE_FLAG_KEY,
  SESSIONS_CHANGE_PR_FILTERS_FEATURE_FLAG_KEY,
} from "../../../shared/lib/feature-flags";
import type { DateRange } from "../../../shared/lib/format-utils";
import { useSessionOwnerNameResolver } from "../../hooks/use-session-owner-name-resolver";
import { useSessionProjectNameResolver } from "../../hooks/use-session-project-name-resolver";
import {
  type SessionColumnId,
  sessionsToggleableColumns,
} from "../../hooks/use-sessions-view-state";
import {
  type SessionFacetFilters,
  type SessionFilterFacetOptions,
  sessionFilterFacetGroups,
} from "../../lib/session-filter-adapter";
import {
  SessionGroupBy as GroupBy,
  SESSION_GROUP_BY_LABELS,
  SESSION_GROUP_COLUMN_ID,
  type SessionGroupBy,
} from "../../lib/session-grouping";
import { SESSIONS_SEAM_REQUIRED_COLUMN_IDS } from "../../lib/sessions-table-columns";
import { SessionsActiveFiltersBar } from "./sessions-active-filters-bar";

export type SessionsToolbarProps = {
  filters: SessionFacetFilters;
  onFiltersChange: (next: SessionFacetFilters) => void;
  /** First-class time window — drives the list query AND the summary metrics. */
  dateRange: DateRange;
  onDateRangeChange: (range: DateRange) => void;
  /** Usage summary feeds the Repository facet options (full corpus). */
  usage?: AgentSessionUsageSummary;
  visibleColumns: Set<string>;
  onToggleColumn: (id: SessionColumnId) => void;
  /**
   * FEA-4021: restore every column to visible AND to its natural order. Wired to
   * the view state's `resetColumns`. Anything the table persists on the user's
   * behalf (hidden columns, a dragged column order) needs a one-click way back.
   */
  onResetView?: () => void;
  /**
   * Total "Clear all" for the active-filter chip row. When provided, the chip
   * row's Clear all delegates to it so one control resets EVERYTHING the host
   * counts as a filter — the facets AND the date window / search / selected-user
   * scope — matching the empty-state recovery action. When omitted, Clear all
   * resets only the facets.
   */
  onClearFilters?: () => void;
  /**
   * ISS-4728: an out-of-facet selected-user narrower the host owns (the web
   * Sessions page's `?userId=` deep link), surfaced in the chip row as an Owner
   * chip. Forwarded verbatim to {@link SessionsActiveFiltersBar}; a surface
   * without such a scope (desktop) simply omits both.
   */
  scopeUserId?: string | null;
  /**
   * Clears `scopeUserId`, receiving the facet filters to write in the SAME URL
   * write (the scoped user dropped from the Owner facet when he was also
   * selected there). See {@link SessionsActiveFiltersBar}.
   */
  onRemoveScopeUser?: (nextFilters: SessionFacetFilters) => void;
  /**
   * ISS-5315: the View menu's "Group by" dimension and its setter. Both must be
   * supplied for the section to render — a surface that cannot band its rows
   * omits them and the menu is unchanged.
   */
  groupBy?: SessionGroupBy;
  onGroupByChange?: (next: SessionGroupBy) => void;
  /**
   * ISS-5355: offer the Project facet. Web-only — the desktop local producer
   * cannot resolve cloud projects, so it omits the prop and the dimension does
   * not exist there at all (no facet, no chip, no filter) rather than showing a
   * permanently empty facet or a chip for a filter that was never applied.
   */
  includeProjectFilter?: boolean;
  /**
   * FEA-4209 / FEA-4210: this surface renders the linked-entity columns
   * (`Owning project`, `Linked issues`), so their View-menu entries belong in this
   * menu. Opt-in for the same reason `includeProjectFilter` is: both fields
   * behind those columns are cloud-only, so a surface fed by the desktop local
   * producer neither renders the columns nor should offer a switch for them —
   * an entry over a column that does not exist is a dead switch.
   */
  includeLinkedEntityColumns?: boolean;
  /** Extra actions render after the built-in controls. */
  trailing?: ReactNode;
};

/**
 * Sessions toolbar — a left-aligned time-window + "Filter" + "View" cluster,
 * shared by the web `/sessions` page and the desktop Sessions view. The time
 * window (`DateRangeFilter`) is first-class so it stays visible; "Filter" is the
 * generic `FilterPopover` (Status/Repository facets); "View" is the generic
 * `TableViewMenu` (Show/Hide Columns). Sorting is driven by clickable column
 * headers in the table.
 *
 * ISS-5975: there is no Refresh control here any more, on either surface. The
 * list keeps itself current instead — ISS-5976 restored refetch-on-focus (and
 * on reconnect) for the web client, and the desktop shell already drove its own
 * freshness from a live change bridge plus a background list poll — so a manual
 * re-read has nothing left to do that returning to the window does not.
 *
 * Beneath that cluster the `SessionsActiveFiltersBar` (ISS-4605) renders one
 * removable chip per active facet selection plus a clear-all, so a filtered
 * cohort names its active filters instead of reading as a broken column. It
 * derives from the SAME facet-set config passed to the popover, so the two never
 * drift; it renders nothing when no facet is active.
 */
export function SessionsToolbar({
  filters,
  onFiltersChange,
  dateRange,
  onDateRangeChange,
  usage,
  visibleColumns,
  onToggleColumn,
  onResetView,
  onClearFilters,
  scopeUserId,
  onRemoveScopeUser,
  groupBy,
  onGroupByChange,
  includeProjectFilter,
  includeLinkedEntityColumns,
  trailing,
}: SessionsToolbarProps) {
  const changePrFiltersEnabled = useFeatureFlagEnabled(
    SESSIONS_CHANGE_PR_FILTERS_FEATURE_FLAG_KEY
  );
  // FEA-4209 / FEA-4210: the same shared `Grid Parity` key `SessionsTable` reads
  // to decide whether to render the columns, ANDed with this surface's opt-in —
  // so the entry and the track appear and disappear together, and a surface
  // without the data never grows a switch for a column it does not render.
  const gridTableV2Enabled = useFeatureFlagEnabled(
    GRID_TABLE_V2_FEATURE_FLAG_KEY
  );
  // ISS-5770 review: the two halves are handed over SEPARATELY, in the same
  // shape `SessionsTable` gives `resolveRenderedSessionColumnIds` — the flag
  // answers "does this BUILD have the gate", the seam ids answer "does this
  // MOUNT hold the data". ANDing them into one boolean here is what forced the
  // menu helper to re-decide gatedness from a hardcoded column pair; the seam
  // set is read from the declaration too, so a third seam-required column joins
  // both surfaces at once.
  const enabledGates = {
    [GRID_TABLE_V2_FEATURE_FLAG_KEY]: Boolean(gridTableV2Enabled),
  };
  const hostSuppliedColumnIds =
    includeLinkedEntityColumns === true
      ? [...SESSIONS_SEAM_REQUIRED_COLUMN_IDS]
      : [];
  // ISS-4974: the SAME resolver the chip row uses, so the Owner popover row and
  // the Owner chip below it can never label one user two different ways. Gated
  // internally on both its flag and an actually-unresolved id being on screen.
  const resolveOwnerName = useSessionOwnerNameResolver({
    scopeUserId,
    selectedUserIds: filters.userIds,
    usage,
  });
  // ISS-5355: the same arrangement for Project — one resolver behind the popover
  // row and the chip, gated on the facet existing here at all and on a selected
  // project the window cannot name actually being on screen.
  const resolveProjectName = useSessionProjectNameResolver({
    enabled: includeProjectFilter === true,
    selectedProjectIds: filters.projectIds,
    usage,
  });
  // The `sessions-change-pr-filters` flag gates only the Filter POPOVER's
  // Changes/Pull request facets (their roll-out). The active-filter chip row
  // deliberately does NOT inherit this gate: it always surfaces every active
  // facet — including a `changes=`/`pr=` selection arriving from a shared URL
  // while the flag is off — so no filter narrows the list without a chip to name
  // and remove it. See `SessionsActiveFiltersBar`.
  // ISS-5315: the Group-by section renders only when the host wired BOTH the
  // value and the setter, so the menu never shows a control that cannot move.
  const groupByOptions =
    groupBy !== undefined && onGroupByChange
      ? Object.values(GroupBy).map((value) => ({
          label: SESSION_GROUP_BY_LABELS[value],
          value,
        }))
      : undefined;
  // #4480: the banded column is not on screen — the band header states its value
  // — so it is not listed as a show/hide toggle either. Listing it left a
  // checkbox that read "shown" over a table with no such column, and unchecking
  // it changed nothing until Group by went back to None. The Group-by control
  // directly above owns that column while banding is active.
  const groupedColumnId = groupBy
    ? SESSION_GROUP_COLUMN_ID[groupBy]
    : undefined;
  // Both remaining gates compose onto ONE list, and the order matters only in
  // that both must apply: FEA-4209 / FEA-4210 decide whether the linked-entity
  // entries are offered at all (the flag + this surface's opt-in), #4480 decides
  // whether the currently-banded column is (the grouping). Deriving them
  // separately is what produced two `toggleableColumns` in this scope when the
  // tickets met. ISS-5666 retired the `sessions-row-qualifiers-column` gate, so
  // `Signals` is offered unconditionally like every other optional column.
  const toggleableColumns = sessionsToggleableColumns({
    enabledGates,
    hostSuppliedColumnIds,
  }).filter((column) => column.id !== groupedColumnId);
  const facetOptions: SessionFilterFacetOptions = {
    includeChangePrFilters: changePrFiltersEnabled,
    includeProjectFilter,
    resolveOwnerName,
    resolveProjectName,
  };
  return (
    <div className="flex flex-col gap-2">
      {/* ISS-5975: one wrapping run of controls. This used to be two groups
          split by `justify-between`, purely so Refresh could hold the right
          edge on line one; with that control retired there is no second group
          to separate from, so the split (and the outer `flex-wrap` valve it
          needed) went with it. `min-w-min` stays as the run's wrap floor —
          without it the group shrinks past its content and the time-window
          pills collapse under the controls beside them at narrow widths. */}
      <div className="flex min-w-min flex-wrap items-center gap-2">
        <DateRangeFilter onChange={onDateRangeChange} value={dateRange} />

        <FilterPopover
          controller={NOOP_TABLE_FILTERS_CONTROLLER}
          viewModel={{
            teamMembers: [],
            statusOptions: [],
            priorityOptions: [],
            hideQuickToggles: true,
            facetGroups: sessionFilterFacetGroups(
              filters,
              onFiltersChange,
              usage,
              facetOptions
            ),
          }}
        />

        <TableViewMenu
          align="start"
          columns={toggleableColumns.map((column) => ({
            id: column.id,
            label: column.label,
            visible: visibleColumns.has(column.id),
          }))}
          groupByOptions={groupByOptions}
          groupByValue={groupByOptions ? groupBy : undefined}
          onChangeGroupBy={
            onGroupByChange
              ? (value) => onGroupByChange(value as SessionGroupBy)
              : undefined
          }
          onResetView={onResetView}
          onToggleColumn={(id) => onToggleColumn(id as SessionColumnId)}
        />

        {/* Two independent removals land on this one row, so it is worth saying
            what is NOT here. ISS-6005 scope 4: the read-source ("Cloud") pill
            that used to sit between the View menu and `trailing` is a STRICT
            DROP at operator direction ("no one asked for it") — the pill and
            its three props only; the ISS-5714 cutover-decision machinery is
            untouched, and the other ReadSourceBadge mounts (desktop dashboard
            header, Branches toolbar) are out of that ticket's scope. ISS-5975
            (#4825) separately removed the Refresh button and its `onRefresh` /
            `isRefreshing` props from the row's tail. Neither removal implies
            the other; both are gone. */}
        {trailing}
      </div>

      <SessionsActiveFiltersBar
        filters={filters}
        includeProjectFilter={includeProjectFilter}
        onClearAll={onClearFilters}
        onFiltersChange={onFiltersChange}
        onRemoveScopeUser={onRemoveScopeUser}
        scopeUserId={scopeUserId}
        usage={usage}
      />
    </div>
  );
}

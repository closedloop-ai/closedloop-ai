"use client";

import type {
  AgentSessionListItem,
  SessionLinkedArtifact,
} from "@repo/api/src/types/agent-session";
import { SessionsTable } from "@repo/app/agents/components/sessions/sessions-table";
import { useCoarseNow } from "@repo/app/shared/hooks/use-coarse-now";
import {
  GridEmptyValue,
  type GridTableMode,
} from "@repo/design-system/components/ui/grid-table";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { Link } from "@repo/navigation/link";
import { FolderIcon, TicketIcon } from "lucide-react";
import { type CSSProperties, type ReactNode, useMemo } from "react";
import { SESSION_DURATION_TICK_MS } from "../../lib/session-duration";
import {
  hideSessionGroupedColumn,
  SessionGroupBy,
} from "../../lib/session-grouping";
import {
  resolveSessionIssueChips,
  resolveSessionProjectChips,
  SESSION_LINKED_ISSUES_OVERFLOW_TEST_ID,
  SESSION_LINKED_PROJECTS_OVERFLOW_TEST_ID,
  type SessionLinkedEntityChip,
} from "../../lib/session-linked-entity-chips";
import {
  isSyncStateFoldActive,
  toSessionTableRowWithSyncFold,
} from "../../lib/session-status-fold";
import { SessionLinkedChipsCell } from "./session-linked-chips-cell";

/**
 * Props for the shared synced agent-session table. Route-owned wrappers keep
 * href building and optional monitoring columns outside `@repo/app`.
 */
export type SyncedSessionsTableProps = {
  items: AgentSessionListItem[];
  emptyState?: ReactNode;
  getSessionHref: (item: AgentSessionListItem) => string;
  extraColumnLabel?: string;
  renderExtraColumn?: (item: AgentSessionListItem) => ReactNode;
  /** When provided, only these data-column ids render (autonomy always shows). */
  visibleColumns?: Set<string>;
  /** Column-header sorting — wire all three to enable clickable sort headers. */
  sortBy?: string | null;
  sortDir?: SortDirection;
  onSort?: (column: string, direction: SortDirection) => void;
  /**
   * FEA-4021: persisted data-column order (ids) + change handler for drag/keyboard
   * reorder. Forwarded straight to the shared `SessionsTable`; absent → static
   * headers.
   */
  columnOrder?: readonly string[];
  onColumnOrderChange?: (nextOrder: string[]) => void;
  /**
   * When true the table renders bare — without its own card-surfaced
   * horizontal-scroll wrapper — so a host that owns a bounded scroll container
   * (e.g. the desktop Sessions page's fixed-footer layout) is the single scroll
   * context. That lets the sticky column header pin and the horizontal scrollbar
   * sit at the bottom of the host's region. Defaults to the wrapped, card-hosted
   * layout used by the dashboard/telemetry surfaces.
   */
  hostScroll?: boolean;
  /**
   * ISS-5315: the View menu's "Group by" dimension. Bands the rows ON THIS PAGE
   * — see `session-grouping` for why a band never carries a count.
   */
  groupBy?: SessionGroupBy;
  /**
   * FEA-3865 layout mode, forwarded to the presentational table. Callers rarely
   * set it; it exists so a test can pin a single layout instead of depending on
   * an unmeasured container.
   *
   * ISS-5282: threaded through here because the web `/sessions` shell now routes
   * to this adapter rather than composing its own table, and that shell's tests
   * pin `expanded` to assert against the grid path rather than the card
   * fallback.
   */
  mode?: GridTableMode;
  /**
   * FEA-4209 / FEA-4210: opt in to the linked-entity columns (`Projects`,
   * `Linked issues`). Still gated by `grid-table-v2` on top of this — the flag
   * decides whether the feature ships, this decides whether THIS host has the
   * data to ship it.
   *
   * Off by default because both fields the columns read (`item.project`,
   * `item.linkedArtifacts`) are projected by the CLOUD list only, so a host fed
   * by the desktop LOCAL producer would render two tracks of em dashes.
   *
   * "Cloud list", not "web surface" (wongk review): the gate is the DATA SOURCE,
   * and the desktop has both. Its cloud mode reads the same HTTP list the web
   * app does (`createHttpAgentSessionsDataSource`) and its rows carry both
   * fields, so the desktop Sessions view opts in per MODE — see
   * `useDesktopLinkedEntityColumns`. An earlier revision of this comment said
   * only "the desktop local producer emits neither", which read as "desktop
   * never" and is why the desktop seam went unwired: with the Labs toggle on, a
   * cloud-mode desktop got no columns and no View-menu entries on data it
   * already had in hand.
   */
  showLinkedEntityColumns?: boolean;
  /**
   * Route builder for a linked-issue chip. The surface owns it because the
   * destination is surface-shaped: web joins its org slug onto
   * `getDocumentTypeRoute`, while the desktop renderer would hand the OS browser
   * an absolute web URL (`buildArtifactWebHref`).
   *
   * Absent, or returning `null` for a slug-less artifact, renders an INERT chip
   * that still names the issue — never a dead link.
   */
  getIssueHref?: (artifact: SessionLinkedArtifact) => string | null;
};

/**
 * Maps synced agent-session list rows onto the shared presentational
 * `SessionsTable`. The repository column shows the resolved Git remote
 * (`repositoryFullName`), or an honest "Unknown" when no remote has resolved
 * yet — derived only from Git-remote evidence, never from the working/worktree
 * directory's folder name and never a fabricated repo label, so the column
 * agrees with the Repository filter and matches the session-detail Properties
 * panel (see `resolveSessionRepoLabel`). The leading name is a navigation-port
 * `Link` (a real anchor both surfaces intercept) and an "Awaiting input" badge
 * is injected via the table's `renderName` seam.
 */
export function SyncedSessionsTable({
  items,
  emptyState,
  getSessionHref,
  extraColumnLabel,
  renderExtraColumn,
  visibleColumns,
  sortBy,
  sortDir,
  onSort,
  columnOrder,
  onColumnOrderChange,
  hostScroll,
  groupBy = SessionGroupBy.None,
  mode,
  showLinkedEntityColumns = false,
  getIssueHref,
}: SyncedSessionsTableProps) {
  const itemById = useMemo(
    () => new Map(items.map((item) => [item.id, item])),
    [items]
  );
  // ISS-4848: the fold needs the Status column to be on screen to have anywhere
  // to render. See `isSyncStateFoldActive`.
  // #4480 (wongk): judged against the columns the grid will ACTUALLY render, so
  // banding by Status — which removes the Status column — stands the fold down
  // and hands the sync signal back to the Name cell, instead of folding it into
  // a cell that is no longer on screen and dropping it from the grid entirely.
  const foldActive = isSyncStateFoldActive(
    hideSessionGroupedColumn(visibleColumns, groupBy)
  );
  // ISS-4998 / ISS-5131: the staleness fold AND the Duration cell read the
  // CURRENT time, so this mapping is not a pure function of `items` — but
  // TanStack's structural sharing keeps `items` referentially stable across
  // refetches that return an unchanged page. Without a time signal in the deps a
  // row that crossed the staleness cutoff kept claiming "Active", and a running
  // session's Duration froze at the last real data change under a caption
  // reading "Start to now". Passing the clock IN keeps the mapping a pure
  // function of its arguments.
  //
  // The timer is UNCONDITIONAL (#4409 review). It once ran only while
  // `sessions-honest-unknown-states` was on, which froze the Duration cell at
  // its own mount instant for everyone with that flag off — the same session
  // then reading one number here and a different one on its detail page, neither
  // of them `now`. Both consumers now ship ungated. See
  // `SESSION_DURATION_TICK_MS`.
  const now = useCoarseNow(SESSION_DURATION_TICK_MS);
  const rows = useMemo(
    () =>
      items.map((item) =>
        toSessionTableRowWithSyncFold(item, foldActive, {
          now,
        })
      ),
    [items, foldActive, now]
  );

  // FEA-4209 / FEA-4210: the linked-entity chips for EVERY row, derived once per
  // render for the same structural reason the qualifiers are — the seam has to
  // be able to hand the grid the shared `GridEmptyValue` sentinel for a row with
  // nothing to link, and that means knowing whether a row has chips BEFORE
  // rendering its cell. Keyed by row id and read from `itemById`, because the
  // derivations need the raw record, not the display-ready row.
  const linkedChipsByRowId = useMemo(() => {
    const byRowId = new Map<
      string,
      Readonly<{
        projects: readonly SessionLinkedEntityChip[];
        issues: readonly SessionLinkedEntityChip[];
      }>
    >();
    if (!showLinkedEntityColumns) {
      return byRowId;
    }
    for (const row of rows) {
      const item = itemById.get(row.id);
      if (!item) {
        continue;
      }
      byRowId.set(row.id, {
        projects: resolveSessionProjectChips(item),
        issues: resolveSessionIssueChips(item, getIssueHref),
      });
    }
    return byRowId;
  }, [rows, itemById, showLinkedEntityColumns, getIssueHref]);

  if (rows.length === 0 && emptyState) {
    return emptyState;
  }

  const table = (
    <SessionsTable
      columnOrder={columnOrder}
      extraColumnLabel={extraColumnLabel}
      groupBy={groupBy}
      items={rows}
      mode={mode}
      onColumnOrderChange={onColumnOrderChange}
      onSort={onSort}
      renderExtraColumn={
        renderExtraColumn
          ? (row) => {
              const item = itemById.get(row.id);
              return item ? renderExtraColumn(item) : null;
            }
          : undefined
      }
      renderIssues={
        showLinkedEntityColumns
          ? (row, { uncapped }) => {
              const chips = linkedChipsByRowId.get(row.id)?.issues;
              // The shared empty sentinel returned DIRECTLY, not a component
              // that renders one: the card fallback drops a field whose cell is
              // empty and decides that with `isEmptyCellValue`, which matches a
              // `GridEmptyValue` ELEMENT. Handing it a wrapper would leave every
              // card with a dead field on exactly the rows with nothing in it.
              if (!chips || chips.length === 0) {
                return <GridEmptyValue />;
              }
              return (
                <SessionLinkedChipsCell
                  chips={chips}
                  icon={<TicketIcon aria-hidden />}
                  overflowNoun="issue"
                  testId={SESSION_LINKED_ISSUES_OVERFLOW_TEST_ID}
                  uncapped={uncapped}
                />
              );
            }
          : undefined
      }
      renderName={(row, className) => {
        const item = itemById.get(row.id);
        return (
          <span className="flex min-w-0 items-center gap-2">
            {/* FEA-4051: surface-agnostic `@repo/navigation` `Link` (renders a
                real anchor) drives the active adapter on both web (Next router)
                and the desktop renderer (hash-store adapter). A raw `<a href>`
                was a dead click on desktop, and its `href="#"` no-item fallback
                was a fully-styled link that navigated nowhere — render the plain
                name instead when the row can't be matched to an item. Mirrors
                FEA-4018's agents-table fix. */}
            {item ? (
              <Link
                className={`${className} min-w-0`}
                href={getSessionHref(item)}
              >
                {row.name}
              </Link>
            ) : (
              <span className={`${className} min-w-0`}>{row.name}</span>
            )}
            {/* ISS-5666 / ISS-5770: nothing else goes in this cell. ISS-5666
                cleared it and ISS-5770 removed the `Signals` column the chips
                had moved to; neither is a licence to put one back here. The
                row-state facts survive elsewhere — `Awaiting input` is projected
                into Status as `Waiting`, an uploading row's sync state folds
                into the Status pill, and the transcript verdicts sit on Session
                Detail's Properties panel. */}
          </span>
        );
      }}
      renderProjects={
        showLinkedEntityColumns
          ? (row, { uncapped }) => {
              const chips = linkedChipsByRowId.get(row.id)?.projects;
              if (!chips || chips.length === 0) {
                return <GridEmptyValue />;
              }
              return (
                <SessionLinkedChipsCell
                  chips={chips}
                  icon={<FolderIcon aria-hidden />}
                  overflowNoun="project"
                  testId={SESSION_LINKED_PROJECTS_OVERFLOW_TEST_ID}
                  uncapped={uncapped}
                />
              );
            }
          : undefined
      }
      sortBy={sortBy}
      sortDir={sortDir}
      visibleColumns={visibleColumns}
    />
  );

  // Host owns a bounded scroll container — render bare so it's the single scroll
  // context (sticky header pins, horizontal scrollbar sits at the host's bottom).
  if (hostScroll) {
    return table;
  }

  // Default: hosted inside a `bg-card` Card (dashboard / telemetry). Point the
  // shared grid-table surface at the card token so the sticky header + rows match
  // the card instead of the page background, and own the horizontal scroll.
  return (
    <div
      className="scrollbar-overlay overflow-x-auto"
      style={{ "--grid-table-surface": "var(--card)" } as CSSProperties}
    >
      {table}
    </div>
  );
}

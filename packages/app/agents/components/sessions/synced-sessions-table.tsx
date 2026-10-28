"use client";

import type {
  AgentSessionListItem,
  SessionLinkedArtifact,
} from "@repo/api/src/types/agent-session";
import { SessionsTable } from "@repo/app/agents/components/sessions/session-detail-table";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useCoarseNow } from "@repo/app/shared/hooks/use-coarse-now";
import { SESSIONS_COMMENT_COUNT_TAG_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  CountCell,
  isCountCellEmpty,
} from "@repo/design-system/components/ui/count-cell";
import type { GridTableMode } from "@repo/design-system/components/ui/grid-table";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import type { CountNoun } from "@repo/design-system/lib/count-noun";
import { Link } from "@repo/navigation/link";
import { MessageSquareIcon } from "lucide-react";
import { type CSSProperties, type ReactNode, useMemo } from "react";
import { SESSION_DURATION_TICK_MS } from "../../lib/session-duration";
import {
  hideSessionGroupedColumn,
  SessionGroupBy,
} from "../../lib/session-grouping";
import {
  isSyncStateFoldActive,
  toSessionTableRowWithSyncFold,
} from "../../lib/session-status-fold";
import { renderSessionPriorityCell } from "./session-priority-cell";
import { renderSessionTagsCell } from "./session-tags-cell";
import { useSessionLinkedEntitySeams } from "./use-session-linked-entity-seams";

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
   * ISS-5315: the toolbar's "Group by" dimension (the Group menu since
   * ISS-10361 retired the View menu). Bands the rows ON THIS PAGE
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
   * "Cloud list", not "web surface" (whitlockk review): the gate is the DATA SOURCE,
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
   * ISS-8712: mount the org-tag picker in the `Tags` column.
   *
   * Opt-in per HOST rather than derived here, and deliberately NOT folded into
   * `showLinkedEntityColumns` above: that opt-in answers "does this mount hold
   * the cloud linked-entity fields", this one answers "may this mount host a
   * write control". The column is additionally gated by its own PostHog flag
   * inside `SessionsTable`, so opting in here does not make it appear.
   */
  showTagsColumn?: boolean;
  /**
   * ISS-10332: mount the priority editor in the `Priority` column.
   *
   * Opt-in per HOST like `showTagsColumn`, and for the same two reasons stated
   * there plus one more: only a source that projects `priority` can fill the
   * column, so the host that knows its source (the web list always; the desktop
   * shell per mode) is the one to say. The cell itself reads the write through
   * the active data source (`useUpdateSessionPriority`).
   */
  showPriorityColumn?: boolean;
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
  showTagsColumn = false,
  showPriorityColumn = false,
  getIssueHref,
}: SyncedSessionsTableProps) {
  const itemById = useMemo(
    () => new Map(items.map((item) => [item.id, item])),
    [items]
  );
  // ISS-4848: the fold needs the Status column to be on screen to have anywhere
  // to render. See `isSyncStateFoldActive`.
  // #4480 (whitlockk): judged against the columns the grid will ACTUALLY render, so
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
  // FEA-4204: read once for the whole table rather than per row. The OPTIONAL
  // hook because this component mounts without a flag provider in Storybook and
  // in the shared tests, where an adapter-requiring hook would throw; absent, it
  // resolves closed, which is the state this gate defaults to anyway.
  const commentTagEnabled = useFeatureFlagEnabledOptional(
    SESSIONS_COMMENT_COUNT_TAG_FEATURE_FLAG_KEY
  );
  const rows = useMemo(
    () =>
      items.map((item) =>
        toSessionTableRowWithSyncFold(item, foldActive, {
          now,
        })
      ),
    [items, foldActive, now]
  );

  // FEA-4209 / FEA-4210. ISS-7052 Part A moved the derivation into a shared hook
  // when the v2 surface became a second host for the same two columns — the chip
  // logic has one owner so the two hosts cannot render a linked entity
  // differently.
  const { renderIssues, renderProjects } = useSessionLinkedEntitySeams({
    getIssueHref,
    itemById,
    rows,
    showLinkedEntityColumns,
  });

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
      renderIssues={renderIssues}
      renderName={(row, className) => {
        const item = itemById.get(row.id);
        // `gap-1.5` matches the wrapper this render lands inside
        // (`SessionsTable`'s own lead span) and `SessionCard`'s header, so name →
        // comment tag → provenance chip reads as one rhythm on the agent-detail
        // tab where all three render. It was `gap-2` while this span had a single
        // child and the gap never painted.
        return (
          <span className="flex min-w-0 items-center gap-1.5">
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
            {/* ISS-5666 / ISS-5770 cleared this cell to the name and removed the
                `Signals` column the chips had moved to, and that still holds for
                every ROW-STATE fact — `Awaiting input` is projected into Status
                as `Waiting`, an uploading row's sync state folds into the Status
                pill, and the transcript verdicts sit on Session Detail's
                Properties panel. None of them comes back here.

                FEA-4204 / PRD-557 is the one deliberate exception, and it IS a
                reversal — written down here rather than left for the next reader
                to find as drift. Two things separate it from the chips: a comment
                count restates nothing else on the row (no column carries it), and
                it is the only way to find a discussed session from the list at
                all. Gated closed on both surfaces
                (`sessions-comment-count-tag`), and rendered ONLY for a session
                that HAS comments, so a quiet row is byte-for-byte what it is
                today. The PR carries the open question of whether this belongs
                in the lead cell or in a column of its own; it is not restated
                here, because a copy in source goes stale the day it is answered.
                If the answer is "column", this is the seam to remove. */}
            {commentTagEnabled ? renderCommentTag(item) : null}
          </span>
        );
      }}
      renderPriority={
        showPriorityColumn ? renderSessionPriorityCell : undefined
      }
      renderProjects={renderProjects}
      renderTags={showTagsColumn ? renderSessionTagsCell : undefined}
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

/**
 * FEA-4204: the Sessions lead cell's comment-count tag, or nothing.
 *
 * Nothing is the answer for THREE different rows and the distinction matters
 * upstream even though it collapses here. A row with a computed `0` has no
 * comments; a row whose producer never counted omits `commentCount` entirely
 * (the desktop LOCAL read has no batched per-session count, and its trace-comment
 * store is only hydrated for sessions someone has already opened, so any number
 * it produced would be a partial one); and a row carrying a negative, fractional
 * or non-finite value is corrupt. None of the three may render "0" beside a
 * speech bubble — that is a confident claim about a count nobody has, which is
 * why the gate is `isCountCellEmpty` and not `> 0`.
 *
 * `isCountCellEmpty` rather than a hand-written predicate so the gate and the
 * cell read the SAME `resolveCountCellState`: a bound the design system tightens
 * later cannot leave this call site rendering a value the cell would refuse.
 * `loading` is `false` because the rows are already here — a row we are still
 * fetching has no lead cell to hang a skeleton off.
 *
 * `CountCell` owns the accessible name ("3 comments" as an `sr-only` sibling of
 * the `aria-hidden` digits), so the count is never a bare numeral next to an
 * icon, and never encoded in the icon alone.
 *
 * The icon size is passed here only because `CountCell` — unlike `Chip` and
 * `Badge`, which carry `[&>svg]:size-*` per size — sizes nothing, so an unsized
 * lucide glyph would render at its 24px default. `size-3.5` is the DS pairing for
 * the cell's `text-sm`. When the primitive learns to size its own glyph, this
 * `className` comes off and the call matches the bare `<TicketIcon aria-hidden />`
 * a few lines up.
 */
function renderCommentTag(item: AgentSessionListItem | undefined): ReactNode {
  const count = item?.commentCount;
  if (isCountCellEmpty(count, false)) {
    return null;
  }
  return (
    <CountCell
      count={count}
      icon={<MessageSquareIcon aria-hidden className="size-3.5 shrink-0" />}
      noun={SESSION_COMMENTS_NOUN}
    />
  );
}

/** Plural forms for the lead cell's comment tag (FEA-4204). */
const SESSION_COMMENTS_NOUN: CountNoun = { one: "comment", other: "comments" };

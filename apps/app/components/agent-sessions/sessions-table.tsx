"use client";

import type {
  AgentSessionListItem,
  SessionLinkedArtifact,
} from "@repo/api/src/types/agent-session";
import { SyncedSessionsTable } from "@repo/app/agents/components/sessions/synced-sessions-table";
import { SessionGroupBy } from "@repo/app/agents/lib/session-grouping";
import type { GridTableMode } from "@repo/design-system/components/ui/grid-table";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";

/**
 * Web shell for the primary `/sessions` listing.
 *
 * ISS-5282: this is now a SHELL, not a second adapter. It injects the only
 * genuine platform differences the web route owns — href construction, the
 * page's sort/column state, and the fact that the page hosts its own scroll
 * container — and delegates every row-level decision to the shared
 * `SyncedSessionsTable` in `@repo/app`.
 *
 * That collapse is the point. Web and desktop used to render the listing from
 * two adapters that each read their own flags, ran their own copy of the row
 * mapper, and hand-built their own name cell — and they had already drifted
 * once, exactly the way two copies always do: the shared adapter (desktop
 * Sessions, the dashboard and telemetry embeds) grew all four row-state chips
 * while this one kept only the freshness badge, so "Awaiting input", the most
 * actionable row state the product has, appeared nowhere on the Sessions list
 * most users actually open (ISS-4953, #4284). Repairing that by copying the
 * chips across left the divergence mechanism fully intact — the next state added
 * on one side would have gone missing on the other. There is now one
 * composition, so a row state added there appears on BOTH surfaces with no edit
 * here at all.
 *
 * ISS-5315 (#4480) is the same story told once more, and the reason the collapse
 * is worth keeping through this merge: that ticket had to teach the sync fold to
 * stand down when banding removes the Status column, and it taught BOTH adapters
 * separately. Routed through the shared adapter, that rule — like the grouping
 * itself — is inherited here rather than restated.
 *
 * `hostScroll` is inherited rather than dropped: it renders the table bare, which
 * is what this route always did — the page owns the scroll container, so the
 * shared adapter must not add its own card-hosted one.
 *
 * There is no per-row overflow (⋯) menu to pass through. ISS-5315 (#4480)
 * removed the kebab from this list at the call sites, and ISS-6239 deleted what
 * was left — `SessionRowActionsMenu` and the `showRowActions` prop — because no
 * host enabled it and the surviving `true` default meant a new host got the
 * deleted menu back by omission. Its two clipboard shortcuts (copy branch name,
 * copy session ID) were the only things it held and both values are on the
 * session's own detail page, so the removal buys back a track without taking
 * away a capability that lived only there. The removal is still pinned by
 * accessible name — see
 * `apps/app/__tests__/components/agent-sessions-table-row-actions-removed.test.tsx`.
 *
 * One behavior deliberately CHANGES: the shared adapter passes each row's
 * DISPLAYED status into the chip derivation (#4324), which this adapter never
 * did. That is the corrected reading — judging the sync fold on the raw stored
 * status can suppress a real verdict on a row whose badge says "Stale" — so
 * inheriting it fixes a latent list/detail contradiction rather than causing one.
 */
export function SessionsTable({
  items,
  getSessionHref,
  visibleColumns,
  sortBy,
  sortDir,
  onSort,
  columnOrder,
  onColumnOrderChange,
  groupBy = SessionGroupBy.None,
  mode,
  getIssueHref,
}: {
  items: AgentSessionListItem[];
  getSessionHref: (item: AgentSessionListItem) => string;
  /**
   * FEA-4210: route builder for a linked-issue chip. Supplied by the route page
   * (which holds the org slug) rather than resolved here, so this shell stays
   * free of a provider requirement its other mount sites would have to satisfy.
   * Absent → the `Linked issues` chips render inert rather than as dead links.
   */
  getIssueHref?: (artifact: SessionLinkedArtifact) => string | null;
  visibleColumns?: Set<string>;
  sortBy?: string | null;
  sortDir?: SortDirection;
  onSort?: (column: string, direction: SortDirection) => void;
  /** FEA-4021: persisted data-column order + reorder change handler. */
  columnOrder?: readonly string[];
  onColumnOrderChange?: (nextOrder: string[]) => void;
  /**
   * ISS-5315: the View menu's "Group by" dimension. Bands the rows ON THIS PAGE
   * — see `session-grouping` for why a band never carries a count. Forwarded to
   * the shared adapter, which is where the banding and the sync fold's
   * stand-down rule now both live.
   */
  groupBy?: SessionGroupBy;
  /**
   * FEA-3865 layout mode, forwarded to the shared table. Callers rarely set it;
   * it exists so a test can pin a single layout instead of depending on an
   * unmeasured container.
   */
  mode?: GridTableMode;
}) {
  return (
    <SyncedSessionsTable
      columnOrder={columnOrder}
      getIssueHref={getIssueHref}
      getSessionHref={getSessionHref}
      groupBy={groupBy}
      hostScroll
      items={items}
      mode={mode}
      onColumnOrderChange={onColumnOrderChange}
      onSort={onSort}
      // FEA-4209 / FEA-4210: the web list is fed by the CLOUD projection, which
      // is the only producer of `project` and `linkedArtifacts` — so this is the
      // surface that opts into the linked-entity columns. `grid-table-v2` still
      // gates them on top.
      showLinkedEntityColumns
      sortBy={sortBy}
      sortDir={sortDir}
      visibleColumns={visibleColumns}
    />
  );
}

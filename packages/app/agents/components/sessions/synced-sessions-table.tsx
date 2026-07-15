"use client";

import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import {
  SessionsTable,
  type SessionTableRow,
} from "@repo/app/agents/components/sessions/sessions-table";
import { ToneBadge } from "@repo/design-system/components/ui/primitives/status-badge";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { type CSSProperties, type ReactNode, useMemo } from "react";
import {
  agentSessionToSessionTableRow,
  resolveSessionRepoLabel,
} from "../../lib/session-table-row";
import { SessionRowActionsMenu } from "./session-row-actions-menu";

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
   * When true, each row gets an overflow (kebab) menu of session actions
   * (FEA-2507). Opt-in so glanceable dashboard/telemetry/insights mini-tables
   * that embed this table stay action-free; the primary Sessions list surfaces
   * enable it. Off by default.
   */
  showRowActions?: boolean;
  /**
   * When true the table renders bare — without its own card-surfaced
   * horizontal-scroll wrapper — so a host that owns a bounded scroll container
   * (e.g. the desktop Sessions page's fixed-footer layout) is the single scroll
   * context. That lets the sticky column header pin and the horizontal scrollbar
   * sit at the bottom of the host's region. Defaults to the wrapped, card-hosted
   * layout used by the dashboard/telemetry surfaces.
   */
  hostScroll?: boolean;
};

/**
 * Maps synced agent-session list rows onto the shared presentational
 * `SessionsTable`. The repository column shows the repo name (remote
 * `repositoryFullName`, else the working/worktree directory's folder name — see
 * `resolveSessionRepoLabel`), never a raw absolute path; the leading name is a
 * plain anchor (desktop uses hash routing) and an "Awaiting input" badge is
 * injected via the table's `renderName` seam.
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
  showRowActions,
  hostScroll,
}: SyncedSessionsTableProps) {
  const itemById = useMemo(
    () => new Map(items.map((item) => [item.id, item])),
    [items]
  );
  const rows = useMemo(() => items.map(toRow), [items]);

  if (rows.length === 0 && emptyState) {
    return emptyState;
  }

  const table = (
    <SessionsTable
      extraColumnLabel={extraColumnLabel}
      items={rows}
      onSort={onSort}
      renderExtraColumn={
        renderExtraColumn
          ? (row) => {
              const item = itemById.get(row.id);
              return item ? renderExtraColumn(item) : null;
            }
          : undefined
      }
      renderName={(row, className) => {
        const item = itemById.get(row.id);
        return (
          <span className="flex min-w-0 items-center gap-2">
            <a
              className={`${className} min-w-0`}
              href={item ? getSessionHref(item) : "#"}
            >
              {row.name}
            </a>
            {item?.awaitingInputSince ? (
              <ToneBadge
                className="shrink-0"
                label="Awaiting input"
                pulse
                tone="accent"
              />
            ) : null}
          </span>
        );
      }}
      renderRowActions={
        showRowActions
          ? (row) => {
              const item = itemById.get(row.id);
              return item ? <SessionRowActionsMenu item={item} /> : null;
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

function toRow(item: AgentSessionListItem): SessionTableRow {
  return agentSessionToSessionTableRow(item, resolveSessionRepoLabel(item));
}

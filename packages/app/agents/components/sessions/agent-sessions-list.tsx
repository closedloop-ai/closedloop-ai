"use client";

import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { Clock3Icon } from "lucide-react";
import type { ReactNode } from "react";
import { SyncedSessionsTable } from "./synced-sessions-table";

/**
 * Shared renderer for sessions-list query states. App routes own filters,
 * pagination, feature flags, and href shape; this component owns the portable
 * loading/empty/populated table body.
 */
export type AgentSessionsListContentProps = {
  items: AgentSessionListItem[];
  isLoading: boolean;
  getSessionHref: (item: AgentSessionListItem) => string;
  emptyState?: ReactNode;
  loadingClassName?: string;
  /** When provided, only these data-column ids render (autonomy always shows). */
  visibleColumns?: Set<string>;
  /** Column-header sorting — wire all three to enable clickable sort headers. */
  sortBy?: string | null;
  sortDir?: SortDirection;
  onSort?: (column: string, direction: SortDirection) => void;
  /** Render bare so the host owns a single bounded scroll container. */
  hostScroll?: boolean;
  /**
   * Per-row overflow (kebab) menu (FEA-2507). This is the primary Sessions
   * list body, so it defaults on; pass false to suppress the menu.
   */
  showRowActions?: boolean;
};

export function AgentSessionsListContent({
  items,
  isLoading,
  getSessionHref,
  emptyState,
  loadingClassName = "h-[320px] w-full",
  visibleColumns,
  sortBy,
  sortDir,
  onSort,
  hostScroll,
  showRowActions = true,
}: AgentSessionsListContentProps) {
  if (isLoading) {
    return <Skeleton className={loadingClassName} />;
  }

  if (items.length === 0) {
    return (
      emptyState ?? (
        <EmptyState
          className="py-12"
          description="No synced sessions match your current filters yet."
          icon={Clock3Icon}
          title="No sessions found"
        />
      )
    );
  }

  return (
    <SyncedSessionsTable
      getSessionHref={getSessionHref}
      hostScroll={hostScroll}
      items={items}
      onSort={onSort}
      showRowActions={showRowActions}
      sortBy={sortBy}
      sortDir={sortDir}
      visibleColumns={visibleColumns}
    />
  );
}

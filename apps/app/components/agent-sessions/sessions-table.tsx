"use client";

import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { SessionsTable as SharedSessionsTable } from "@repo/app/agents/components/sessions/sessions-table";
import {
  agentSessionToSessionTableRow,
  resolveSessionRepoLabel,
} from "@repo/app/agents/lib/session-table-row";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { Link } from "@repo/navigation/link";

/**
 * Web adapter over the shared `SessionsTable`: maps cloud `AgentSessionListItem`
 * records to the presentational `SessionTableRow` view-model (via the shared
 * mapper) and renders the session name as a Next `<Link>`. Sort + column-
 * visibility state is owned by the page and forwarded through.
 */
export function SessionsTable({
  items,
  getSessionHref,
  visibleColumns,
  sortBy,
  sortDir,
  onSort,
}: {
  items: AgentSessionListItem[];
  getSessionHref: (item: AgentSessionListItem) => string;
  visibleColumns?: Set<string>;
  sortBy?: string | null;
  sortDir?: SortDirection;
  onSort?: (column: string, direction: SortDirection) => void;
}) {
  const rows = items.map((item) =>
    agentSessionToSessionTableRow(item, resolveSessionRepoLabel(item))
  );
  const hrefById = new Map(
    items.map((item) => [item.id, getSessionHref(item)])
  );

  return (
    <SharedSessionsTable
      items={rows}
      onSort={onSort}
      renderName={(row, className) => (
        <Link className={className} href={hrefById.get(row.id) ?? "#"}>
          {row.name}
        </Link>
      )}
      sortBy={sortBy}
      sortDir={sortDir}
      visibleColumns={visibleColumns}
    />
  );
}
